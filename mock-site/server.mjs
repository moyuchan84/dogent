// 개발·테스트용 모의 사내 사이트. 의존성 없이 node로 바로 실행한다: node mock-site/server.mjs
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { COLUMNS, generateWip } from './data.mjs';

const PUBLIC = join(fileURLToPath(new URL('.', import.meta.url)), 'public');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css' };

export function createMockSite() {
  // 접수된 방화벽 신청. 테스트가 GET /api/fw 로 읽어 실제로 몇 건이 어떤 값으로 상신됐는지 확인한다.
  const fwLog = [];
  return createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname === '/api/fw') {
      const json = (body) => {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(body));
      };
      if (req.method === 'POST') {
        let body = '';
        for await (const chunk of req) body += chunk;
        const entry = { id: `FW-${String(fwLog.length + 1).padStart(6, '0')}`, ...JSON.parse(body) };
        fwLog.push(entry);
        return json({ id: entry.id });
      }
      if (req.method === 'DELETE') fwLog.length = 0;
      return json(fwLog);
    }
    if (url.pathname === '/api/wip') {
      const rows = generateWip(url.searchParams.get('line') ?? '', url.searchParams.get('step') ?? '');
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ columns: COLUMNS, rows }));
      return;
    }
    const rel = normalize(url.pathname === '/' ? '/wip.html' : url.pathname);
    const file = join(PUBLIC, rel);
    if (!file.startsWith(PUBLIC)) {
      res.writeHead(403).end();
      return;
    }
    try {
      const body = await readFile(file);
      res.writeHead(200, { 'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream' });
      res.end(body);
    } catch {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('없는 페이지');
    }
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === normalize(process.argv[1])) {
  const port = Number(process.env.PORT ?? 4173);
  createMockSite().listen(port, () => console.log(`모의 사이트: http://localhost:${port}/wip.html`));
}
