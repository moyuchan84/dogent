// 공용 시스템 사전 MCP 서버. 사내 서버 한 곳에서 띄우고 모두가 같은 사전을 쓴다.
//
//   node tools/systems-mcp.mjs --root <사전 저장소> [--port 8787] [--host 127.0.0.1] [--pull 600] [--reports <파일>]
//   node tools/systems-mcp.mjs --root <사전 저장소> --stdio         (한 PC에서 시험할 때)
//
//   --host     받을 주소. 다른 PC에서 붙게 하려면 0.0.0.0
//   --pull     이 초마다 git pull --ff-only 로 저장소를 최신으로 (리뷰를 거쳐 main에 반영된 것만 나간다)
//   --reports  report_issue 신고를 쌓을 파일 (JSON 줄)
//   SYSTEMS_MCP_TOKEN 환경 변수를 주면 Authorization: Bearer <토큰> 이 있어야 받는다
//
// 전송: Streamable HTTP (POST /mcp, 답은 JSON). GET /health 로 판 번호와 개수를 본다.
// pnpm systems:bundle 로 한 파일(templates/dogent-systems/tools/systems-mcp.mjs)로 묶여 Node만 있으면 돈다.
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { SystemsMcp, type RpcMessage } from './systems-mcp-core';

const argv = process.argv.slice(2);
const opt = (name: string) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
const root = resolve(opt('root') ?? '.');
const stdio = argv.includes('--stdio');
// stdio에서는 stdout이 통신용이라 기록은 stderr로
const log = (line: string) => process.stderr.write(`[${new Date().toISOString().slice(11, 19)}] ${line}\n`);
const reports = opt('reports');
const mcp = new SystemsMcp({ root, reportsFile: reports ? resolve(reports) : undefined, log });

if (stdio) {
  createInterface({ input: process.stdin }).on('line', (line) => {
    if (!line.trim()) return;
    let msg: RpcMessage;
    try {
      msg = JSON.parse(line);
    } catch {
      process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'JSON이 아닙니다' } })}\n`);
      return;
    }
    const out = mcp.handle(msg);
    if (out) process.stdout.write(`${JSON.stringify(out)}\n`);
  });
} else {
  const port = Number(opt('port') ?? 8787);
  const host = opt('host') ?? '127.0.0.1';
  const token = process.env.SYSTEMS_MCP_TOKEN;
  const server = createServer((req, res) => {
    const path = (req.url ?? '/').split('?')[0];
    const send = (status: number, body?: unknown, headers: Record<string, string> = {}) => {
      res.writeHead(status, body === undefined ? headers : { 'content-type': 'application/json; charset=utf-8', ...headers });
      res.end(body === undefined ? undefined : JSON.stringify(body));
    };
    if (req.method === 'GET' && path === '/health') {
      const reg = mcp.registry();
      return send(200, { ok: true, version: reg.version, count: reg.systems.length, loaded_at: reg.loadedAt, errors: reg.problems.filter((p) => p.level === 'error').length });
    }
    if (path !== '/mcp' && path !== '/') return send(404, { error: '주소는 /mcp 입니다' });
    if (token && req.headers.authorization !== `Bearer ${token}`) return send(401, { error: '인증이 필요합니다 (Authorization: Bearer <토큰>)' });
    // 서버가 먼저 보내는 흐름(GET SSE)과 세션은 쓰지 않는다
    if (req.method === 'DELETE') return send(204);
    if (req.method !== 'POST') return send(405, { error: 'POST만 받습니다' }, { allow: 'POST' });
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (c: string) => {
      body += c;
      if (body.length > 1_000_000) req.destroy();
    });
    req.on('end', () => {
      let parsed: RpcMessage | RpcMessage[];
      try {
        parsed = JSON.parse(body);
      } catch {
        return send(400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'JSON이 아닙니다' } });
      }
      const list = Array.isArray(parsed) ? parsed : [parsed];
      const out = list.map((m) => mcp.handle(m)).filter((x) => x !== null);
      if (out.length === 0) return send(202);
      send(200, Array.isArray(parsed) ? out : out[0]);
    });
  });
  server.listen(port, host, () => log(`시스템 MCP 서버: http://${host}:${port}/mcp (사전: ${root})${token ? ' · 토큰 필요' : ''}`));

  const pull = Number(opt('pull') ?? 0);
  if (pull > 0) {
    const run = () =>
      execFile('git', ['-C', root, 'pull', '--ff-only', '--quiet'], { windowsHide: true }, (err, _out, stderr) => {
        if (err) log(`git pull 실패: ${(stderr || err.message).trim().split('\n')[0]}`);
        else mcp.registry();
      });
    setInterval(run, pull * 1000).unref();
    run();
  }
}
