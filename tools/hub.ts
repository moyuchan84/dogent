// Dogent Hub 서버 (최소안): 정책·중지 스위치를 내려 주고 실행 요약을 받는다.
//
//   HUB_TOKEN=... HUB_ADMIN_TOKEN=... node tools/hub.mjs --data <폴더> [--port 8790] [--host 127.0.0.1]
//
//   --data   상태를 둘 폴더 (state.json, runs.jsonl, audit.jsonl). 기본 ./hub-data
//   --host   받을 주소. 다른 PC에서 붙게 하려면 0.0.0.0 (앞단에 HTTPS 프록시를 둔다)
//   HUB_TOKEN        클라이언트용 토큰 (정책 읽기, 실행 요약 보내기)
//   HUB_ADMIN_TOKEN  관리용 토큰 (정책·중지 스위치 변경, 통계·감사 읽기)
//   두 토큰이 없으면 시작하지 않는다.
//
// GET /health 는 인증 없이 열려 있다. pnpm hub:bundle 로 한 파일(templates/dogent-hub/tools/hub.mjs)로 묶인다.
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { checkTokens, createHubHandler, FileStore } from './hub-core';

const argv = process.argv.slice(2);
const opt = (name: string) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
const log = (line: string) => process.stderr.write(`[${new Date().toISOString().slice(11, 19)}] ${line}\n`);

const problem = checkTokens(process.env.HUB_TOKEN, process.env.HUB_ADMIN_TOKEN);
if (problem) {
  log(problem);
  process.exit(2);
}
const dir = resolve(opt('data') ?? 'hub-data');
const port = Number(opt('port') ?? 8790);
const host = opt('host') ?? '127.0.0.1';
const store = new FileStore(dir);
const server = createServer(createHubHandler({ store, token: process.env.HUB_TOKEN!, adminToken: process.env.HUB_ADMIN_TOKEN!, log }));
server.listen(port, host, () => log(`Dogent Hub: http://${host}:${port}  데이터 ${dir}`));
