// 개발·테스트용 모의 사내 사이트. node로 바로 실행한다: node mock-site/server.mjs (엑셀 내려받기만 exceljs를 쓴다)
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { COLUMNS, generateWip } from './data.mjs';

/** 재공 조회 결과를 엑셀 파일로 만든다. 화면과 달리 수량과 정체시간은 숫자로 들어간다. */
export async function wipXlsx(line, step, product) {
  const { default: ExcelJS } = await import('exceljs');
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('재공');
  ws.addRow(COLUMNS);
  for (const r of generateWip(line, step)) {
    if (product && !r[1].includes(product)) continue;
    ws.addRow([r[0], r[1], r[2], Number(r[3].replace(/,/g, '')), r[4], Number(r[5])]);
  }
  return wb.xlsx.writeBuffer();
}

const PUBLIC = join(fileURLToPath(new URL('.', import.meta.url)), 'public');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css' };

export function createMockSite() {
  // 접수된 방화벽 신청. 테스트가 GET /api/fw 로 읽어 실제로 몇 건이 어떤 값으로 상신됐는지 확인한다.
  const fwLog = [];
  // 저장된 재공 수량 조정. 한 번의 저장이 행 배열 하나다.
  const adjustLog = [];
  // 접수된 홀드 해제 요청
  const holdLog = [];
  return createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname === '/api/adjust') {
      const json = (body) => {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(body));
      };
      if (req.method === 'POST') {
        let body = '';
        for await (const chunk of req) body += chunk;
        const rows = JSON.parse(body);
        adjustLog.push(rows);
        return json({ count: rows.length });
      }
      if (req.method === 'DELETE') adjustLog.length = 0;
      return json(adjustLog);
    }
    if (url.pathname === '/api/hold') {
      const json = (body) => {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(body));
      };
      if (req.method === 'POST') {
        let body = '';
        for await (const chunk of req) body += chunk;
        const entry = { id: `HR-${String(holdLog.length + 1).padStart(6, '0')}`, ...JSON.parse(body) };
        holdLog.push(entry);
        return json({ id: entry.id });
      }
      if (req.method === 'DELETE') holdLog.length = 0;
      return json(holdLog);
    }
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
    if (url.pathname === '/api/wip.xlsx') {
      const line = url.searchParams.get('line') ?? '';
      const body = await wipXlsx(line, url.searchParams.get('step') ?? '', url.searchParams.get('product') ?? '');
      res.writeHead(200, {
        'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(`재공_${line}.xlsx`)}`,
      });
      res.end(Buffer.from(body));
      return;
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
