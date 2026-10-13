import { browser } from 'wxt/browser';
import { mergeFrames } from '../core/snapshot';
import type { ActResult, BrowserPort, FrameSnapshot, PageSnapshot, TableData } from '../core/types';

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
    await this.point(target, '표 추출');
    const [res] = await this.run<TableData>('extractTable', [target.localRef], target.frame);
    if (!res) throw new Error('프레임이 사라졌습니다');
    if (!res.reply.ok) throw new Error(res.reply.error);
    return res.reply.value;
  }
}
