import { copyFileSync, existsSync, mkdirSync, renameSync, unlinkSync } from 'node:fs';
import { promises as fs } from 'node:fs';
import { extname, join } from 'node:path';
import type { ToolHost } from '../../../src/core/browser-tools';
import type { SiteInspection } from '../../../src/core/inspect';
import { SUBMIT_PATTERN } from '../../../src/core/policy';
import { mergeFrames } from '../../../src/core/snapshot';
import type {
  ActResult,
  ApprovalRequest,
  BrowserPort,
  ConfirmPolicy,
  DownloadedFile,
  FrameInspection,
  FrameSnapshot,
  PageDialog,
  PageSnapshot,
  Screenshot,
  TableData,
  UploadPayload,
} from '../../../src/core/types';
import { SHOT_MAX_BASE64, fitSize } from '../../../src/core/upload';
import type { CdpConnection } from './cdp';

/**
 * 확장 없이 CDP로 브라우저를 다루는 ToolHost (브라우저 연결 방식 "직접 제어").
 * 확장의 ChromeBrowser(src/ext/browser.ts)와 같은 일을 한다: 페이지 에이전트를 프레임마다 넣어 화면을 읽고 조작하며,
 * 누른 결과로 열린 새 창·팝업을 따라가고, 알림·확인 창에 답하고, 내려받은 파일을 읽는다.
 * 사이트 규칙과 승인은 이 위의 BrowserTools가 지킨다.
 */

type Reply<T> = { ok: true; value: T } | { ok: false; error: string };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const NO_AGENT = 'NO_AGENT';
const WORLD = 'dogent';
const POINT_MS = 450;
const POINT_LABEL = { click: '클릭', type: '입력', select: '선택' } as const;
const RUN_TIMEOUT_MS = 30_000;
const NAV_START_MS = 400;
const DOWNLOAD_FINISH_MS = 180_000;
const MAX_DOWNLOAD_BYTES = 30 * 1024 * 1024;

// 페이지 쪽에서 실행된다 (격리된 world). 바깥 변수를 쓸 수 없다.
const INVOKE = `async function (method, args) {
  try {
    const agent = globalThis.__dogent;
    if (!agent) return { ok: false, error: 'NO_AGENT' };
    return { ok: true, value: await agent[method](...args) };
  } catch (e) {
    return { ok: false, error: (e && e.message) || String(e) };
  }
}`;

const isWeb = (url?: string) => !!url && /^https?:\/\//.test(url);
const isBlank = (url: string) => /^(chrome|edge|about:newtab|chrome-search)/.test(url);

function withTimeout<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
  return Promise.race([p, sleep(ms).then(() => Promise.reject(new Error(message)))]);
}

interface Tab {
  id: number;
  targetId: string;
  sessionId: string;
  url: string;
  title: string;
  attached: Promise<void>;
  markAttached: () => void;
  loading: boolean;
  /** 페이지 이동이 시작되면 부를 것들 */
  navListeners: Set<() => void>;
  /** CDP 프레임 번호 → ref에 쓰는 프레임 번호 (맨 위 프레임은 0) */
  frameNums: Map<string, number>;
  nextFrame: number;
  /** 세션 → (프레임 → Dogent world의 실행 맥락) */
  contexts: Map<string, Map<string, number>>;
  /** 다른 출처의 iframe(별도 프로세스)을 다루는 세션 */
  children: Set<string>;
}

interface DownloadRecord {
  guid: string;
  url: string;
  suggested: string;
  done: Promise<string>;
  resolve: (path: string) => void;
  reject: (e: Error) => void;
}

export interface DirectHostOptions {
  /** 조작할 사이트 규칙 */
  sites: string[];
  /** 저장·상신·올리기 직전에 사람에게 묻는다 */
  approve(request: ApprovalRequest): Promise<boolean>;
  /** 브라우저가 내려받는 동안 파일을 두는 폴더 */
  tempDir: string;
  /** 다 받은 파일을 옮겨 둘 폴더 (사람이 볼 수 있는 내려받기 폴더) */
  downloadsDir: string;
  /** 프레임마다 넣는 페이지 에이전트 스크립트 */
  agentSource: string;
}

export class DirectHost implements ToolHost {
  private tabsByTarget = new Map<string, Tab>();
  private tabsById = new Map<number, Tab>();
  private tabsBySession = new Map<string, Tab>();
  /** iframe 세션 → 그 iframe이 든 탭 */
  private childOwner = new Map<string, Tab>();
  private nextTab = 1;
  private ports = new Map<number, DirectPort>();
  private lastFocus: number | null = null;
  private downloads = new Map<string, DownloadRecord>();
  private downloadWaiters = new Set<(d: DownloadRecord) => void>();

  constructor(
    readonly cdp: CdpConnection,
    readonly opts: DirectHostOptions,
  ) {}

  async start(): Promise<void> {
    mkdirSync(this.opts.tempDir, { recursive: true });
    this.cdp.on((method, params, sessionId) => this.onEvent(method, params, sessionId));
    await this.cdp.send('Browser.setDownloadBehavior', { behavior: 'allowAndName', downloadPath: this.opts.tempDir, eventsEnabled: true });
    await this.cdp.send('Target.setDiscoverTargets', { discover: true });
    const { targetInfos } = await this.cdp.send('Target.getTargets');
    for (const t of targetInfos) if (t.type === 'page') this.addTab(t);
    await Promise.all([...this.tabsByTarget.values()].map((t) => withTimeout(t.attached, 10_000, '탭에 붙지 못했습니다').catch(() => {})));
  }

  // ---- 탭 기록 ----

  private addTab(info: { targetId: string; url: string; title: string; openerId?: string }): Tab {
    const have = this.tabsByTarget.get(info.targetId);
    if (have) return have;
    let markAttached!: () => void;
    const attached = new Promise<void>((r) => (markAttached = r));
    const tab: Tab = {
      id: this.nextTab++,
      targetId: info.targetId,
      sessionId: '',
      url: info.url,
      title: info.title,
      attached,
      markAttached,
      loading: false,
      navListeners: new Set(),
      frameNums: new Map([[info.targetId, 0]]),
      nextFrame: 1,
      contexts: new Map(),
      children: new Set(),
    };
    this.tabsByTarget.set(info.targetId, tab);
    this.tabsById.set(tab.id, tab);
    void this.cdp.send('Target.attachToTarget', { targetId: info.targetId, flatten: true }).catch(() => {});
    const opener = info.openerId ? this.tabsByTarget.get(info.openerId) : undefined;
    for (const p of new Set(this.ports.values())) p.onTabCreated(tab.id, opener?.id, info.url);
    return tab;
  }

  private async setupSession(sessionId: string): Promise<void> {
    const send = (m: string, p: Record<string, unknown> = {}) => this.cdp.send(m, p, sessionId).catch(() => {});
    await Promise.all([send('Page.enable'), send('Runtime.enable')]);
    // 다른 출처의 iframe도 따로 붙어 화면 읽기에 들어가게 한다.
    await send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
    await send('Runtime.runIfWaitingForDebugger');
  }

  private onEvent(method: string, params: any, sessionId?: string): void {
    switch (method) {
      case 'Target.targetCreated':
        if (params.targetInfo.type === 'page') this.addTab(params.targetInfo);
        return;
      case 'Target.targetInfoChanged': {
        const tab = this.tabsByTarget.get(params.targetInfo.targetId);
        if (tab) {
          tab.url = params.targetInfo.url;
          tab.title = params.targetInfo.title;
        }
        return;
      }
      case 'Target.targetDestroyed': {
        const tab = this.tabsByTarget.get(params.targetId);
        if (!tab) return;
        this.tabsByTarget.delete(tab.targetId);
        this.tabsById.delete(tab.id);
        this.tabsBySession.delete(tab.sessionId);
        return;
      }
      case 'Target.attachedToTarget': {
        const info = params.targetInfo;
        if (!sessionId && info.type === 'page') {
          const tab = this.tabsByTarget.get(info.targetId) ?? this.addTab(info);
          if (tab.sessionId) return;
          tab.sessionId = params.sessionId;
          this.tabsBySession.set(params.sessionId, tab);
          void this.setupSession(params.sessionId).finally(() => tab.markAttached());
          return;
        }
        const parent = sessionId ? this.tabsBySession.get(sessionId) ?? this.childOwner.get(sessionId) : undefined;
        if (parent && info.type === 'iframe') {
          parent.children.add(params.sessionId);
          this.childOwner.set(params.sessionId, parent);
          void this.setupSession(params.sessionId);
        } else if (sessionId) {
          // 워커 같은 다른 대상은 다루지 않는다. 멈춰 있으면 풀어 준다.
          void this.cdp.send('Runtime.runIfWaitingForDebugger', {}, params.sessionId).catch(() => {});
        }
        return;
      }
      case 'Target.detachedFromTarget': {
        const owner = this.childOwner.get(params.sessionId);
        if (owner) {
          owner.children.delete(params.sessionId);
          owner.contexts.delete(params.sessionId);
          this.childOwner.delete(params.sessionId);
        }
        return;
      }
      case 'Runtime.executionContextCreated': {
        const tab = this.tabOfSession(sessionId);
        const ctx = params.context;
        if (!tab || !sessionId || ctx.name !== WORLD || !ctx.auxData?.frameId) return;
        if (!tab.contexts.has(sessionId)) tab.contexts.set(sessionId, new Map());
        tab.contexts.get(sessionId)!.set(ctx.auxData.frameId, ctx.id);
        return;
      }
      case 'Runtime.executionContextDestroyed': {
        const tab = this.tabOfSession(sessionId);
        const map = sessionId ? tab?.contexts.get(sessionId) : undefined;
        if (map) for (const [f, id] of map) if (id === params.executionContextId) map.delete(f);
        return;
      }
      case 'Runtime.executionContextsCleared': {
        const tab = this.tabOfSession(sessionId);
        if (tab && sessionId) tab.contexts.delete(sessionId);
        return;
      }
      case 'Page.frameStartedLoading': {
        const tab = this.tabOfSession(sessionId);
        if (tab && params.frameId === tab.targetId) {
          tab.loading = true;
          for (const f of tab.navListeners) f();
        }
        return;
      }
      case 'Page.frameStoppedLoading': {
        const tab = this.tabOfSession(sessionId);
        if (tab && params.frameId === tab.targetId) tab.loading = false;
        return;
      }
      case 'Page.javascriptDialogOpening': {
        const tab = this.tabOfSession(sessionId);
        if (!tab || !sessionId) return;
        const port = [...new Set(this.ports.values())].find((p) => p.isActive && p.covers(tab.id));
        // Dogent가 일하는 중이 아니면 사람이 직접 답하도록 그대로 둔다.
        if (!port) return;
        const accept = port.answerDialog(params.type, params.message ?? '');
        void this.cdp.send('Page.handleJavaScriptDialog', { accept }, sessionId).catch(() => {});
        return;
      }
      case 'Browser.downloadWillBegin': {
        let resolve!: (p: string) => void;
        let reject!: (e: Error) => void;
        const done = new Promise<string>((res, rej) => {
          resolve = res;
          reject = rej;
        });
        done.catch(() => {});
        const rec: DownloadRecord = { guid: params.guid, url: params.url, suggested: params.suggestedFilename || '내려받은 파일', done, resolve, reject };
        this.downloads.set(rec.guid, rec);
        for (const w of this.downloadWaiters) w(rec);
        for (const p of new Set(this.ports.values())) p.onDownload(rec.suggested);
        return;
      }
      case 'Browser.downloadProgress': {
        const rec = this.downloads.get(params.guid);
        if (!rec) return;
        if (params.state === 'completed') {
          try {
            rec.resolve(this.keepDownload(rec));
          } catch (e) {
            rec.reject(e as Error);
          }
        } else if (params.state === 'canceled') {
          rec.reject(new Error('내려받기가 취소되었습니다'));
        }
        return;
      }
      default:
        return;
    }
  }

  private tabOfSession(sessionId?: string): Tab | undefined {
    if (!sessionId) return undefined;
    return this.tabsBySession.get(sessionId) ?? this.childOwner.get(sessionId);
  }

  /** 다 받은 파일을 내려받기 폴더로 옮긴다. 같은 이름이 있으면 (1), (2)를 붙인다. */
  private keepDownload(rec: DownloadRecord): string {
    const from = join(this.opts.tempDir, rec.guid);
    mkdirSync(this.opts.downloadsDir, { recursive: true });
    const safe = rec.suggested.replace(/[\\/:*?"<>|]/g, '_');
    const ext = extname(safe);
    const stem = safe.slice(0, safe.length - ext.length);
    let to = join(this.opts.downloadsDir, safe);
    for (let i = 1; existsSync(to); i++) to = join(this.opts.downloadsDir, `${stem} (${i})${ext}`);
    try {
      renameSync(from, to);
    } catch {
      copyFileSync(from, to);
      unlinkSync(from);
    }
    return to;
  }

  /** 다음에 시작되는 내려받기 하나를 기다린다. */
  nextDownload(): { promise: Promise<DownloadRecord>; cancel: () => void } {
    let w!: (d: DownloadRecord) => void;
    const promise = new Promise<DownloadRecord>((resolve) => {
      w = (d) => {
        this.downloadWaiters.delete(w);
        resolve(d);
      };
      this.downloadWaiters.add(w);
    });
    return { promise, cancel: () => this.downloadWaiters.delete(w) };
  }

  // ---- 탭 담당이 쓰는 것 ----

  tab(id: number): Tab {
    const t = this.tabsById.get(id);
    if (!t) throw new Error(`탭 [${id}]이 닫혔습니다`);
    return t;
  }

  exists(id: number): boolean {
    return this.tabsById.has(id);
  }

  send<T = any>(tab: Tab, method: string, params: Record<string, unknown> = {}, sessionId = tab.sessionId): Promise<T> {
    return this.cdp.send<T>(method, params, sessionId);
  }

  /** 탭의 모든 프레임과 그 프레임을 다루는 세션 (다른 출처의 iframe은 따로 붙은 세션) */
  async frames(tab: Tab): Promise<{ frame: number; frameId: string; session: string }[]> {
    await withTimeout(tab.attached, 10_000, '탭에 아직 붙지 못했습니다');
    const owner = new Map<string, string>();
    const walk = (tree: any, session: string) => {
      owner.set(tree.frame.id, session);
      for (const c of tree.childFrames ?? []) walk(c, session);
    };
    walk((await this.cdp.send('Page.getFrameTree', {}, tab.sessionId)).frameTree, tab.sessionId);
    for (const child of tab.children) {
      const r = await this.cdp.send('Page.getFrameTree', {}, child).catch(() => null);
      if (r) walk(r.frameTree, child);
    }
    return [...owner].map(([frameId, session]) => {
      let n = tab.frameNums.get(frameId);
      if (n === undefined) {
        n = tab.nextFrame++;
        tab.frameNums.set(frameId, n);
      }
      return { frame: n, frameId, session };
    });
  }

  /** 프레임의 Dogent world. 없으면 만든다 (페이지의 스크립트와 섞이지 않는 격리된 곳). */
  async context(tab: Tab, session: string, frameId: string): Promise<number> {
    const have = tab.contexts.get(session)?.get(frameId);
    if (have !== undefined) return have;
    const { executionContextId } = await this.cdp.send('Page.createIsolatedWorld', { frameId, worldName: WORLD }, session);
    if (!tab.contexts.has(session)) tab.contexts.set(session, new Map());
    tab.contexts.get(session)!.set(frameId, executionContextId);
    return executionContextId;
  }

  forgetContext(tab: Tab, session: string, frameId: string): void {
    tab.contexts.get(session)?.delete(frameId);
  }

  get agentSource(): string {
    return this.opts.agentSource;
  }

  // ---- ToolHost ----

  async tabs() {
    return [...this.tabsById.values()].filter((t) => isWeb(t.url)).map((t) => ({ id: t.id, url: t.url, title: t.title }));
  }

  async open(url: string): Promise<number> {
    // 빈 탭을 먼저 열어 붙은 뒤에 이동한다. 주소를 바로 주면 붙기 전에 이동이 시작돼 언제 끝났는지 놓칠 수 있다.
    const { targetId } = await this.cdp.send('Target.createTarget', { url: 'about:blank' });
    const end = Date.now() + 10_000;
    while (!this.tabsByTarget.has(targetId) && Date.now() < end) await sleep(50);
    const tab = this.tabsByTarget.get(targetId);
    if (!tab) throw new Error('새 탭을 열지 못했습니다');
    await withTimeout(tab.attached, 10_000, '새 탭에 붙지 못했습니다');
    const r = await this.port(tab.id).navigate(url);
    if (!r.ok) throw new Error(r.message);
    this.lastFocus = tab.id;
    return tab.id;
  }

  async focus(tabId: number): Promise<void> {
    const tab = this.tab(tabId);
    await this.cdp.send('Target.activateTarget', { targetId: tab.targetId }).catch(() => {});
    await this.send(tab, 'Page.bringToFront').catch(() => {});
    this.lastFocus = tabId;
  }

  port(tabId: number): DirectPort {
    const direct = this.ports.get(tabId);
    if (direct && direct.currentTab() === tabId) return direct;
    // 새 창을 따라간 담당이 있으면 그것을 쓴다 (ref와 바깥 창 기록을 잃지 않게)
    for (const p of new Set(this.ports.values())) {
      if (p.currentTab() === tabId) {
        this.ports.set(tabId, p);
        return p;
      }
    }
    const p = new DirectPort(this, tabId);
    this.ports.set(tabId, p);
    return p;
  }

  async sites(): Promise<string[]> {
    return this.opts.sites;
  }

  /** 조작할 사이트를 바꾼다. 브라우저를 다시 띄우지 않고 다음 호출부터 적용한다 (설정을 바꿨을 때) */
  setSites(sites: string[]): void {
    this.opts.sites = sites;
  }

  approve(request: ApprovalRequest): Promise<boolean> {
    return this.opts.approve(request);
  }

  /** 사람이 보고 있는 탭: 초점이 있는 탭, 없으면 창에 보이는 탭, 없으면 마지막으로 앞에 둔 탭 */
  async activeTab(): Promise<number | null> {
    const web = [...this.tabsById.values()].filter((t) => isWeb(t.url) && t.sessionId);
    const states = await Promise.all(
      web.map((t) =>
        withTimeout(this.send(t, 'Runtime.evaluate', { expression: '[document.visibilityState, document.hasFocus()]', returnByValue: true }), 800, '')
          .then((r: any) => ({ t, v: r.result?.value as [string, boolean] | undefined }))
          .catch(() => ({ t, v: undefined })),
      ),
    );
    const focused = states.find((s) => s.v?.[1]);
    if (focused) return focused.t.id;
    if (this.lastFocus !== null && web.some((t) => t.id === this.lastFocus)) return this.lastFocus;
    const visible = states.find((s) => s.v?.[0] === 'visible');
    return visible?.t.id ?? web[0]?.id ?? null;
  }
}

/** 한 탭(과 그 탭에서 열린 새 창)을 다루는 BrowserPort. 확장의 ChromeBrowser와 같은 방식으로 움직인다. */
export class DirectPort implements BrowserPort {
  private refs = new Map<number, { frame: number; localRef: number }>();
  private active = false;
  private openers: number[] = [];
  private opened: number | null = null;
  private clicking = false;
  private note = '';
  private started: string[] = [];
  private policy: ConfirmPolicy | null = null;
  private dialogLog: PageDialog[] = [];

  constructor(
    private host: DirectHost,
    private tabId: number,
  ) {}

  currentTab(): number {
    return this.tabId;
  }

  get isActive(): boolean {
    return this.active;
  }

  /** 이 담당이 다루는 탭이거나 그 바깥 창인지 */
  covers(tabId: number): boolean {
    return tabId === this.tabId || this.openers.includes(tabId) || tabId === this.opened;
  }

  onTabCreated(tabId: number, openerId: number | undefined, url: string): void {
    if (!this.active && !this.clicking) return;
    if (openerId === this.tabId || (this.clicking && openerId === undefined && !isBlank(url)) || (this.clicking && openerId !== undefined)) this.opened = tabId;
  }

  onDownload(name: string): void {
    if (this.clicking) this.started.push(name);
  }

  /** 뜬 알림·확인 창에 어떻게 답할지 정하고 적어 둔다 (확장의 dialogHook과 같은 규칙) */
  answerDialog(type: string, message: string): boolean {
    const p = this.policy;
    const accept =
      type === 'alert' || type === 'beforeunload' ? true : type === 'confirm' ? !!p && p.accept && !(p.unless && new RegExp(p.unless, 'i').test(message)) : false;
    this.dialogLog.push({ kind: type === 'prompt' ? 'prompt' : type === 'confirm' || type === 'beforeunload' ? 'confirm' : 'alert', message, accepted: accept });
    return accept;
  }

  private drainDialogs(): PageDialog[] | undefined {
    if (!this.active) return undefined;
    const d = this.dialogLog;
    this.dialogLog = [];
    return d;
  }

  private takeNote(): string {
    const n = this.note;
    this.note = '';
    return n;
  }

  private tab() {
    return this.host.tab(this.tabId);
  }

  private async follow(): Promise<string> {
    let moved = '';
    if (this.opened !== null) {
      const id = this.opened;
      this.opened = null;
      if (id !== this.tabId && this.host.exists(id)) {
        this.openers.push(this.tabId);
        this.tabId = id;
        await this.host.tab(id).attached;
        await this.waitLoaded();
        moved = ' 새 창이 열려 그 창으로 옮겼습니다';
      }
    }
    while (this.openers.length > 0 && !this.host.exists(this.tabId)) {
      this.tabId = this.openers.pop()!;
      moved = ' 창이 닫혀 원래 창으로 돌아왔습니다';
    }
    if (moved) {
      this.refs = new Map();
      if (this.active) await this.run('setActive', [true], 0).catch(() => {});
      if (!this.note.includes(moved.trim())) this.note += moved;
    }
    return moved;
  }

  private async callFrame(tab: Tab, f: { frameId: string; session: string }, method: string, args: unknown[]): Promise<Reply<unknown>> {
    for (let attempt = 0; ; attempt++) {
      try {
        const ctx = await this.host.context(tab, f.session, f.frameId);
        const call = () =>
          this.host.send(tab, 'Runtime.callFunctionOn', { functionDeclaration: INVOKE, executionContextId: ctx, arguments: [{ value: method }, { value: args }], awaitPromise: true, returnByValue: true, userGesture: true }, f.session);
        let r: any = await withTimeout(call(), RUN_TIMEOUT_MS, '화면이 응답하지 않습니다. 브라우저에 알림 창이 떠 있으면 닫아 주세요');
        if (r.result?.value?.ok === false && r.result.value.error === NO_AGENT) {
          await this.host.send(tab, 'Runtime.evaluate', { expression: this.host.agentSource, contextId: ctx }, f.session);
          r = await withTimeout(call(), RUN_TIMEOUT_MS, '화면이 응답하지 않습니다');
        }
        if (r.exceptionDetails) return { ok: false, error: r.exceptionDetails.exception?.description ?? r.exceptionDetails.text ?? '스크립트 오류' };
        return r.result?.value as Reply<unknown>;
      } catch (e) {
        // 페이지가 바뀌어 맥락이 사라졌으면 한 번 다시 만든다.
        if (attempt === 0 && /context|Cannot find|Execution context was destroyed/i.test((e as Error).message)) {
          this.host.forgetContext(tab, f.session, f.frameId);
          continue;
        }
        throw e;
      }
    }
  }

  private async run<T>(method: string, args: unknown[], frame?: number): Promise<{ frameId: number; reply: Reply<T> }[]> {
    const tab = this.tab();
    const frames = (await this.host.frames(tab)).filter((f) => frame === undefined || f.frame === frame);
    const out: { frameId: number; reply: Reply<T> }[] = [];
    for (const f of frames) {
      try {
        const reply = (await this.callFrame(tab, f, method, args)) as Reply<T>;
        if (reply) out.push({ frameId: f.frame, reply });
      } catch (e) {
        // 한 프레임을 지정해 부른 것이면 실패를 알린다. 모든 프레임을 도는 중이면 그 프레임만 건너뛴다.
        if (frame !== undefined) throw e;
      }
    }
    return out.sort((a, b) => a.frameId - b.frameId);
  }

  private async waitLoaded(maxMs = 15_000): Promise<void> {
    const deadline = Date.now() + maxMs;
    while (Date.now() < deadline) {
      if (!this.host.exists(this.tabId)) return;
      const tab = this.tab();
      if (!tab.loading) {
        const r: any = await withTimeout(this.host.send(tab, 'Runtime.evaluate', { expression: '[document.readyState, location.href]', returnByValue: true }), 2000, '').catch(() => null);
        const [state, href] = (r?.result?.value as [string, string] | undefined) ?? [];
        // 새 탭·팝업은 처음에 빈 문서(about:blank)로 열려 곧바로 complete가 된다. 가려는 주소가 웹이면 그 문서는 아직 아니다.
        const blankYet = href === 'about:blank' && isWeb(tab.url);
        if (state === 'complete' && !blankYet) return;
      }
      await sleep(150);
    }
  }

  waitLoadedPublic(): Promise<void> {
    return this.waitLoaded();
  }

  private async settle(): Promise<void> {
    if (!this.host.exists(this.tabId)) return;
    const tab = this.tab();
    let listener!: () => void;
    const started = new Promise<void>((r) => {
      listener = r;
      tab.navListeners.add(listener);
    });
    try {
      await sleep(120);
      if (!tab.loading) await Promise.race([started, sleep(NAV_START_MS)]);
    } finally {
      tab.navListeners.delete(listener);
    }
    await this.waitLoaded();
    await this.run('settle', []).catch(() => {});
  }

  private async point(target: { frame: number; localRef: number }, label: string): Promise<void> {
    const [res] = await this.run<boolean>('point', [target.localRef, label], target.frame).catch(() => []);
    if (res?.reply.ok && res.reply.value) await sleep(POINT_MS);
  }

  async setActive(on: boolean): Promise<void> {
    this.active = on;
    if (!on) this.dialogLog = [];
    for (const tabId of [...this.openers, this.tabId]) {
      if (!this.host.exists(tabId)) continue;
      const saved = this.tabId;
      this.tabId = tabId;
      await this.run('setActive', [on], 0).catch(() => {});
      this.tabId = saved;
    }
  }

  async snapshot(): Promise<PageSnapshot> {
    await this.follow();
    await this.waitLoaded();
    if (this.active) await this.run('setActive', [true], 0).catch(() => {});
    const dialogs = this.drainDialogs();
    const tab = this.tab();
    try {
      const frames = (await this.run<FrameSnapshot>('snapshot', []))
        .filter((r): r is typeof r & { reply: { ok: true; value: FrameSnapshot } } => r.reply.ok)
        .filter((r) => r.frameId === 0 || r.reply.value.items.length > 0)
        .map((r) => ({ frame: r.frameId, snap: r.reply.value }));
      if (frames.length === 0) throw new Error('읽을 수 있는 프레임이 없습니다');
      const merged = mergeFrames(frames);
      this.refs = merged.refs;
      const moved = this.takeNote().trim();
      return { ...merged.snapshot, dialogs, ...(moved ? { moved } : {}) };
    } catch {
      this.refs = new Map();
      const moved = this.takeNote().trim();
      return { url: tab.url, title: tab.title, hasPassword: false, items: [{ kind: 'text', text: '(이 페이지는 Dogent가 읽을 수 없습니다)' }], dialogs, ...(moved ? { moved } : {}) };
    }
  }

  async inspect(): Promise<SiteInspection> {
    await this.waitLoaded();
    const tab = this.tab();
    const frames = await this.run<FrameInspection>('inspect', [])
      .then((results) =>
        results
          .filter((r): r is typeof r & { reply: { ok: true; value: FrameInspection } } => r.reply.ok)
          .filter((r) => r.frameId === 0 || r.reply.value.elements > 0 || r.reply.value.tables.length > 0)
          .map((r) => r.reply.value),
      )
      .catch(() => []);
    return { url: tab.url, readable: frames.length > 0, frames };
  }

  async navigate(url: string): Promise<ActResult> {
    const tab = this.tab();
    const r: any = await this.host.send(tab, 'Page.navigate', { url });
    if (r.errorText) return { ok: false, message: `이동하지 못했습니다: ${r.errorText}` };
    await sleep(300);
    await this.settle();
    return { ok: true, message: `이동함: ${this.tab().url || url}` };
  }

  private async act(method: 'click' | 'type' | 'select', ref: number, extra: unknown[], confirm?: ConfirmPolicy): Promise<ActResult> {
    const target = this.refs.get(ref);
    if (!target) return { ok: false, message: `ref ${ref} 이(가) 현재 화면에 없습니다` };
    await this.point(target, POINT_LABEL[method]);
    this.policy = confirm ?? null;
    this.clicking = method === 'click';
    this.started = [];
    try {
      const acted = this.tabId;
      const [res] = await this.run<ActResult>(method, [target.localRef, ...extra], target.frame).catch((e) => {
        // 누르자마자 창이 스스로 닫히면 결과를 받지 못한다. 눌린 것으로 본다.
        if (this.host.exists(acted)) throw e;
        return [{ frameId: target.frame, reply: { ok: true as const, value: { ok: true, message: '클릭함' } } }];
      });
      if (!res) {
        if (this.host.exists(acted)) return { ok: false, message: '프레임이 사라졌습니다' };
        await this.follow();
        return { ok: true, message: `클릭함.${this.takeNote()}${this.downloadNote()}`, dialogs: this.drainDialogs() };
      }
      if (!res.reply.ok) return { ok: false, message: res.reply.error };
      await this.settle();
      await this.follow();
      const moved = this.takeNote();
      return { ...res.reply.value, message: `${res.reply.value.message}${moved ? `.${moved}` : ''}${this.downloadNote()}`, dialogs: this.drainDialogs() };
    } finally {
      this.clicking = false;
      this.policy = null;
    }
  }

  private downloadNote(): string {
    if (this.started.length === 0) return '';
    const names = this.started.join(', ');
    this.started = [];
    return `. 파일 내려받기가 시작됨: ${names} (클릭으로는 파일 내용을 읽지 않습니다. 내용이 필요하면 같은 버튼을 download_table로 누르세요)`;
  }

  click(ref: number, confirm?: ConfirmPolicy) {
    return this.act('click', ref, [], confirm);
  }

  type(ref: number, text: string) {
    return this.act('type', ref, [text]);
  }

  select(ref: number, value: string) {
    return this.act('select', ref, [value]);
  }

  async closeTab(): Promise<ActResult> {
    if (this.openers.length === 0) return { ok: false, message: '에이전트가 따라 들어간 새 창이 없습니다. 처음 창은 닫지 않습니다' };
    const tab = this.tab();
    await this.host.cdp.send('Target.closeTarget', { targetId: tab.targetId }).catch(() => {});
    this.tabId = this.openers.pop()!;
    await this.host.focus(this.tabId).catch(() => {});
    return { ok: true, message: '새 창을 닫고 원래 창으로 돌아옴' };
  }

  async fillTable(ref: number, columns: string[], rows: string[][], addRef?: number): Promise<ActResult> {
    const target = this.refs.get(ref);
    if (!target) return { ok: false, message: `ref ${ref} 이(가) 현재 화면에 없습니다` };
    const add = addRef === undefined ? undefined : this.refs.get(addRef);
    if (addRef !== undefined && (!add || add.frame !== target.frame)) return { ok: false, message: '행 추가 버튼이 표와 같은 화면에 없습니다' };
    await this.point(target, '표 입력');
    const [res] = await this.run<ActResult>('fillTable', [target.localRef, columns, rows, add?.localRef], target.frame);
    if (!res) return { ok: false, message: '프레임이 사라졌습니다' };
    if (!res.reply.ok) return { ok: false, message: res.reply.error };
    await this.settle();
    return res.reply.value;
  }

  /**
   * 내려받기 버튼을 누르고 브라우저가 저장한 파일을 읽는다. 브라우저가 실제로 받은 파일이라
   * 폼 전송(POST)·한 번만 쓰는 주소·팝업 창에서 받는 파일도 그대로 읽힌다. 파일은 내려받기 폴더에도 남는다.
   */
  async download(ref: number, timeoutMs: number, allowed: (url: string) => boolean): Promise<DownloadedFile> {
    const target = this.refs.get(ref);
    if (!target) throw new Error(`ref ${ref} 이(가) 현재 화면에 없습니다`);
    await this.point(target, '내려받기');
    const next = this.host.nextDownload();
    this.policy = { accept: true, unless: SUBMIT_PATTERN.source };
    this.clicking = true;
    try {
      const acted = this.tabId;
      const [res] = await this.run<ActResult>('click', [target.localRef], target.frame).catch((e) => {
        if (this.host.exists(acted)) throw e;
        return [{ frameId: target.frame, reply: { ok: true as const, value: { ok: true, message: '클릭함' } } }];
      });
      if (!res) throw new Error('프레임이 사라졌습니다');
      if (!res.reply.ok) throw new Error(res.reply.error);
      if (!res.reply.value.ok) throw new Error(res.reply.value.message);
      const rec = await Promise.race([next.promise, sleep(timeoutMs).then(() => null)]);
      if (!rec) {
        throw new Error(
          `버튼을 눌렀지만 ${timeoutMs / 1000}초 안에 내려받기가 시작되지 않았습니다. 확인 창이 떴다면 accept_dialog로 누르거나, 파일이 새 창에 바로 열렸으면 그 화면의 표를 extract_table로 읽으세요`,
        );
      }
      if (!allowed(rec.url)) throw new Error(`내려받는 파일의 주소(${rec.url.slice(0, 120)})가 허용 도메인 밖이라 읽지 않았습니다`);
      const path = await withTimeout(rec.done, Math.max(timeoutMs, DOWNLOAD_FINISH_MS), `내려받기가 ${Math.round(Math.max(timeoutMs, DOWNLOAD_FINISH_MS) / 1000)}초 안에 끝나지 않았습니다`);
      const st = await fs.stat(path);
      if (st.size > MAX_DOWNLOAD_BYTES) throw new Error(`파일이 너무 큽니다 (${Math.round(st.size / 1e6)}MB)`);
      const bytes = await fs.readFile(path);
      return { filename: path.split(/[\\/]/).pop() || rec.suggested, url: rec.url, data: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer, path };
    } finally {
      next.cancel();
      this.clicking = false;
      this.policy = null;
      await this.settle();
    }
  }

  private async pageAct(method: 'pressKey' | 'scroll', ref: number | undefined, extra: unknown[]): Promise<ActResult> {
    await this.follow();
    const target = ref === undefined || ref === null ? { frame: 0, localRef: null } : this.refs.get(ref);
    if (!target) return { ok: false, message: `ref ${ref} 이(가) 현재 화면에 없습니다` };
    const args = method === 'pressKey' ? [...extra, target.localRef] : [target.localRef, ...extra];
    const [res] = await this.run<ActResult>(method, args, target.frame);
    if (!res) return { ok: false, message: '프레임이 사라졌습니다' };
    if (!res.reply.ok) return { ok: false, message: res.reply.error };
    await this.settle();
    await this.follow();
    const moved = this.takeNote();
    return moved ? { ...res.reply.value, message: `${res.reply.value.message}.${moved}` } : res.reply.value;
  }

  pressKey(key: string, ref?: number): Promise<ActResult> {
    return this.pageAct('pressKey', ref, [key]);
  }

  scroll(ref?: number, direction?: 'up' | 'down'): Promise<ActResult> {
    return this.pageAct('scroll', ref, [direction ?? 'down']);
  }

  async goBack(): Promise<ActResult> {
    const tab = this.tab();
    const h: any = await this.host.send(tab, 'Page.getNavigationHistory');
    if (h.currentIndex <= 0) return { ok: false, message: '뒤로 갈 화면이 없습니다' };
    await this.host.send(tab, 'Page.navigateToHistoryEntry', { entryId: h.entries[h.currentIndex - 1].id });
    await sleep(300);
    await this.settle();
    return { ok: true, message: `뒤로 감: ${this.tab().url}` };
  }

  async screenshot(): Promise<Screenshot> {
    await this.follow();
    await this.waitLoaded();
    const tab = this.tab();
    await this.host.focus(this.tabId);
    const m: any = await this.host.send(tab, 'Page.getLayoutMetrics');
    const v = m.cssVisualViewport ?? m.visualViewport;
    let { width, height } = fitSize(Math.round(v.clientWidth), Math.round(v.clientHeight));
    for (let quality = 80; ; quality -= 15) {
      const scale = width / v.clientWidth;
      const r: any = await this.host.send(tab, 'Page.captureScreenshot', {
        format: 'jpeg',
        quality: Math.max(quality, 20),
        clip: { x: v.pageX, y: v.pageY, width: v.clientWidth, height: v.clientHeight, scale },
      });
      if (r.data.length <= SHOT_MAX_BASE64) return { mimeType: 'image/jpeg', base64: r.data, width, height };
      if (quality <= 35) ({ width, height } = { width: Math.round(width * 0.75), height: Math.round(height * 0.75) });
      if (width < 200) throw new Error('화면 그림이 너무 커서 상한 안으로 줄일 수 없습니다');
    }
  }

  async attachFile(ref: number, file: UploadPayload): Promise<ActResult> {
    const target = this.refs.get(ref);
    if (!target) return { ok: false, message: `ref ${ref} 이(가) 현재 화면에 없습니다` };
    await this.point(target, '파일 올리기');
    const [res] = await this.run<ActResult>('attachFile', [target.localRef, file.name, file.mime, file.base64], target.frame);
    if (!res) return { ok: false, message: '프레임이 사라졌습니다' };
    if (!res.reply.ok) return { ok: false, message: res.reply.error };
    await this.settle();
    return res.reply.value;
  }

  async readText(ref?: number): Promise<string> {
    await this.follow();
    await this.waitLoaded();
    if (ref !== undefined) {
      const target = this.refs.get(ref);
      if (!target) throw new Error(`ref ${ref}를 찾을 수 없습니다. 화면을 다시 읽은 뒤 번호를 고르세요`);
      const [res] = await this.run<string>('readText', [target.localRef], target.frame);
      if (!res) throw new Error('화면을 읽지 못했습니다');
      if (!res.reply.ok) throw new Error(res.reply.error);
      return res.reply.value;
    }
    return (await this.run<string>('readText', [])).flatMap((r) => (r.reply.ok && r.reply.value ? [r.reply.value] : [])).join('\n\n---\n\n');
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
