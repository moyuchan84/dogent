// 로컬 Ollama를 Dogent에 붙이는 개발용 중계 서버. 실행: node tools/ollama-proxy.mjs
//
// 확장이 Ollama를 직접 부르지 않고 이 서버를 거치는 이유
// 1. Ollama는 Origin이 chrome-extension:// 인 요청을 403으로 거절한다 (OLLAMA_ORIGINS를 바꾸지 않는 한).
// 2. Ollama의 OpenAI 호환 API(/v1)는 컨텍스트 길이(num_ctx)를 요청마다 정할 수 없고 기본값이 작아서,
//    화면 스냅샷이 들어간 긴 프롬프트의 앞부분(지시문)이 소리 없이 잘린다.
// 그래서 OpenAI 형식으로 받아 Ollama 고유 API(/api/chat)로 num_ctx를 지정해 넘긴다.
//
// 환경 변수
//   PORT            듣는 포트 (기본 4174, 모의 모델 서버와 같아서 확장을 다시 빌드할 필요가 없다)
//   OLLAMA_URL      Ollama 주소 (기본 http://localhost:11434)
//   OLLAMA_MODEL    지정하면 요청의 model 값을 무시하고 이 모델을 쓴다
//   OLLAMA_NUM_CTX  컨텍스트 길이 (기본 8192)
//   OLLAMA_DEBUG    값이 있으면 모델 응답 원문도 출력한다
import { createServer } from 'node:http';
import { normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

export function createOllamaProxy({
  ollamaUrl = process.env.OLLAMA_URL ?? 'http://localhost:11434',
  model: forcedModel = process.env.OLLAMA_MODEL,
  numCtx = Number(process.env.OLLAMA_NUM_CTX ?? 8192),
  log = console.log,
} = {}) {
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
  };
  return createServer((req, res) => {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, cors).end();
      return;
    }
    if (req.method !== 'POST' || !req.url?.endsWith('/chat/completions')) {
      res.writeHead(404, cors).end();
      return;
    }
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', async () => {
      const fail = (status, message) => {
        log(`오류 ${status}: ${message}`);
        res.writeHead(status, { ...cors, 'Content-Type': 'text/plain; charset=utf-8' });
        res.end(message);
      };
      try {
        const input = JSON.parse(body);
        const model = forcedModel ?? input.model;
        const started = Date.now();
        const upstream = await fetch(`${ollamaUrl}/api/chat`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model,
            messages: input.messages,
            stream: false,
            ...(input.response_format?.type === 'json_object' ? { format: 'json' } : {}),
            options: {
              temperature: input.temperature ?? 0,
              num_ctx: numCtx,
              ...(input.max_tokens ? { num_predict: input.max_tokens } : {}),
            },
          }),
        });
        if (!upstream.ok) return fail(upstream.status, `Ollama(${model}): ${await upstream.text()}`);
        const out = await upstream.json();
        const promptTokens = out.prompt_eval_count ?? 0;
        const sec = ((Date.now() - started) / 1000).toFixed(1);
        const warn = promptTokens >= numCtx - 16 ? '  ← 컨텍스트가 가득 참. OLLAMA_NUM_CTX를 늘려야 함' : '';
        log(`${model}  입력 ${promptTokens}토큰  출력 ${out.eval_count ?? 0}토큰  ${sec}초${warn}`);
        if (process.env.OLLAMA_DEBUG) log(`  응답: ${(out.message?.content ?? '').replace(/\s+/g, ' ').slice(0, 400)}`);
        res.writeHead(200, { ...cors, 'Content-Type': 'application/json; charset=utf-8' });
        res.end(
          JSON.stringify({
            model,
            choices: [{ index: 0, message: { role: 'assistant', content: out.message?.content ?? '' } }],
            usage: { prompt_tokens: promptTokens, completion_tokens: out.eval_count ?? 0 },
          }),
        );
      } catch (e) {
        const hint = e?.cause?.code === 'ECONNREFUSED' ? ` (Ollama가 ${ollamaUrl} 에서 실행 중인지 확인)` : '';
        fail(502, `${e?.message ?? e}${hint}`);
      }
    });
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === normalize(process.argv[1])) {
  const port = Number(process.env.PORT ?? 4174);
  createOllamaProxy().listen(port, () => {
    console.log(`Ollama 중계: http://localhost:${port}/v1  →  ${process.env.OLLAMA_URL ?? 'http://localhost:11434'}`);
    console.log(`모델: ${process.env.OLLAMA_MODEL ?? '(패널 설정의 모델 이름 사용)'}, num_ctx: ${process.env.OLLAMA_NUM_CTX ?? 8192}`);
  });
}
