// 시험용 MCP 서버 (stdio). 사내 MES 흉내: 읽기 도구 하나(lot_list)와 바꾸는 도구 하나(lot_hold).
// MOCK_MCP_LOG 환경 변수에 파일을 주면 도구를 부를 때마다 한 줄씩 적는다.
import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const LOTS = [
  { lot: 'A1', product: 'DR5', qty: 1200, status: 'RUN' },
  { lot: 'A2', product: 'NV2', qty: 850, status: 'HOLD' },
  { lot: 'A3', product: 'DR5', qty: 40, status: 'RUN' },
];

const TOOLS = [
  {
    name: 'lot_list',
    description: '라인의 재공 Lot 목록을 JSON 배열로 돌려준다',
    inputSchema: { type: 'object', properties: { line: { type: 'string', description: '라인 이름' } }, required: ['line'] },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'lot_hold',
    description: 'Lot을 홀드한다',
    inputSchema: { type: 'object', properties: { lot: { type: 'string' }, reason: { type: 'string' } }, required: ['lot'] },
  },
];

const send = (msg) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...msg })}\n`);

createInterface({ input: process.stdin }).on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.id === undefined) return;
  if (msg.method === 'initialize') {
    return send({ id: msg.id, result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'mock-mes', version: '0.0.1' } } });
  }
  if (msg.method === 'tools/list') return send({ id: msg.id, result: { tools: TOOLS } });
  if (msg.method === 'tools/call') {
    const { name, arguments: args = {} } = msg.params;
    if (process.env.MOCK_MCP_LOG) appendFileSync(process.env.MOCK_MCP_LOG, `${name} ${JSON.stringify(args)}\n`);
    if (name === 'lot_list') return send({ id: msg.id, result: { content: [{ type: 'text', text: JSON.stringify(LOTS) }] } });
    if (name === 'lot_hold') {
      return send({ id: msg.id, result: { content: [{ type: 'text', text: `${args.lot} 홀드함` }], isError: !LOTS.some((l) => l.lot === args.lot) } });
    }
    return send({ id: msg.id, error: { code: -32602, message: `알 수 없는 도구 ${name}` } });
  }
  send({ id: msg.id, error: { code: -32601, message: 'method not found' } });
});
