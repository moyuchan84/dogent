// Dogent 브리지: MCP 클라이언트(Claude Code, 이후의 Dogent 클라이언트)와 Dogent 크롬 확장을 잇는다.
//
//   node bridge/hub.mjs            MCP 서버로 실행 (stdio). MCP 클라이언트가 이 명령을 띄운다
//   node bridge/hub.mjs --token    확장 설정에 넣을 토큰을 출력
//
// 확장과는 두 가지로 잇는다. 둘 다 같은 토큰으로 서로를 확인한다 (bridge/protocol.mjs).
//   WebSocket          ws://127.0.0.1:<포트>  (DOGENT_BRIDGE_PORT, 기본 39217). 확장이 붙어 온다
//   Native Messaging   크롬이 띄운 native host(bridge/native-host.mjs)가 이 프로세스의 파이프로 붙어 온다
//
// 환경 변수
//   DOGENT_BRIDGE_TOKEN  토큰. 없으면 ~/.dogent/bridge-token (처음 실행 때 만든다)
//   DOGENT_BRIDGE_PORT   WebSocket 포트
//   DOGENT_BRIDGE_PIPE   파이프 경로 (기본은 사용자별 이름)
//
// stdout은 MCP가 쓰므로 기록은 stderr로만 낸다.
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { homedir, userInfo } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { WebSocketServer } from 'ws';
import { DEFAULT_PORT, acceptAuth, lineReader, pipePath, randomNonce } from './protocol.mjs';
import { HUB_TOOLS, PORT_TOOL, TOOLS } from './tools.mjs';

const VERSION = '0.1.0';
/** 승인 창이나 로그인을 기다리는 도구가 있어 넉넉히 둔다. */
const CALL_TIMEOUT_MS = 16 * 60_000;
const AUTH_TIMEOUT_MS = 10_000;

export function tokenFile() {
  return join(homedir(), '.dogent', 'bridge-token');
}

/** 토큰을 읽고, 없으면 만든다. */
export function loadToken() {
  if (process.env.DOGENT_BRIDGE_TOKEN) return process.env.DOGENT_BRIDGE_TOKEN;
  const file = tokenFile();
  if (existsSync(file)) return readFileSync(file, 'utf8').trim();
  mkdirSync(join(homedir(), '.dogent'), { recursive: true });
  const token = randomBytes(24).toString('base64url');
  writeFileSync(file, `${token}\n`, { mode: 0o600 });
  return token;
}

/**
 * 브리지 본체. 확장 연결을 받고, MCP 요청을 처리한다. 테스트에서는 이 함수를 직접 쓴다.
 *
 * 크롬과 엣지처럼 Dogent 확장이 든 브라우저가 여럿 붙을 수 있다. 연결은 모두 두고, 도구 호출은 고른 브라우저 하나로 보낸다.
 * 고르지 않았으면 가장 나중에 붙은 브라우저를 쓴다. 같은 브라우저가 다시 붙으면(서비스 워커가 다시 깨어남) 이전 연결을 대신한다.
 */
export function createHub({ token, port = DEFAULT_PORT, pipe = pipePath(userInfo().username), log = () => {} }) {
  /** 확인을 마친 연결들. { id, via, browser, key, since, send, close } */
  const links = [];
  let selected = null; // 고른 연결의 id
  let nextLink = 1;
  let nextId = 1;
  const pending = new Map();

  /** 지금 도구를 보낼 연결 */
  const current = () => links.find((l) => l.id === selected) ?? links.at(-1) ?? null;

  /** 연결 하나에 대해 확인 절차를 밟고, 통과하면 브라우저 목록에 넣는다. */
  function attach(via, send, close, onMessage) {
    const nonce = randomNonce();
    let authed = false;
    const timer = setTimeout(() => {
      if (!authed) {
        log(`${via}: ${AUTH_TIMEOUT_MS / 1000}초 안에 확인을 마치지 못해 끊음`);
        close();
      }
    }, AUTH_TIMEOUT_MS);
    const self = { id: 0, send, close, via, browser: '브라우저', key: '', since: Date.now() };
    onMessage(async (msg) => {
      if (!authed) {
        if (msg?.type === 'status') return log(`${via}: ${msg.state}${msg.detail ? ` (${msg.detail})` : ''}`);
        const welcome = await acceptAuth(token, nonce, msg);
        if (!welcome) {
          log(`${via}: 토큰이 맞지 않아 끊음. 확장 설정의 토큰을 확인하세요`);
          send({ type: 'status', state: 'auth-failed', detail: '브리지의 토큰과 다릅니다' });
          clearTimeout(timer);
          return close();
        }
        authed = true;
        clearTimeout(timer);
        send(welcome);
        self.id = nextLink++;
        links.push(self);
        log(`확장 연결됨 (${via})`);
        return;
      }
      if (msg?.type === 'ping') return send({ type: 'pong' });
      if (msg?.type === 'hello') {
        // 확장이 알려 준 브라우저 이름(예: Microsoft Edge 141)과 구분 값(확장 ID + 브라우저 종류)
        self.browser = String(msg.browser ?? '브라우저').slice(0, 80);
        self.key = String(msg.key ?? '');
        // 같은 브라우저가 다시 붙었으면 이전 연결을 대신한다. 고른 브라우저였으면 새 연결을 고른다.
        const old = links.find((l) => l !== self && self.key && l.key === self.key);
        if (old) {
          if (selected === old.id) selected = self.id;
          old.close();
        }
        log(`브라우저: ${self.browser} (${via})`);
        return;
      }
      if (msg?.type === 'result') {
        const p = pending.get(msg.id);
        if (!p) return;
        pending.delete(msg.id);
        clearTimeout(p.timer);
        if (msg.ok) p.resolve(msg.text);
        else p.reject(new Error(msg.error));
      }
    });
    send({ type: 'challenge', nonce });
    return () => {
      clearTimeout(timer);
      const at = links.indexOf(self);
      if (at < 0) return;
      links.splice(at, 1);
      if (selected === self.id) selected = null;
      log(`확장 연결 끊김 (${self.browser}, ${via})`);
      for (const [id, p] of pending) {
        if (p.link !== self) continue;
        clearTimeout(p.timer);
        p.reject(new Error('확장 연결이 끊겼습니다'));
        pending.delete(id);
      }
    };
  }

  /** 연결된 브라우저 목록 */
  function browsers() {
    const now = current();
    return links.map((l) => ({ id: l.id, browser: l.browser, via: l.via, since: l.since, selected: l === now }));
  }

  /** 브라우저를 고른다. 번호나 이름 일부(edge, chrome). 고른 브라우저를 돌려준다. */
  function select(which) {
    const text = String(which ?? '').trim().toLowerCase();
    const byId = links.find((l) => String(l.id) === text);
    const byName = links.filter((l) => l.browser.toLowerCase().includes(text));
    const pick = byId ?? (byName.length === 1 ? byName[0] : null);
    if (!pick) {
      const names = links.map((l) => `[${l.id}] ${l.browser}`).join(', ') || '없음';
      throw new Error(byName.length > 1 ? `"${which}"에 맞는 브라우저가 여럿입니다: ${names}. 번호로 고르세요` : `"${which}"에 맞는 브라우저가 없습니다. 연결된 브라우저: ${names}`);
    }
    selected = pick.id;
    log(`브라우저를 골랐습니다: ${pick.browser}`);
    return { id: pick.id, browser: pick.browser, via: pick.via };
  }

  const describeBrowsers = () =>
    links.length === 0
      ? '연결된 브라우저가 없습니다. 브라우저의 Dogent 사이드 패널 → 설정 → 클라이언트 연결을 켜세요'
      : browsers()
          .map((b) => `[${b.id}]${b.selected ? ' (사용 중)' : ''} ${b.browser} — ${b.via}`)
          .join('\n');

  // WebSocket. 웹페이지도 localhost에 붙을 수 있으므로 확장(chrome-extension://)에서 온 연결만 받고, 토큰으로 다시 확인한다.
  const wss = new WebSocketServer({
    host: '127.0.0.1',
    port,
    // 크롬과 엣지 모두 확장의 출처는 chrome-extension:// 이다.
    verifyClient: ({ origin }) => (origin ?? '').startsWith('chrome-extension://'),
  });
  wss.on('connection', (ws) => {
    let handler = () => {};
    const detach = attach(
      'WebSocket',
      (m) => ws.readyState === ws.OPEN && ws.send(JSON.stringify(m)),
      () => ws.close(),
      (h) => (handler = h),
    );
    ws.on('message', (data) => {
      try {
        void handler(JSON.parse(String(data)));
      } catch {
        /* 형식이 틀린 메시지는 버린다 */
      }
    });
    ws.on('close', detach);
    ws.on('error', () => {});
  });
  const wsReady = new Promise((resolve, reject) => {
    wss.on('listening', resolve);
    wss.on('error', (e) => {
      log(`WebSocket 포트 ${port}를 열지 못했습니다: ${e.message}. 다른 브리지가 이미 실행 중일 수 있습니다`);
      reject(e);
    });
  });

  // Native Messaging: native host가 이 파이프로 붙는다. 줄 단위 JSON.
  const pipeServer = createServer((sock) => {
    let handler = () => {};
    const detach = attach(
      'Native Messaging',
      (m) => !sock.destroyed && sock.write(`${JSON.stringify(m)}\n`),
      () => sock.destroy(),
      (h) => (handler = h),
    );
    sock.on('data', lineReader((m) => void handler(m)));
    sock.on('close', detach);
    sock.on('error', () => {});
  });
  const pipeReady = new Promise((resolve) => {
    pipeServer.on('error', (e) => {
      log(`파이프 ${pipe}를 열지 못했습니다: ${e.message}. Native Messaging은 쓸 수 없고 WebSocket만 씁니다`);
      resolve();
    });
    pipeServer.listen(pipe, resolve);
  });

  /** 확장에 도구 실행을 맡긴다. */
  function callTool(tool, args) {
    const link = current();
    if (!link) {
      return Promise.reject(
        new Error(
          'Dogent 확장이 연결되지 않았습니다. 브라우저에서 Dogent 사이드 패널 → 설정 → 클라이언트 연결을 켜고 토큰을 넣으세요 (토큰: node bridge/hub.mjs --token).',
        ),
      );
    }
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`${CALL_TIMEOUT_MS / 60000}분 안에 확장이 답하지 않았습니다`));
      }, CALL_TIMEOUT_MS);
      const started = Date.now();
      const slow = (ok) => {
        const ms = Date.now() - started;
        if (ms > 500) log(`느린 도구 호출: ${tool}${args?.method ? `.${args.method}` : ''} ${ms}ms${ok ? '' : ' (실패)'}`);
      };
      pending.set(id, {
        resolve: (v) => (slow(true), resolve(v)),
        reject: (e) => (slow(false), reject(e)),
        timer,
        link,
      });
      link.send({ type: 'call', id, tool, args: args ?? {} });
    });
  }

  /** MCP JSON-RPC 요청 하나를 처리한다. 알림(id 없음)이면 null. */
  async function handleMcp(req) {
    const reply = (result) => ({ jsonrpc: '2.0', id: req.id, result });
    const fail = (code, message) => ({ jsonrpc: '2.0', id: req.id, error: { code, message } });
    if (req.id === undefined || req.id === null) return null;
    switch (req.method) {
      case 'initialize':
        return reply({
          protocolVersion: req.params?.protocolVersion ?? '2025-06-18',
          capabilities: { tools: {} },
          serverInfo: { name: 'dogent-browser', version: VERSION },
          instructions:
            'Dogent 크롬 확장으로 사내 웹 화면을 읽고 조작한다. snapshot으로 화면을 읽고 [번호]로 조작한다. 저장·상신 버튼은 사람이 승인해야 눌린다. 로그인 화면([login_required])이면 사용자에게 직접 로그인해 달라고 하고 wait_for_login을 부른다.',
        });
      case 'ping':
        return reply({});
      case 'tools/list':
        return reply({ tools: [...HUB_TOOLS, ...TOOLS] });
      case 'tools/call': {
        const name = req.params?.name;
        // 브라우저 고르기는 브리지가 직접 답한다.
        if (name === 'browsers_list') return reply({ content: [{ type: 'text', text: describeBrowsers() }] });
        if (name === 'browser_select') {
          try {
            const b = select(req.params?.arguments?.browser);
            return reply({ content: [{ type: 'text', text: `[${b.id}] ${b.browser}을(를) 씁니다` }] });
          } catch (e) {
            return reply({ content: [{ type: 'text', text: e.message }], isError: true });
          }
        }
        if (name !== PORT_TOOL && !TOOLS.some((t) => t.name === name)) return fail(-32602, `모르는 도구: ${name}`);
        try {
          const text = await callTool(name, req.params?.arguments ?? {});
          return reply({ content: [{ type: 'text', text }] });
        } catch (e) {
          return reply({ content: [{ type: 'text', text: e.message }], isError: true });
        }
      }
      default:
        return fail(-32601, `지원하지 않는 메서드: ${req.method}`);
    }
  }

  return {
    ready: Promise.all([wsReady, pipeReady]),
    handleMcp,
    /** 지금 쓰는 브라우저의 연결 방식. 없으면 null */
    connected: () => current()?.via ?? null,
    browsers,
    select,
    close() {
      wss.close();
      pipeServer.close();
      for (const l of [...links]) l.close();
    },
  };
}

// 다른 프로그램(Dogent 클라이언트)에 묶여 들어가면 이 부분은 돌지 않는다.
if (process.argv[1] && /hub\.mjs$/.test(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const token = loadToken();
  if (process.argv.includes('--token')) {
    console.log(token);
    process.exit(0);
  }
  const log = (line) => process.stderr.write(`[dogent-bridge] ${line}\n`);
  const hub = createHub({
    token,
    port: Number(process.env.DOGENT_BRIDGE_PORT ?? DEFAULT_PORT),
    pipe: process.env.DOGENT_BRIDGE_PIPE ?? pipePath(userInfo().username),
    log,
  });
  hub.ready.then(
    () => log(`대기 중: ws://127.0.0.1:${process.env.DOGENT_BRIDGE_PORT ?? DEFAULT_PORT}, 파이프 ${process.env.DOGENT_BRIDGE_PIPE ?? pipePath(userInfo().username)}`),
    () => process.exit(1),
  );
  // MCP stdio: 한 줄에 JSON-RPC 메시지 하나
  process.stdin.on(
    'data',
    lineReader(async (msg) => {
      const res = await hub.handleMcp(msg);
      if (res) process.stdout.write(`${JSON.stringify(res)}\n`);
    }),
  );
  process.stdin.on('end', () => {
    hub.close();
    process.exit(0);
  });
}
