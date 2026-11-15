import { join } from 'node:path';
import type { BrowserLink } from '../../../bridge/hub.mjs';
import { BrowserTools, McpBrowser, type ApprovalRequest, type McpCall } from '../../../src/core';
import type { Bridge } from '../bridge';
import { readDownloadedFile } from '../download';
import { readUploadFile, type UploadPolicy } from '../upload';
import { launch, type Launched } from './cdp';
import { DirectHost, type DirectPort } from './host';

/**
 * 브라우저 연결 방식 "직접 제어": 확장 없이 Dogent 전용 브라우저 창을 띄워 다룬다.
 * 세션에는 확장 연결(openBridge)과 같은 모양(Bridge)으로 내놓으므로, 스킬 실행·자유 대화·승인 흐름은 그대로 돈다.
 * 화면 읽기·조작의 통제(조작할 사이트, 저장·상신 승인, 올릴 파일 검사)는 확장과 같은 BrowserTools가 지킨다.
 */

/** 페이지 에이전트 스크립트 (빌드할 때 client/build-env.mjs가 채운다) */
declare const __DOGENT_PAGE_AGENT__: string | undefined;

export interface DirectOptions {
  /** Dogent 사용자 폴더 (~/.dogent). 전용 프로필과 받는 중인 파일을 여기에 둔다 */
  home: string;
  /** 다 받은 파일을 둘 폴더 */
  downloadsDir: string;
  /** 크롬·엣지 고르기 (설정의 browser) */
  want?: string;
  /** 브라우저 실행 파일 (설정의 browserPath) */
  executable?: string;
  /** 조작할 사이트 규칙. 없으면 모든 http·https 사이트 (회사 빌드의 기본과 같다. 차단은 사내 방화벽이 맡는다) */
  sites?: string[];
  /** 저장·상신·올리기 직전에 사람에게 묻는다 (앱의 승인 화면) */
  approve(request: ApprovalRequest): Promise<boolean>;
  upload?: UploadPolicy;
  /** 시험용 */
  headless?: boolean;
  agentSource?: string;
}

/** 이 프로세스가 띄운 Dogent 브라우저. 설정을 바꿔 세션을 새로 만들어도 창을 닫지 않고 이어 쓴다. */
interface Shared {
  launched: Launched;
  host: DirectHost;
  since: number;
  key: string;
}
let shared: Shared | null = null;
let starting: Promise<Shared> | null = null;

/** Dogent 브라우저를 닫는다 (앱을 끌 때) */
export function closeDirectBrowser(): void {
  shared?.launched.close();
  shared = null;
}

/** 승인 함수는 세션마다 바뀌므로 바깥에서 갈아 끼운다 */
let approveNow: (request: ApprovalRequest) => Promise<boolean> = async () => false;

/** 조작할 사이트. 주지 않으면 모든 http·https (회사 빌드의 기본과 같다. 차단은 사내 방화벽이 맡는다) */
const sitesOf = (opts: DirectOptions) => (opts.sites?.length ? opts.sites : ['http://*/*', 'https://*/*']);

async function browserFor(opts: DirectOptions): Promise<Shared> {
  const key = `${opts.want ?? ''}|${opts.executable ?? ''}`;
  if (shared && !shared.launched.cdp.closed && shared.key === key) {
    // 같은 브라우저를 이어 쓰더라도 조작할 사이트는 지금 설정을 따른다
    shared.host.setSites(sitesOf(opts));
    return shared;
  }
  if (starting) return starting;
  starting = (async () => {
    if (shared) closeDirectBrowser();
    const agentSource = opts.agentSource ?? (typeof __DOGENT_PAGE_AGENT__ === 'string' ? __DOGENT_PAGE_AGENT__ : '');
    if (!agentSource) throw new Error('이 빌드에는 페이지 에이전트가 들어 있지 않아 직접 제어를 쓸 수 없습니다');
    const launched = await launch({ want: opts.want, executable: opts.executable, profileDir: join(opts.home, 'browser'), headless: opts.headless });
    const host = new DirectHost(launched.cdp, {
      sites: sitesOf(opts),
      approve: (r) => approveNow(r),
      tempDir: join(opts.home, 'browser-downloads'),
      downloadsDir: opts.downloadsDir,
      agentSource,
    });
    await host.start();
    const s: Shared = { launched, host, since: Date.now(), key };
    shared = s;
    launched.cdp.closed$(() => {
      if (shared === s) shared = null;
    });
    return s;
  })().finally(() => {
    starting = null;
  });
  return starting;
}

/** 마지막 호출 뒤 이 시간이 지나면 "조작 중" 표시와 알림 창 자동 응답을 끈다. 사람이 그 창을 직접 쓸 때 방해하지 않게. */
const IDLE_MS = 90_000;

function marks(tool: string, args: Record<string, unknown>): boolean {
  if (tool === 'tabs_list' || tool === 'wait_for_login') return false;
  if (tool === 'dogent_port') return !['setActive', 'followActive', 'tabs', 'target'].includes(String(args.method));
  return true;
}

export function openDirect(opts: DirectOptions): Bridge & { error(): string | undefined } {
  approveNow = opts.approve;
  let tools: { host: DirectHost; tools: BrowserTools } | null = null;
  let lastError: string | undefined;
  const idle = new Map<DirectPort, ReturnType<typeof setTimeout>>();

  const ready = async () => {
    const s = await browserFor(opts);
    if (!tools || tools.host !== s.host) tools = { host: s.host, tools: new BrowserTools(s.host) };
    return tools;
  };

  const wake = async (p: DirectPort) => {
    clearTimeout(idle.get(p));
    idle.delete(p);
    if (!p.isActive) await p.setActive(true).catch(() => {});
  };
  const rest = (p: DirectPort) => {
    clearTimeout(idle.get(p));
    idle.set(
      p,
      setTimeout(() => {
        idle.delete(p);
        void p.setActive(false).catch(() => {});
      }, IDLE_MS),
    );
  };

  const call: McpCall = async (name, args) => {
    try {
      const { host, tools: t } = await ready();
      const marked = marks(name, args);
      const before = marked ? await t.peekTarget() : null;
      const first = before === null ? null : host.port(before);
      if (first) await wake(first);
      try {
        return { text: await t.call(name, args), isError: false };
      } finally {
        if (marked) {
          const after = await t.peekTarget().catch(() => null);
          const last = after === null ? null : host.port(after);
          if (last && last !== first) await wake(last);
          for (const p of new Set([first, last])) if (p) rest(p);
        }
      }
    } catch (e) {
      return { text: (e as Error).message, isError: true };
    }
  };

  const link = (): BrowserLink[] =>
    shared && !shared.launched.cdp.closed ? [{ id: 1, browser: `${shared.launched.name} (Dogent 전용 창)`, via: '직접 제어', since: shared.since, selected: true }] : [];

  return {
    browser: new McpBrowser(
      call,
      (path) => readUploadFile(path, opts.upload ?? { dirs: [opts.downloadsDir] }),
      (path) => readDownloadedFile(path),
    ),
    call,
    connected: () => (shared && !shared.launched.cdp.closed ? '직접 제어' : null),
    /** 브라우저를 띄우고 붙는다 (이미 떠 있으면 그대로 쓴다) */
    async waitForExtension() {
      try {
        await ready();
        lastError = undefined;
        return true;
      } catch (e) {
        lastError = (e as Error).message;
        return false;
      }
    },
    browsers: link,
    select: () => {
      const l = link()[0];
      if (!l) throw new Error('Dogent 브라우저가 떠 있지 않습니다');
      return { id: l.id, browser: l.browser, via: l.via };
    },
    /** 세션을 닫아도 브라우저 창은 남긴다 (설정을 바꿔도 로그인한 창을 잃지 않게). 앱을 끌 때 closeDirectBrowser를 부른다 */
    close() {
      for (const t of idle.values()) clearTimeout(t);
      idle.clear();
    },
    error: () => lastError,
  };
}
