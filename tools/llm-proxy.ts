// LLM 프록시: Dogent 클라이언트의 OpenAI 호환 요청(POST …/chat/completions)을 사내 Gemma 게이트웨이로 그대로 전달한다.
// 업스트림 주소·키·헤더 틀은 서버 환경 변수에만 있고 클라이언트에는 키가 없다.
//
//   LLM_UPSTREAM_URL=https://게이트웨이/v1 LLM_UPSTREAM_KEY=... node tools/llm-proxy.mjs --tokens tokens.json [--port 8791] [--host 127.0.0.1] [--rate 60] [--audit llm-audit.jsonl]
//
//   --tokens   개인 토큰 표(JSON). { "토큰": "userId" } 또는 { "토큰": { "userId": "hong", "userType": "employee" } }
//   --rate     사용자당 분당 요청 수 (기본 0 = 제한 없음)
//   --audit    감사 기록(JSONL). 사용자·시각·모델·상태·지연·토큰 수만 남기고 프롬프트·응답 내용은 남기지 않는다
//   LLM_UPSTREAM_URL      업스트림 기본 주소 (필수). 여기에 /chat/completions 를 붙여 보낸다
//   LLM_UPSTREAM_KEY      업스트림 키 (헤더 틀의 {key})
//   LLM_UPSTREAM_HEADERS  헤더 틀(JSON). 자리표시자 {key} {userId} {userType} {systemName} {uuid} (wxt의 WXT_LLM_HEADERS와 같은 뜻)
//   LLM_SYSTEM_NAME       헤더 틀의 {systemName}
//   LLM_DEFAULT_USER_TYPE 토큰 표에 userType이 없을 때 쓸 값
//   LLM_TIMEOUT_SEC       업스트림 응답 헤더를 기다리는 시간 (기본 120)
//
// GET /health 는 인증 없이 열려 있다. pnpm hub:bundle 로 한 파일(templates/dogent-hub/tools/llm-proxy.mjs)로 묶인다.
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { createProxyHandler, TokenTable } from './llm-proxy-core';

const argv = process.argv.slice(2);
const opt = (name: string) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
const log = (line: string) => process.stderr.write(`[${new Date().toISOString().slice(11, 19)}] ${line}\n`);
const die = (msg: string): never => {
  log(msg);
  process.exit(2);
};

const upstream = process.env.LLM_UPSTREAM_URL;
if (!upstream) die('LLM_UPSTREAM_URL 환경 변수(사내 게이트웨이 주소)가 필요합니다');
const tokensFile = opt('tokens');
if (!tokensFile) die('--tokens <토큰 표 JSON 파일> 이 필요합니다 (토큰이 없으면 아무도 쓸 수 없고, 표 없이 열어 두지는 않습니다)');
let headers: Record<string, string> | undefined;
try {
  headers = process.env.LLM_UPSTREAM_HEADERS ? (JSON.parse(process.env.LLM_UPSTREAM_HEADERS) as Record<string, string>) : undefined;
} catch (e) {
  die(`LLM_UPSTREAM_HEADERS가 JSON이 아닙니다: ${(e as Error).message}`);
}
let tokens: TokenTable | undefined;
try {
  tokens = new TokenTable(resolve(tokensFile!));
} catch (e) {
  die((e as Error).message);
}

const port = Number(opt('port') ?? 8791);
const host = opt('host') ?? '127.0.0.1';
const handler = createProxyHandler({
  upstream: upstream!,
  upstreamKey: process.env.LLM_UPSTREAM_KEY,
  headers,
  systemName: process.env.LLM_SYSTEM_NAME,
  defaultUserType: process.env.LLM_DEFAULT_USER_TYPE,
  tokens: tokens!,
  perMinute: Number(opt('rate') ?? 0),
  auditFile: opt('audit') ? resolve(opt('audit')!) : undefined,
  timeoutMs: (Number(process.env.LLM_TIMEOUT_SEC) || 120) * 1000,
  log,
});
createServer((req, res) => void handler(req, res).catch((e) => (log(`오류: ${(e as Error).message}`), res.headersSent ? res.end() : res.writeHead(500).end()))).listen(port, host, () =>
  log(`LLM 프록시: http://${host}:${port}/v1/chat/completions → ${upstream}  사용자 ${tokens!.size}명`),
);
