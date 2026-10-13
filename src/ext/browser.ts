import { browser, type Browser } from 'wxt/browser';
import { mergeFrames } from '../core/snapshot';
import type { ActResult, BrowserPort, DownloadedFile, FrameSnapshot, PageSnapshot, TableData } from '../core/types';

type Reply<T> = { ok: true; value: T } | { ok: false; error: string };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const NO_AGENT = 'NO_AGENT';
/** 요소를 표시한 뒤 실제로 조작하기까지의 시간. 사용자가 어디를 누르는지 볼 수 있게 한다. */
const POINT_MS = 450;
const POINT_LABEL = { click: '클릭', type: '입력', select: '선택' } as const;

// 페이지 쪽(격리된 world)에서 실행된다. 예외를 값으로 바꿔 돌려준다.
async function invoke(method: string, args: unknown[]): Promise<Reply<unknown>> {
  try {
    const agent = (globalThis as any).__dogent;
    if (!agent) return { ok: false, error: 'NO_AGENT' };
    return { ok: true, value: await agent[method](...args) };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

const MAX_DOWNLOAD_BYTES = 30 * 1024 * 1024;

/** 응답의 Content-Disposition에 적힌 파일 이름 */
function dispositionName(header: string | null): string | undefined {
  const encoded = /filename\*\s*=\s*(?:UTF-8'[^']*')?([^;]+)/i.exec(header ?? '')?.[1];
  if (encoded) {
    try {
      return decodeURIComponent(encoded.trim().replace(/^"|"$/g, ''));
    } catch {
      // 잘못 인코딩된 이름은 무시하고 아래의 일반 형식을 본다.
    }
  }
  return /filename\s*=\s*"?([^";]+)"?/i.exec(header ?? '')?.[1].trim();
}

// 아래 둘은 페이지의 main world에서 실행된다. 바깥 변수를 쓸 수 없다.

/** 페이지가 URL.createObjectURL로 만드는 파일을 주소별로 잡아 두거나(on), 원래대로 되돌린다. */
function keepBlobs(on: boolean): void {
  const w = window as any;
  if (!on) {
    if (w.__dogentBlobs) URL.createObjectURL = w.__dogentBlobs.original;
    delete w.__dogentBlobs;
    return;
  }
  if (w.__dogentBlobs) return;
  const kept = new Map<string, Blob>();
  const original = URL.createObjectURL;
  URL.createObjectURL = function (obj: Blob | MediaSource) {
    const url = original.call(URL, obj);
    if (obj instanceof Blob) kept.set(url, obj);
    return url;
  };
  w.__dogentBlobs = { kept, original };
}

/** 잡아 둔 파일의 내용. 이 프레임이 만든 주소가 아니면 null. */
async function readBlob(url: string, maxBytes: number): Promise<{ base64: string } | { error: string } | null> {
  let blob: Blob | undefined = (window as any).__dogentBlobs?.kept.get(url);
  // 누르기 전에 미리 만들어 둔 주소는 잡지 못했으므로, 아직 지워지지 않았기를 기대하고 직접 읽는다.
  if (!blob && url.startsWith(`blob:${location.origin}/`)) {
    blob = await fetch(url).then((r) => r.blob()).catch(() => undefined);
  }
  if (!blob) return null;
  if (blob.size > maxBytes) return { error: `파일이 너무 큽니다 (${Math.round(blob.size / 1e6)}MB)` };
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => resolve({ base64: String(reader.result).split(',')[1] ?? '' });
    reader.onerror = () => resolve({ error: '화면이 만든 파일의 내용을 읽지 못했습니다' });
    reader.readAsDataURL(blob);
  });
}

/** 한 탭을 대상으로 하는 BrowserPort 구현. 사용자의 로그인 세션을 그대로 쓴다. */
export class ChromeBrowser implements BrowserPort {
  private refs = new Map<number, { frame: number; localRef: number }>();
  private active = false;

  constructor(private tabId: number) {}

  private async run<T>(method: string, args: unknown[], frameId?: number) {
    const target =
      frameId === undefined ? { tabId: this.tabId, allFrames: true } : { tabId: this.tabId, frameIds: [frameId] };
    const call = () => browser.scripting.executeScript({ target, func: invoke, args: [method, args] });
    let results = await call();
    // 페이지 에이전트가 아직 없는 프레임이 있을 때만 주입한다 (이미 있는 프레임은 그대로 두어 ref를 유지).
    if (results.some((r) => (r.result as Reply<T> | undefined)?.ok === false && (r.result as any).error === NO_AGENT)) {
      await browser.scripting.executeScript({ target, files: ['/page-agent.js'] });
      results = await call();
    }
    return results
      .filter((r) => r.result)
      .map((r) => ({ frameId: r.frameId, reply: r.result as Reply<T> }))
      .sort((a, b) => a.frameId - b.frameId);
  }

  private async waitLoaded(maxMs = 15000): Promise<void> {
    const deadline = Date.now() + maxMs;
    while (Date.now() < deadline) {
      const tab = await browser.tabs.get(this.tabId);
      if (tab.status === 'complete') return;
      await sleep(150);
    }
  }

  /** 동작 뒤 페이지 이동과 화면 갱신이 끝나기를 기다린다. */
  private async settle(): Promise<void> {
    await sleep(120);
    await this.waitLoaded();
    await this.run('settle', []).catch(() => {});
  }

  /** 곧 조작할 요소를 화면에 표시하고, 사용자가 볼 수 있게 잠깐 기다린다. */
  private async point(target: { frame: number; localRef: number }, label: string): Promise<void> {
    const [res] = await this.run<boolean>('point', [target.localRef, label], target.frame).catch(() => []);
    if (res?.reply.ok && res.reply.value) await sleep(POINT_MS);
  }

  async setActive(on: boolean): Promise<void> {
    this.active = on;
    await this.run('setActive', [on], 0).catch(() => {});
  }

  /** 사람의 조작 녹화를 켜거나 끈다. 새로 열린 화면에도 걸리도록 녹화 중에는 주기적으로 다시 부른다. */
  async record(on: boolean): Promise<void> {
    await this.run('record', [on]).catch(() => {});
  }

  /** 화면이 멈출 때까지 기다린 뒤 읽는다. 사람이 조작한 직후의 결과 화면을 볼 때 쓴다. */
  async settledSnapshot(): Promise<PageSnapshot> {
    await this.settle();
    return this.snapshot();
  }

  async snapshot(): Promise<PageSnapshot> {
    await this.waitLoaded();
    // 화면이 바뀌면(이동, 새로 고침) 표시가 사라지므로 볼 때마다 다시 켠다.
    if (this.active) await this.run('setActive', [true], 0).catch(() => {});
    try {
      const frames = (await this.run<FrameSnapshot>('snapshot', []))
        .filter((r): r is typeof r & { reply: { ok: true; value: FrameSnapshot } } => r.reply.ok)
        .filter((r) => r.frameId === 0 || r.reply.value.items.length > 0)
        .map((r) => ({ frame: r.frameId, snap: r.reply.value }));
      if (frames.length === 0) throw new Error('읽을 수 있는 프레임이 없습니다');
      const merged = mergeFrames(frames);
      this.refs = merged.refs;
      return merged.snapshot;
    } catch {
      // 권한이 없는 페이지(새 탭, 허용 목록 밖 사이트 등)는 주소만 알려준다.
      this.refs = new Map();
      const tab = await browser.tabs.get(this.tabId);
      return {
        url: tab.url ?? '',
        title: tab.title ?? '',
        hasPassword: false,
        items: [{ kind: 'text', text: '(이 페이지는 Dogent가 읽을 수 없습니다)' }],
      };
    }
  }

  async navigate(url: string): Promise<ActResult> {
    await browser.tabs.update(this.tabId, { url });
    await sleep(300);
    await this.settle();
    const tab = await browser.tabs.get(this.tabId);
    return { ok: true, message: `이동함: ${tab.url ?? url}` };
  }

  private async act(method: 'click' | 'type' | 'select', ref: number, extra: unknown[]): Promise<ActResult> {
    const target = this.refs.get(ref);
    if (!target) return { ok: false, message: `ref ${ref} 이(가) 현재 화면에 없습니다` };
    await this.point(target, POINT_LABEL[method]);
    const [res] = await this.run<ActResult>(method, [target.localRef, ...extra], target.frame);
    if (!res) return { ok: false, message: '프레임이 사라졌습니다' };
    if (!res.reply.ok) return { ok: false, message: res.reply.error };
    await this.settle();
    return res.reply.value;
  }

  click(ref: number) {
    return this.act('click', ref, []);
  }

  type(ref: number, text: string) {
    return this.act('type', ref, [text]);
  }

  select(ref: number, value: string) {
    return this.act('select', ref, [value]);
  }

  async fillTable(ref: number, columns: string[], rows: string[][], addRef?: number): Promise<ActResult> {
    const target = this.refs.get(ref);
    if (!target) return { ok: false, message: `ref ${ref} 이(가) 현재 화면에 없습니다` };
    const add = addRef === undefined ? undefined : this.refs.get(addRef);
    if (addRef !== undefined && (!add || add.frame !== target.frame)) {
      return { ok: false, message: '행 추가 버튼이 표와 같은 화면에 없습니다' };
    }
    await this.point(target, '표 입력');
    const [res] = await this.run<ActResult>('fillTable', [target.localRef, columns, rows, add?.localRef], target.frame);
    if (!res) return { ok: false, message: '프레임이 사라졌습니다' };
    if (!res.reply.ok) return { ok: false, message: res.reply.error };
    await this.settle();
    return res.reply.value;
  }

  /**
   * 내려받기 버튼을 누르고, 브라우저가 받기 시작한 파일의 내용을 읽어 온다.
   * 확장은 PC에 저장된 파일을 읽을 수 없으므로, 서버에서 오는 파일은 같은 주소를 사용자의 세션으로 한 번 더 받고
   * 페이지가 직접 만든 파일(blob:)은 만들어지는 순간의 내용을 페이지 안에서 잡아 둔다.
   */
  async download(ref: number, timeoutMs: number, allowed: (url: string) => boolean): Promise<DownloadedFile> {
    const target = this.refs.get(ref);
    if (!target) throw new Error(`ref ${ref} 이(가) 현재 화면에 없습니다`);
    await this.point(target, '내려받기');
    const main = (on: boolean) =>
      browser.scripting
        .executeScript({ target: { tabId: this.tabId, allFrames: true }, world: 'MAIN', func: keepBlobs, args: [on] })
        .catch(() => {});
    let onCreated!: (item: Browser.downloads.DownloadItem) => void;
    const created = new Promise<Browser.downloads.DownloadItem>((resolve) => {
      onCreated = resolve;
      browser.downloads.onCreated.addListener(onCreated);
    });
    await main(true);
    try {
      const [res] = await this.run<ActResult>('click', [target.localRef], target.frame);
      if (!res) throw new Error('프레임이 사라졌습니다');
      if (!res.reply.ok) throw new Error(res.reply.error);
      if (!res.reply.value.ok) throw new Error(res.reply.value.message);
      const item = await Promise.race([created, sleep(timeoutMs).then(() => null)]);
      if (!item) throw new Error(`버튼을 눌렀지만 ${timeoutMs / 1000}초 안에 내려받기가 시작되지 않았습니다`);
      const url = item.finalUrl || item.url;
      if (!allowed(url)) throw new Error(`내려받는 파일의 주소(${url.slice(0, 120)})가 허용 도메인 밖이라 읽지 않았습니다`);

      let data: ArrayBuffer;
      let named: string | undefined;
      if (url.startsWith('blob:')) {
        const results = await browser.scripting.executeScript({
          target: { tabId: this.tabId, allFrames: true },
          world: 'MAIN',
          func: readBlob,
          args: [url, MAX_DOWNLOAD_BYTES],
        });
        const hit = results.map((r) => r.result).find((r) => r);
        if (!hit) throw new Error('화면이 만든 파일의 내용을 읽지 못했습니다');
        if ('error' in hit) throw new Error(hit.error);
        data = Uint8Array.from(atob(hit.base64), (c) => c.charCodeAt(0)).buffer;
      } else {
        const response = await fetch(url, { credentials: 'include' }).catch(() => null);
        if (!response) throw new Error(`파일을 다시 받지 못했습니다 (${new URL(url).host}). dogent.config.ts의 sitePermissions에 있는 주소인지 확인하세요`);
        if (!response.ok) throw new Error(`파일을 다시 받지 못했습니다 (HTTP ${response.status})`);
        data = await response.arrayBuffer();
        named = dispositionName(response.headers.get('Content-Disposition'));
      }
      if (data.byteLength > MAX_DOWNLOAD_BYTES) throw new Error(`파일이 너무 큽니다 (${Math.round(data.byteLength / 1e6)}MB)`);
      return { filename: named ?? (await this.downloadName(item.id, url)), url, data };
    } finally {
      browser.downloads.onCreated.removeListener(onCreated);
      await main(false);
      await this.settle();
    }
  }

  /** 브라우저가 정한 파일 이름. 내려받기가 시작된 직후에는 비어 있을 수 있어 잠깐 기다린다. */
  private async downloadName(id: number, url: string): Promise<string> {
    for (let i = 0; i < 10; i++) {
      const [item] = await browser.downloads.search({ id });
      const name = item?.filename.split(/[\\/]/).pop();
      if (name) return name;
      await sleep(200);
    }
    return (/^https?:/.test(url) && decodeURIComponent(new URL(url).pathname.split('/').pop() ?? '')) || '내려받은 파일';
  }

  async waitFor(text: string, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const results = await this.run<boolean>('hasText', [text]).catch(() => []);
      if (results.some((r) => r.reply.ok && r.reply.value)) return true;
      if (Date.now() >= deadline) return false;
      await sleep(300);
    }
  }

  async extractTable(ref: number): Promise<TableData> {
    const target = this.refs.get(ref);
    if (!target) throw new Error(`ref ${ref} 이(가) 현재 화면에 없습니다`);
    await this.point(target, '표 읽기');
    const [res] = await this.run<TableData>('extractTable', [target.localRef], target.frame);
    if (!res) throw new Error('프레임이 사라졌습니다');
    if (!res.reply.ok) throw new Error(res.reply.error);
    return res.reply.value;
  }
}
