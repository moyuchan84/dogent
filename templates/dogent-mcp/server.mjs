// 사내 MCP 서버 템플릿 (의존 패키지 없음, Node 20+).
//
//   node server.mjs                  stdio로 돈다 (Dogent가 이 PC에서 띄울 때)
//   node server.mjs --http 8800      HTTP로 돈다 (서버에 올려 여럿이 쓸 때. 주소 http://호스트:8800/mcp)
//
// 새 도구는 아래 TOOLS 배열에 하나 더하면 끝이다. 나머지(프로토콜, 인증, 입력 검사)는 건드리지 않는다.
//   - readOnly: true 인 도구는 Dogent가 기본으로 바로 부르고, 아니면 부르기 전에 사람에게 묻는다.
//   - inputSchema 의 required 항목이 빠지면 handler 를 부르기 전에 막는다.
//   - handler 는 글(또는 객체)을 돌려주고, 실패하면 throw 한다 (Dogent에는 isError 로 전달된다).
import { createServer } from 'node:http';
import { createInterface } from 'node:readline';
import { timingSafeEqual } from 'node:crypto';
import { pathToFileURL } from 'node:url';

/** 이 서버가 내놓는 도구들. 예시를 지우고 자기 것을 넣는다. */
const TOOLS = [
  {
    name: 'echo',
    description: '받은 글을 그대로 돌려준다 (연결 시험용)',
    readOnly: true,
    inputSchema: { type: 'object', properties: { text: { type: 'string', description: '돌려받을 글' } }, required: ['text'] },
    handler: async ({ text }) => text,
  },
  {
    name: 'lot_list',
    description: '라인의 재공 Lot 목록을 JSON 배열로 돌려준다 (예시: 가짜 자료)',
    readOnly: true,
    inputSchema: { type: 'object', properties: { line: { type: 'string', description: '라인 이름, 예: 7라인' } }, required: ['line'] },
    handler: async ({ line }) => [
      { lot: 'A1', line, product: 'DR5', qty: 1200 },
      { lot: 'A2', line, product: 'NV2', qty: 850 },
    ],
  },
  {
    name: 'lot_hold',
    description: 'Lot을 홀드한다 (예시: 바꾸는 도구. Dogent가 부르기 전에 사람에게 묻는다)',
    readOnly: false,
    inputSchema: { type: 'object', properties: { lot: { type: 'string' }, reason: { type: 'string' } }, required: ['lot', 'reason'] },
    handler: async ({ lot, reason }) => `${lot} 홀드함 (${reason})`,
  },
];

const SERVER_INFO = { name: process.env.MCP_NAME ?? 'dogent-mcp-template', version: '0.1.0' };
const PROTOCOL = '2025-06-18';

// ── 프로토콜 (건드리지 않는다) ──────────────────────────────────────────────

const listed = () => TOOLS.map(({ name, description, inputSchema, readOnly }) => ({ name, description, inputSchema, annotations: { readOnlyHint: !!readOnly } }));

function missingArgs(tool, args) {
  const required = tool.inputSchema?.required ?? [];
  return required.filter((k) => args[k] === undefined || args[k] === null || args[k] === '');
}

/** JSON-RPC 요청 하나를 처리해 응답(또는 알림이면 null)을 돌려준다 */
export async function handle(msg) {
  if (msg.id === undefined) return null; // 알림 (notifications/initialized 등)
  const ok = (result) => ({ jsonrpc: '2.0', id: msg.id, result });
  const fail = (code, message) => ({ jsonrpc: '2.0', id: msg.id, error: { code, message } });
  switch (msg.method) {
    case 'initialize':
      return ok({ protocolVersion: msg.params?.protocolVersion ?? PROTOCOL, capabilities: { tools: {} }, serverInfo: SERVER_INFO });
    case 'ping':
      return ok({});
    case 'tools/list':
      return ok({ tools: listed() });
    case 'tools/call': {
      const tool = TOOLS.find((t) => t.name === msg.params?.name);
      if (!tool) return fail(-32602, `알 수 없는 도구 ${msg.params?.name}`);
      const args = msg.params?.arguments ?? {};
      const missing = missingArgs(tool, args);
      if (missing.length) return ok({ isError: true, content: [{ type: 'text', text: `필수 입력이 없습니다: ${missing.join(', ')}` }] });
      try {
        const out = await tool.handler(args);
        return ok({ content: [{ type: 'text', text: typeof out === 'string' ? out : JSON.stringify(out) }] });
      } catch (e) {
        return ok({ isError: true, content: [{ type: 'text', text: e instanceof Error ? e.message : String(e) }] });
      }
    }
    default:
      return fail(-32601, `method not found: ${msg.method}`);
  }
}

function serveStdio() {
  createInterface({ input: process.stdin }).on('line', async (line) => {
    if (!line.trim()) return;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    const res = await handle(msg);
    if (res) process.stdout.write(`${JSON.stringify(res)}\n`);
  });
}

function safeEqual(a, b) {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

function serveHttp(port) {
  // MCP_TOKEN 이 있으면 Authorization: Bearer <MCP_TOKEN> 이 맞는 요청만 받는다. 서버에 올릴 때는 반드시 정한다.
  const token = process.env.MCP_TOKEN;
  if (!token) console.error('경고: MCP_TOKEN 이 없어 누구나 부를 수 있습니다. 서버에 올릴 때는 MCP_TOKEN 을 정하세요');
  createServer(async (req, res) => {
    const send = (code, body, type = 'application/json') => {
      res.writeHead(code, { 'content-type': type });
      res.end(typeof body === 'string' ? body : JSON.stringify(body));
    };
    if (req.url === '/health') return send(200, 'ok', 'text/plain');
    if (req.url?.split('?')[0] !== '/mcp') return send(404, { error: 'not found' });
    if (token && !safeEqual(req.headers.authorization ?? '', `Bearer ${token}`)) return send(401, { error: 'unauthorized' });
    if (req.method !== 'POST') return send(405, { error: 'POST only' });
    let body = '';
    for await (const chunk of req) {
      body += chunk;
      if (body.length > 1_000_000) return send(413, { error: 'too large' });
    }
    let msg;
    try {
      msg = JSON.parse(body);
    } catch {
      return send(400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } });
    }
    const out = Array.isArray(msg) ? (await Promise.all(msg.map(handle))).filter(Boolean) : await handle(msg);
    if (!out || (Array.isArray(out) && !out.length)) return send(202, '');
    send(200, out);
  }).listen(port, () => console.error(`MCP 서버: http://0.0.0.0:${port}/mcp`));
}

const httpAt = process.argv.indexOf('--http');
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (httpAt >= 0) serveHttp(Number(process.argv[httpAt + 1]) || 8800);
  else serveStdio();
}
