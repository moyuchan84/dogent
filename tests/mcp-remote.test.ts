import { mkdtempSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { connectRemote, HttpMcp, SseMcp } from '../client/src/mcp-http';
import { describeInstall, normalizeServers, parseMcpAdd } from '../client/src/mcp-install';
import { McpHub, loadMcpConfig } from '../client/src/mcp-hub';

const TOOLS = [
  { name: 'lot_list', description: '재공 Lot 목록', inputSchema: { type: 'object', properties: { line: { type: 'string' } }, required: ['line'] }, annotations: { readOnlyHint: true } },
  { name: 'lot_hold', description: 'Lot 홀드', inputSchema: { type: 'object', properties: { lot: { type: 'string' } }, required: ['lot'] } },
];

type Mode = 'json' | 'sse';
interface Fake {
  url: string;
  server: Server;
  /** 받은 요청의 헤더와 본문 */
  seen: { method: string; headers: IncomingMessage['headers']; body?: { method?: string; id?: number } }[];
}

const servers: Server[] = [];
afterEach(() => {
  for (const s of servers.splice(0)) {
    s.closeAllConnections();
    s.close();
  }
});

const listen = (server: Server): Promise<string> =>
  new Promise((resolve) => {
    servers.push(server);
    server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`));
  });

const readBody = (req: IncomingMessage) =>
  new Promise<string>((resolve) => {
    let text = '';
    req.on('data', (c) => (text += c));
    req.on('end', () => resolve(text));
  });

/** JSON-RPC 요청 하나에 대한 결과 */
function rpc(msg: { method: string; params?: { name?: string; arguments?: Record<string, unknown> } }): unknown {
  if (msg.method === 'initialize') return { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'fake', version: '1' } };
  if (msg.method === 'tools/list') return { tools: TOOLS };
  if (msg.method === 'tools/call') {
    const args = msg.params?.arguments ?? {};
    return msg.params?.name === 'lot_list'
      ? { content: [{ type: 'text', text: JSON.stringify([{ lot: 'A1', line: args.line }]) }] }
      : { content: [{ type: 'text', text: `${args.lot} 홀드함` }, { type: 'image', data: 'x' }], isError: false };
  }
  return {};
}

/** Streamable HTTP 서버. token을 주면 Authorization: Bearer <token>이 있어야 한다. */
async function streamable(mode: Mode, opts: { token?: string; path?: string } = {}): Promise<Fake> {
  const seen: Fake['seen'] = [];
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const text = await readBody(req);
    const body = text ? (JSON.parse(text) as { method?: string; id?: number }) : undefined;
    seen.push({ method: req.method ?? '', headers: req.headers, body });
    if (req.url !== (opts.path ?? '/mcp')) return res.writeHead(404).end('not found');
    if (opts.token && req.headers.authorization !== `Bearer ${opts.token}`) return res.writeHead(401).end('token required');
    if (req.method === 'DELETE') return res.writeHead(200).end();
    if (req.method !== 'POST' || !body) return res.writeHead(405).end();
    if (body.id === undefined) return res.writeHead(202).end();
    const result = rpc(body as never);
    const reply = JSON.stringify({ jsonrpc: '2.0', id: body.id, result });
    const headers: Record<string, string> = body.method === 'initialize' ? { 'mcp-session-id': 'sess-1' } : {};
    if (mode === 'json') return res.writeHead(200, { ...headers, 'content-type': 'application/json' }).end(reply);
    // SSE: 답 앞에 상관없는 알림을 하나 보내 건너뛰는지 본다
    res.writeHead(200, { ...headers, 'content-type': 'text/event-stream' });
    res.write(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/message', params: {} })}\n\n`);
    res.write(`event: message\ndata: ${reply}\n\n`);
    res.end();
  });
  return { url: `${await listen(server)}${opts.path ?? '/mcp'}`, server, seen };
}

/** 옛 SSE 방식 서버: GET /sse 로 흐름을 열고, POST /messages 로 요청을 받아 흐름으로 답한다. */
async function legacySse(): Promise<Fake> {
  const seen: Fake['seen'] = [];
  let stream: ServerResponse | null = null;
  const server = createServer(async (req, res) => {
    if (req.method === 'GET' && req.url === '/sse') {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('event: endpoint\ndata: /messages?sid=1\n\n');
      stream = res;
      return;
    }
    if (req.method === 'POST' && req.url?.startsWith('/messages')) {
      const body = JSON.parse(await readBody(req)) as { method: string; id?: number };
      seen.push({ method: 'POST', headers: req.headers, body });
      res.writeHead(202).end('Accepted');
      if (body.id !== undefined) stream?.write(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: body.id, result: rpc(body as never) })}\n\n`);
      return;
    }
    res.writeHead(404).end();
  });
  return { url: `${await listen(server)}/sse`, server, seen };
}

describe('claude mcp add 문법 읽기 (parseMcpAdd)', () => {
  it('원격: 이름 + 주소, --transport http, --scope user', () => {
    const p = parseMcpAdd(['--transport', 'http', '--scope', 'user', 'github-mcp', 'http://ssai.samsungds.net:9999/mcp']);
    expect(p).toMatchObject({ name: 'github-mcp', scope: 'user', spec: { url: 'http://ssai.samsungds.net:9999/mcp', transport: 'http' } });
  });

  it('옵션은 이름 뒤에 와도 되고, transport가 없으면 http', () => {
    const p = parseMcpAdd(['github-mcp', 'https://h/mcp', '-s', 'user']);
    expect(p.spec).toEqual({ url: 'https://h/mcp', transport: 'http' });
  });

  it('sse와 헤더(여러 개, 이름: 값 / 이름=값)', () => {
    const p = parseMcpAdd(['--transport=sse', '-H', 'Authorization: Bearer ${TOKEN}', '--header', 'X-Team=ds', 'n', 'https://h/sse']);
    expect(p.spec).toEqual({ url: 'https://h/sse', transport: 'sse', headers: { Authorization: 'Bearer ${TOKEN}', 'X-Team': 'ds' } });
  });

  it('stdio: -- 뒤가 명령, -e로 환경 변수 (여러 개 이어 적어도 됨)', () => {
    const p = parseMcpAdd(['-e', 'A=1', 'B=2', 'mes', '--', 'npx', '-y', '@회사/mes-mcp']);
    expect(p.name).toBe('mes');
    expect(p.spec).toEqual({ command: 'npx', args: ['-y', '@회사/mes-mcp'], env: { A: '1', B: '2' } });
  });

  it('옛 방식 dogent mcp add <이름> <실행 파일> [인자]도 받는다 (-y 같은 인자도 서버로 넘어감)', () => {
    expect(parseMcpAdd(['mes', 'node', 'C:\\tools\\mes-mcp.mjs']).spec).toEqual({ command: 'node', args: ['C:\\tools\\mes-mcp.mjs'] });
    expect(parseMcpAdd(['x', 'npx', '-y', 'pkg']).spec).toEqual({ command: 'npx', args: ['-y', 'pkg'] });
  });

  it('--yes, --no-test를 읽는다', () => {
    expect(parseMcpAdd(['a', 'http://h/mcp', '--yes', '--no-test'])).toMatchObject({ yes: true, noTest: true });
    expect(parseMcpAdd(['a', 'http://h/mcp'])).toMatchObject({ yes: false, noTest: false });
  });

  it('잘못된 입력은 이유와 함께 거절한다', () => {
    expect(() => parseMcpAdd([])).toThrow('서버 이름');
    expect(() => parseMcpAdd(['bad name!', 'http://h/mcp'])).toThrow('서버 이름은');
    expect(() => parseMcpAdd(['--transport', 'http', 'n'])).toThrow('주소가 필요');
    expect(() => parseMcpAdd(['--transport', 'carrier-pigeon', 'n', 'http://h'])).toThrow('--transport');
    expect(() => parseMcpAdd(['n'])).toThrow('주소(http://…) 또는 실행 명령');
    expect(() => parseMcpAdd(['-H', 'A: b', 'n', '--', 'node'])).toThrow('원격');
    expect(() => parseMcpAdd(['--bogus', 'n', 'http://h'])).toThrow('알 수 없는 옵션');
  });
});

describe('다른 도구의 MCP 설정 가져오기 (normalizeServers)', () => {
  it('Claude Code / Cursor: mcpServers', () => {
    const got = normalizeServers({
      mcpServers: {
        mes: { command: 'npx', args: ['-y', 'pkg'], env: { KEY: 'v' } },
        gh: { type: 'http', url: 'http://h/mcp', headers: { Authorization: 'Bearer x' } },
        old: { type: 'sse', url: 'http://h/sse' },
      },
    });
    expect(got.mes).toEqual({ command: 'npx', args: ['-y', 'pkg'], env: { KEY: 'v' } });
    expect(got.gh).toEqual({ url: 'http://h/mcp', transport: 'http', headers: { Authorization: 'Bearer x' } });
    expect(got.old).toEqual({ url: 'http://h/sse', transport: 'sse' });
  });

  it('VS Code: servers + type, Windsurf: serverUrl', () => {
    expect(normalizeServers({ servers: { a: { type: 'stdio', command: 'node', args: ['s.js'] } } }).a).toEqual({ command: 'node', args: ['s.js'] });
    expect(normalizeServers({ mcpServers: { w: { serverUrl: 'https://h/mcp' } } }).w).toMatchObject({ url: 'https://h/mcp' });
  });

  it('opencode: mcp + remote/local, command 배열, environment, enabled', () => {
    const got = normalizeServers({
      mcp: {
        r: { type: 'remote', url: 'https://h/mcp', headers: { A: 'b' }, enabled: false },
        l: { type: 'local', command: ['npx', '-y', 'pkg'], environment: { K: 'v' } },
      },
    });
    expect(got.r).toEqual({ url: 'https://h/mcp', transport: 'http', headers: { A: 'b' }, disabled: true });
    expect(got.l).toEqual({ command: 'npx', args: ['-y', 'pkg'], env: { K: 'v' } });
  });

  it('서버 하나만 적은 객체는 이름을 받아 쓰고, 이름 → 서버 객체도 받는다', () => {
    expect(normalizeServers({ type: 'http', url: 'http://h/mcp' }, 'one').one).toMatchObject({ url: 'http://h/mcp' });
    expect(() => normalizeServers({ type: 'http', url: 'http://h/mcp' })).toThrow('이름이 필요');
    expect(Object.keys(normalizeServers({ a: { command: 'x' }, b: { url: 'http://h' } }))).toEqual(['a', 'b']);
  });

  it('Dogent 설정의 권한·키워드·꺼짐은 보존한다', () => {
    const spec = { command: 'node', permissions: { '*': 'ask', lot_list: 'allow' }, keywords: ['MES'], disabled: true };
    expect(normalizeServers({ servers: { mes: spec } }).mes).toEqual(spec);
    expect(normalizeServers({})).toEqual({});
  });

  it('못 읽는 설정은 이유를 말한다', () => {
    expect(() => normalizeServers({ mcpServers: { a: { url: 'ftp://h' } } })).toThrow('http://');
    expect(() => normalizeServers({ mcpServers: { a: {} } })).toThrow('command');
    expect(() => normalizeServers({ foo: 1 })).toThrow('서버 목록');
    expect(() => normalizeServers([] as never)).toThrow('JSON 객체');
    // 일부만 틀리면 어디가 틀렸는지 알려 준다 (조용히 빼지 않는다)
    expect(() => normalizeServers({ mcpServers: { ok: { command: 'x' }, bad: { url: 'nope' } } })).toThrow('bad');
  });

  it('설치 전 안내는 실행될 명령과 보낼 주소를 그대로 적는다', () => {
    expect(describeInstall('mes', { command: 'npx', args: ['-y', 'pkg'], env: { KEY: 'v' } }).join('\n')).toMatch(/이 PC에서 실행[\s\S]*npx -y pkg[\s\S]*KEY/);
    expect(describeInstall('gh', { url: 'http://h/mcp', transport: 'http', headers: { Authorization: 'x' } }).join('\n')).toMatch(/원격[\s\S]*http:\/\/h\/mcp[\s\S]*Authorization/);
  });
});

describe('원격 MCP 서버에 붙기', () => {
  for (const mode of ['json', 'sse'] as const) {
    it(`Streamable HTTP (답이 ${mode === 'json' ? 'JSON' : 'SSE 흐름'}): 도구 목록과 부르기, 세션 유지`, async () => {
      const fake = await streamable(mode);
      const mcp = await HttpMcp.start(fake.url, { name: 'mes' });
      expect((await mcp.listTools()).map((t) => t.name)).toEqual(['lot_list', 'lot_hold']);
      const r = await mcp.callText('lot_list', { line: '7라인' });
      expect(JSON.parse(r.text)).toEqual([{ lot: 'A1', line: '7라인' }]);
      expect(r.isError).toBe(false);
      // 글이 아닌 내용은 개수만 알린다
      expect((await mcp.callText('lot_hold', { lot: 'A1' })).text).toBe('A1 홀드함\n(글이 아닌 내용 1개는 받지 않았습니다)');
      // 초기화 뒤의 요청에는 세션과 프로토콜 버전이 실린다
      const later = fake.seen.filter((s) => s.method === 'POST' && s.body?.method === 'tools/list');
      expect(later[0].headers['mcp-session-id']).toBe('sess-1');
      expect(later[0].headers['mcp-protocol-version']).toBe('2025-06-18');
      expect(fake.seen.some((s) => s.body?.method === 'notifications/initialized')).toBe(true);
      await mcp.close();
      expect(fake.seen.at(-1)?.method).toBe('DELETE');
    });
  }

  it('Authorization 헤더를 보낸다. 없거나 틀리면 고치는 방법을 알려 준다', async () => {
    const fake = await streamable('json', { token: 'sekret' });
    await expect(HttpMcp.start(fake.url, { name: 'gh' })).rejects.toThrow(/gh: HTTP 401[\s\S]*headers[\s\S]*Authorization/);
    const mcp = await HttpMcp.start(fake.url, { name: 'gh', headers: { Authorization: 'Bearer sekret' } });
    expect((await mcp.listTools()).length).toBe(2);
  });

  it('주소가 MCP 서버가 아니면(404) 방식 문제라고 알려 주고, 닿지 않으면 이름과 이유를 말한다', async () => {
    const fake = await streamable('json');
    await expect(HttpMcp.start(`${fake.url}/nope`, { name: 'x' })).rejects.toThrow(/x: HTTP 404.*transport/);
    await expect(HttpMcp.start('http://127.0.0.1:1/mcp', { name: 'down' })).rejects.toThrow(/down에 닿지 못했습니다/);
  });

  it('옛 SSE 방식: endpoint를 받아 POST하고 답은 흐름으로 온다', async () => {
    const fake = await legacySse();
    const mcp = await SseMcp.start(fake.url, { name: 'old', headers: { 'x-team': 'ds' } });
    expect((await mcp.listTools()).map((t) => t.name)).toEqual(['lot_list', 'lot_hold']);
    expect(JSON.parse((await mcp.callText('lot_list', { line: 'L' })).text)[0].line).toBe('L');
    expect(fake.seen[0].headers['x-team']).toBe('ds');
    await mcp.close();
  });

  it('transport를 안 주면 HTTP를 먼저 하고, 405/404면 SSE로 다시 붙는다', async () => {
    const fake = await legacySse();
    const mcp = await connectRemote(fake.url, undefined, { name: 'auto' });
    expect(mcp).toBeInstanceOf(SseMcp);
    expect((await mcp.listTools()).length).toBe(2);
    await mcp.close();
    // 인증 오류는 SSE로 넘어가지 않고 그대로 알린다
    const secured = await streamable('json', { token: 't' });
    await expect(connectRemote(secured.url, undefined, { name: 's' })).rejects.toThrow('HTTP 401');
    // transport를 못 박으면 넘어가지 않는다
    await expect(connectRemote(fake.url, 'http', { name: 'strict' })).rejects.toThrow(/HTTP (404|405)/);
  });
});

describe('McpHub: 원격 서버', () => {
  it('url 설정으로 도구를 모으고 부른다. 헤더의 ${환경변수}는 이 PC 값으로 채운다', async () => {
    const fake = await streamable('sse', { token: 'from-env' });
    process.env.DOGENT_TEST_TOKEN = 'from-env';
    const hub = await McpHub.open({
      servers: {
        mes: { url: fake.url, transport: 'http', headers: { Authorization: 'Bearer ${DOGENT_TEST_TOKEN}' } },
        broken: { url: 'http://127.0.0.1:1/mcp' },
        empty: {},
      },
    });
    try {
      expect(hub.list().map((t) => [t.name, t.readOnly, t.permission])).toEqual([
        ['mes.lot_hold', false, 'ask'],
        ['mes.lot_list', true, 'allow'],
      ]);
      expect(JSON.parse((await hub.call('mes.lot_list', { line: '8라인' })).text)[0].line).toBe('8라인');
      // 안 뜬 서버는 이유와 함께 남고, 나머지는 쓴다
      expect(hub.failed.map((f) => f.server).sort()).toEqual(['broken', 'empty']);
      expect(hub.failed.find((f) => f.server === 'empty')?.reason).toContain('command');
    } finally {
      await hub.close();
      delete process.env.DOGENT_TEST_TOKEN;
    }
  });

  it('mcp.json은 Claude 형식(mcpServers)도 읽고, Dogent 형식의 권한·키워드를 잃지 않는다', () => {
    const home = mkdtempSync(join(tmpdir(), 'dogent-mcp-'));
    const prev = process.env.DOGENT_HOME;
    process.env.DOGENT_HOME = home;
    try {
      writeFileSync(join(home, 'mcp.json'), JSON.stringify({ servers: { mes: { url: 'http://h/mcp', permissions: { lot_hold: 'deny' }, keywords: ['MES'] } } }));
      expect(loadMcpConfig().servers.mes).toEqual({ url: 'http://h/mcp', transport: 'http', permissions: { lot_hold: 'deny' }, keywords: ['MES'] });
      writeFileSync(join(home, 'mcp.json'), JSON.stringify({ mcpServers: { gh: { type: 'http', url: 'http://h/mcp' } } }));
      expect(loadMcpConfig().servers.gh.url).toBe('http://h/mcp');
    } finally {
      if (prev === undefined) delete process.env.DOGENT_HOME;
      else process.env.DOGENT_HOME = prev;
    }
  });
});
