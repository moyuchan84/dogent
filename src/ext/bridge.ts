import { browser, type Browser } from 'wxt/browser';
import { DEFAULT_PORT, NATIVE_HOST_NAME, answerChallenge, type BridgeMessage } from '@/bridge/protocol.mjs';
import { BrowserTools, type ToolHost } from '../core/browser-tools';
import type { ApprovalRequest } from '../core/types';
import { ChromeBrowser } from './browser';
import { allSites } from './sites';

/**
 * 외부 클라이언트(MCP) 연결. 백그라운드에서 돈다 (docs/09 1단계).
 * 브리지(bridge/hub.mjs)에 WebSocket이나 Native Messaging으로 붙고, 토큰으로 서로를 확인한 뒤
 * 브리지가 보내는 도구 호출을 BrowserTools로 실행한다.
 */

export type BridgeMode = 'off' | 'native' | 'ws';
export interface BridgeSettings {
  mode: BridgeMode;
  port: number;
  token: string;
}
export interface BridgeStatus {
  state: 'off' | 'connecting' | 'connected' | 'error';
  detail: string;
  at: number;
}

export const BRIDGE_SETTINGS_KEY = 'bridgeSettings';
export const BRIDGE_STATUS_KEY = 'bridgeStatus';
export const DEFAULT_BRIDGE: BridgeSettings = { mode: 'off', port: DEFAULT_PORT, token: '' };

export async function loadBridgeSettings(): Promise<BridgeSettings> {
  const stored = (await browser.storage.local.get(BRIDGE_SETTINGS_KEY))[BRIDGE_SETTINGS_KEY] as Partial<BridgeSettings> | undefined;
  return { ...DEFAULT_BRIDGE, ...stored };
}

const setStatus = (state: BridgeStatus['state'], detail = '') =>
  browser.storage.local.set({ [BRIDGE_STATUS_KEY]: { state, detail, at: Date.now() } satisfies BridgeStatus });

// ---- 승인 창 ----

const approvals = new Map<number, { request: ApprovalRequest; resolve: (ok: boolean) => void; windowId?: number }>();
let nextApproval = 1;
const APPROVAL_TIMEOUT_MS = 5 * 60_000;

/** 저장·상신 직전에 별도 창을 띄워 사람에게 묻는다. 창을 닫거나 5분이 지나면 승인하지 않은 것으로 본다. */
function askApproval(request: ApprovalRequest, tabId: number): Promise<boolean> {
  const id = nextApproval++;
  return new Promise((resolve) => {
    const done = (ok: boolean) => {
      const a = approvals.get(id);
      if (!a) return;
      approvals.delete(id);
      clearTimeout(timer);
      if (a.windowId !== undefined) void browser.windows.remove(a.windowId).catch(() => {});
      resolve(ok);
    };
    const timer = setTimeout(() => done(false), APPROVAL_TIMEOUT_MS);
    approvals.set(id, { request, resolve: done });
    // 사람이 화면을 보며 결정할 수 있게 그 탭을 앞으로 가져오고 승인 창을 띄운다.
    void browser.tabs.update(tabId, { active: true }).catch(() => {});
    void browser.windows
      .create({ url: browser.runtime.getURL(`/approve.html?id=${id}`), type: 'popup', width: 460, height: 620, focused: true })
      .then((w) => {
        const a = approvals.get(id);
        if (a) a.windowId = w?.id;
      })
      .catch(() => done(false));
  });
}

/** 승인 창이 요청 내용을 읽고 결정을 알린다. */
function onApprovalMessage(msg: unknown): Promise<unknown> | undefined {
  const m = msg as { dogentApproval?: 'get' | 'decide'; id?: number; ok?: boolean };
  if (!m?.dogentApproval || typeof m.id !== 'number') return undefined;
  const a = approvals.get(m.id);
  if (m.dogentApproval === 'get') return Promise.resolve(a ? a.request : null);
  a?.resolve(m.ok === true);
  return Promise.resolve(true);
}

// ---- 브라우저 쪽 기능 ----

const ports = new Map<number, ChromeBrowser>();
const idle = new Map<number, ReturnType<typeof setTimeout>>();
/** 마지막 호출 뒤 이 시간이 지나면 화면의 "조작 중" 표시를 끈다. */
const IDLE_MS = 20_000;

function portFor(tabId: number): ChromeBrowser {
  let p = ports.get(tabId);
  if (!p) {
    p = new ChromeBrowser(tabId);
    ports.set(tabId, p);
  }
  return p;
}

const isWeb = (url?: string) => !!url && /^https?:\/\//.test(url);

const host: ToolHost = {
  async tabs() {
    return (await browser.tabs.query({})).flatMap((t) => (t.id !== undefined && isWeb(t.url) ? [{ id: t.id, url: t.url!, title: t.title ?? '' }] : []));
  },
  async open(url) {
    const tab = await browser.tabs.create({ url, active: true });
    const id = tab.id!;
    for (let i = 0; i < 100; i++) {
      const t = await browser.tabs.get(id).catch(() => null);
      if (!t || t.status === 'complete') break;
      await new Promise((r) => setTimeout(r, 150));
    }
    return id;
  },
  async focus(tabId) {
    const tab = await browser.tabs.update(tabId, { active: true });
    if (tab?.windowId !== undefined) await browser.windows.update(tab.windowId, { focused: true }).catch(() => {});
  },
  port: portFor,
  sites: allSites,
  approve: askApproval,
  async activeTab() {
    const [tab] = await browser.tabs.query({ active: true, lastFocusedWindow: true });
    if (tab?.id !== undefined && isWeb(tab.url)) return tab.id;
    const any = (await browser.tabs.query({})).find((t) => isWeb(t.url));
    return any?.id ?? null;
  },
};

const tools = new BrowserTools(host);

/** 도구를 실행하는 동안 그 탭에 "조작 중" 표시를 하고, 한동안 호출이 없으면 끈다. */
async function runTool(tool: string, args: Record<string, unknown>): Promise<string> {
  const tabId = await host.activeTab();
  const marked = tabId !== null && tool !== 'tabs_list' && tool !== 'wait_for_login';
  if (marked && !idle.has(tabId)) await portFor(tabId).setActive(true).catch(() => {});
  try {
    return await tools.call(tool, args);
  } finally {
    if (marked) {
      clearTimeout(idle.get(tabId));
      idle.set(
        tabId,
        setTimeout(() => {
          idle.delete(tabId);
          void portFor(tabId).setActive(false).catch(() => {});
        }, IDLE_MS),
      );
    }
  }
}

// ---- 연결 ----

interface Transport {
  send(msg: BridgeMessage): void;
  close(): void;
}

let transport: Transport | null = null;
let authed = false;
let expected = '';
let retry: ReturnType<typeof setTimeout> | null = null;
let keepalive: ReturnType<typeof setInterval> | null = null;
/** 브리지가 거절한 이유 (토큰이 다름 등). 연결이 끊긴 뒤에도 이 이유를 보여 주고, 다시 붙는 간격을 늘린다. */
let refused = '';

function scheduleRetry(ms: number) {
  if (retry) clearTimeout(retry);
  retry = setTimeout(() => {
    retry = null;
    void ensureConnected();
  }, ms);
}

function drop() {
  if (keepalive) clearInterval(keepalive);
  keepalive = null;
  const t = transport;
  transport = null;
  authed = false;
  t?.close();
}

async function onMessage(msg: BridgeMessage, settings: BridgeSettings) {
  const t = transport;
  if (!t) return;
  switch (msg.type) {
    case 'status':
      if (msg.state === 'waiting-hub') await setStatus('connecting', 'Dogent 클라이언트(브리지)가 실행 중이 아닙니다. MCP 클라이언트에서 브리지를 띄우세요');
      else if (msg.state === 'auth-failed') {
        refused = '토큰이 브리지와 다릅니다. 저장소 폴더에서 pnpm bridge:token 으로 확인해 넣으세요';
        await setStatus('error', refused);
      }
      return;
    case 'challenge': {
      if (!settings.token) {
        await setStatus('error', '토큰이 없습니다. 설정 → 클라이언트 연결에 토큰을 넣으세요');
        return drop();
      }
      const { reply, expect } = await answerChallenge(settings.token, msg);
      expected = expect;
      t.send(reply);
      return;
    }
    case 'welcome':
      if (msg.proof !== expected) {
        // 토큰을 모르는 프로그램이 브리지인 척하고 있다. 명령을 받지 않는다.
        refused = '브리지를 확인하지 못했습니다 (토큰이 다른 프로그램). 연결을 끊었습니다';
        await setStatus('error', refused);
        return drop();
      }
      authed = true;
      refused = '';
      await setStatus('connected', settings.mode === 'ws' ? `WebSocket 127.0.0.1:${settings.port}` : 'Native Messaging');
      if (keepalive) clearInterval(keepalive);
      // 연결이 살아 있는 동안 서비스 워커가 잠들지 않게 주기적으로 신호를 보낸다.
      keepalive = setInterval(() => transport?.send({ type: 'ping' }), 20_000);
      return;
    case 'call': {
      if (!authed) return;
      try {
        const text = await runTool(msg.tool, msg.args ?? {});
        transport?.send({ type: 'result', id: msg.id, ok: true, text });
      } catch (e) {
        transport?.send({ type: 'result', id: msg.id, ok: false, error: (e as Error).message });
      }
      return;
    }
    default:
      return;
  }
}

/** 설정에 맞게 연결을 맺거나 끊는다. 이미 연결되어 있으면 그대로 둔다. */
export async function ensureConnected(): Promise<void> {
  const settings = await loadBridgeSettings();
  if (settings.mode === 'off') {
    drop();
    return void setStatus('off');
  }
  if (transport) return;
  await setStatus('connecting', settings.mode === 'ws' ? `ws://127.0.0.1:${settings.port} 에 붙는 중` : 'Native Messaging 호스트를 띄우는 중');
  if (settings.mode === 'ws') {
    let ws: WebSocket;
    try {
      ws = new WebSocket(`ws://127.0.0.1:${settings.port}`);
    } catch (e) {
      await setStatus('error', (e as Error).message);
      return scheduleRetry(10_000);
    }
    const t: Transport = { send: (m) => ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify(m)), close: () => ws.close() };
    transport = t;
    ws.onmessage = (e) => {
      try {
        void onMessage(JSON.parse(String(e.data)), settings);
      } catch {
        /* 형식이 틀린 메시지는 버린다 */
      }
    };
    ws.onclose = () => {
      if (transport !== t) return;
      const wasAuthed = authed;
      drop();
      if (refused) {
        // 토큰이 틀려 거절된 것이다. 같은 토큰으로 자주 다시 붙지 않는다 (설정을 바꾸면 바로 다시 붙는다).
        void setStatus('error', refused);
        return scheduleRetry(60_000);
      }
      void setStatus('error', wasAuthed ? '브리지와 연결이 끊겼습니다. 다시 붙는 중' : `ws://127.0.0.1:${settings.port} 에 닿지 않습니다. 브리지가 실행 중인지 확인하세요`);
      scheduleRetry(5_000);
    };
    return;
  }
  let port: Browser.runtime.Port;
  try {
    port = browser.runtime.connectNative(NATIVE_HOST_NAME);
  } catch (e) {
    await setStatus('error', `Native Messaging을 쓸 수 없습니다: ${(e as Error).message}`);
    return scheduleRetry(60_000);
  }
  const t: Transport = { send: (m) => port.postMessage(m), close: () => port.disconnect() };
  transport = t;
  port.onMessage.addListener((m) => void onMessage(m as BridgeMessage, settings));
  port.onDisconnect.addListener(() => {
    if (transport !== t) return;
    const reason = browser.runtime.lastError?.message ?? '';
    drop();
    const missing = /not found|찾을 수 없/i.test(reason);
    void setStatus(
      'error',
      missing
        ? 'Native Messaging 호스트가 설치되지 않았습니다. pnpm bridge:install --id <확장 ID> 를 실행하세요'
        : `Native Messaging 연결이 끊겼습니다${reason ? `: ${reason}` : ''}. 회사 정책으로 막혀 있으면 WebSocket을 쓰세요`,
    );
    scheduleRetry(missing ? 60_000 : 5_000);
  });
}

/** 백그라운드에서 한 번 부른다. 설정이 바뀌면 다시 붙고, 서비스 워커가 깨어날 때마다 연결을 확인한다. */
export function startBridge(): void {
  browser.runtime.onMessage.addListener((msg) => onApprovalMessage(msg));
  browser.windows.onRemoved.addListener((windowId) => {
    for (const a of approvals.values()) if (a.windowId === windowId) a.resolve(false);
  });
  browser.tabs.onRemoved.addListener((tabId) => {
    ports.delete(tabId);
    clearTimeout(idle.get(tabId));
    idle.delete(tabId);
  });
  browser.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes[BRIDGE_SETTINGS_KEY]) return;
    refused = '';
    if (retry) clearTimeout(retry);
    retry = null;
    drop();
    void ensureConnected();
  });
  void browser.alarms.create('dogent-bridge', { periodInMinutes: 1 });
  browser.alarms.onAlarm.addListener((a) => {
    if (a.name === 'dogent-bridge') void ensureConnected();
  });
  void ensureConnected();
}
