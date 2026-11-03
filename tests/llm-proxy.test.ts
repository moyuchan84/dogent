import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createProxyHandler, RateLimiter, TokenTable, usageFromTail } from '../tools/llm-proxy-core';

const TEMPLATE = { 'x-dep-ticket': '{key}', 'Send-System-Name': '{systemName}', 'user-id': '{userId}', 'user-type': '{userType}', 'prompt-msg-id': '{uuid}', 'content-type': 'application/json' };
const SECRET_PROMPT = '비밀 프롬프트 내용 12345';
const SECRET_REPLY = '비밀 응답 내용 67890';
const sha = (s: string) => createHash('sha256').update(s).digest('hex');

let dir = '';
let upstream: Server;
let upstreamUrl = '';
let proxy: Server;
let proxyUrl = '';
let mode: 'ok' | 'stream' | '429' | '500' = 'ok';
const seen: { headers: IncomingHttpHeaders; body: string; url?: string }[] = [];
let perMinute = 0;
let auditFile = '';

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'dogent-proxy-'));
  auditFile = join(dir, 'audit.jsonl');
  writeFileSync(join(dir, 'tokens.json'), JSON.stringify({ tokens: { 'tok-hong': { userId: 'hong', userType: 'employee' }, 'tok-kim': 'kim', [sha('tok-hashed')]: { userId: 'park' } } }));

  upstream = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      seen.push({ headers: req.headers, body, url: req.url });
      if (mode === '429') return void res.writeHead(429, { 'retry-after': '7', 'content-type': 'application/json' }).end('{"error":"busy"}');
      if (mode === '500') return void res.writeHead(503, { 'content-type': 'application/json' }).end('{"error":"down"}');
      if (mode === 'stream') {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write(`data: {"choices":[{"delta":{"content":"${SECRET_REPLY.slice(0, 5)}"}}]}\n\n`);
        setTimeout(() => {
          res.write(`data: {"choices":[{"delta":{"content":"${SECRET_REPLY.slice(5)}"}}],"usage":{"prompt_tokens":11,"completion_tokens":22,"total_tokens":33}}\n\n`);
          res.end('data: [DONE]\n\n');
        }, 30);
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ choices: [{ message: { content: SECRET_REPLY } }], usage: { prompt_tokens: 5, completion_tokens: 6, total_tokens: 11 } }));
    });
  });
  await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', r));
  upstreamUrl = `http://127.0.0.1:${(upstream.address() as { port: number }).port}/gw/v1`;
  await startProxy();
});

let handlerHolder: ReturnType<typeof createProxyHandler>;
function startProxy(upstreamOverride?: string) {
  proxy?.close();
  handlerHolder = createProxyHandler({
    upstream: upstreamOverride ?? upstreamUrl,
    upstreamKey: 'UPSTREAM-KEY',
    headers: TEMPLATE,
    systemName: 'dogent',
    defaultUserType: 'guest',
    tokens: new TokenTable(join(dir, 'tokens.json')),
    perMinute,
    auditFile,
    timeoutMs: 3000,
  });
  proxy = createServer((req, res) => void handlerHolder(req, res));
  return new Promise<void>((r) =>
    proxy.listen(0, '127.0.0.1', () => {
      proxyUrl = `http://127.0.0.1:${(proxy.address() as { port: number }).port}`;
      r();
    }),
  );
}
afterAll(() => {
  proxy.close();
  upstream.close();
});

const chat = (token: string | undefined, extra: Record<string, unknown> = {}) =>
  fetch(`${proxyUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify({ model: 'gemma', messages: [{ role: 'user', content: SECRET_PROMPT }], ...extra }),
  });
const auditLines = () => readFileSync(auditFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));

describe('LLM 프록시', () => {
  it('개인 토큰으로 사용자를 정해 헤더 틀을 채워 업스트림으로 그대로 전달한다', async () => {
    mode = 'ok';
    seen.length = 0;
    const res = await chat('tok-hong');
    expect(res.status).toBe(200);
    expect((await res.json()).choices[0].message.content).toBe(SECRET_REPLY);
    const up = seen[0];
    expect(up.url).toBe('/gw/v1/chat/completions');
    expect(up.headers['x-dep-ticket']).toBe('UPSTREAM-KEY');
    expect(up.headers['user-id']).toBe('hong');
    expect(up.headers['user-type']).toBe('employee');
    expect(up.headers['send-system-name']).toBe('dogent');
    expect(up.headers['prompt-msg-id']).toMatch(/^[0-9a-f-]{36}$/);
    // 클라이언트의 개인 토큰은 업스트림으로 가지 않는다
    expect(JSON.stringify(up.headers)).not.toContain('tok-hong');
    expect(JSON.parse(up.body).messages[0].content).toBe(SECRET_PROMPT);
  });

  it('토큰 표에 userType이 없으면 기본값을 쓰고, 해시로 적은 토큰도 인식한다', async () => {
    seen.length = 0;
    await chat('tok-kim');
    expect(seen[0].headers['user-id']).toBe('kim');
    expect(seen[0].headers['user-type']).toBe('guest');
    await chat('tok-hashed');
    expect(seen[1].headers['user-id']).toBe('park');
  });

  it('토큰이 없거나 표에 없으면 401이고 업스트림에는 가지 않는다', async () => {
    seen.length = 0;
    expect((await chat(undefined)).status).toBe(401);
    expect((await chat('who-is-this')).status).toBe(401);
    expect(seen).toHaveLength(0);
  });

  it('토큰 표 파일을 고치면 재시작 없이 반영된다', async () => {
    const before = (await chat('tok-new')).status;
    expect(before).toBe(401);
    await new Promise((r) => setTimeout(r, 20));
    writeFileSync(join(dir, 'tokens.json'), JSON.stringify({ 'tok-hong': 'hong', 'tok-new': 'newbie' }));
    const future = new Date(Date.now() + 5000);
    (await import('node:fs')).utimesSync(join(dir, 'tokens.json'), future, future);
    expect((await chat('tok-new')).status).toBe(200);
  });

  it('스트리밍 응답을 그대로 흘려 보낸다', async () => {
    mode = 'stream';
    const res = await chat('tok-hong', { stream: true });
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const text = await res.text();
    expect(text).toContain('data: [DONE]');
    expect(text).toContain(SECRET_REPLY.slice(0, 5));
    mode = 'ok';
  });

  it('업스트림의 429·5xx는 Retry-After와 함께 그대로 돌려준다', async () => {
    mode = '429';
    const r = await chat('tok-hong');
    expect(r.status).toBe(429);
    expect(r.headers.get('retry-after')).toBe('7');
    mode = '500';
    expect((await chat('tok-hong')).status).toBe(503);
    mode = 'ok';
  });

  it('감사 기록에는 프롬프트·응답 내용·토큰 원문이 없고 사용자·모델·상태·지연·토큰 수만 있다', async () => {
    const text = readFileSync(auditFile, 'utf8');
    expect(text).not.toContain(SECRET_PROMPT);
    expect(text).not.toContain(SECRET_REPLY);
    expect(text).not.toContain('UPSTREAM-KEY');
    expect(text).not.toContain('tok-hong');
    const lines = auditLines();
    const ok = lines.find((l) => l.userId === 'hong' && l.status === 200 && l.tokens?.total === 11)!;
    expect(ok).toMatchObject({ model: 'gemma', stream: false, outcome: 'ok', tokens: { prompt: 5, completion: 6, total: 11 } });
    expect(typeof ok.ms).toBe('number');
    expect(Object.keys(ok).sort()).toEqual(['at', 'model', 'ms', 'outcome', 'status', 'stream', 'tokens', 'userId']);
    expect(lines.find((l) => l.stream === true && l.tokens?.total === 33)).toBeTruthy();
    expect(lines.find((l) => l.status === 429)?.outcome).toBe('upstream_error');
    expect(lines.find((l) => l.outcome === 'unauthorized')?.userId).toBe('-');
  });

  it('업스트림이 안 닿으면 502로 분명히 알린다', async () => {
    await startProxy('http://127.0.0.1:1/v1');
    const res = await chat('tok-hong');
    expect(res.status).toBe(502);
    expect((await res.json()).error.message).toContain('게이트웨이에 닿지 못했습니다');
    expect(auditLines().at(-1)).toMatchObject({ status: 502, outcome: 'unreachable' });
    await startProxy();
  });

  it('/health는 인증 없이, 다른 주소는 404, GET은 405', async () => {
    expect((await fetch(`${proxyUrl}/health`)).status).toBe(200);
    expect((await fetch(`${proxyUrl}/v1/models`)).status).toBe(404);
    expect((await fetch(`${proxyUrl}/v1/chat/completions`)).status).toBe(405);
  });

  it('JSON이 아닌 본문은 400', async () => {
    const res = await fetch(`${proxyUrl}/v1/chat/completions`, { method: 'POST', headers: { authorization: 'Bearer tok-hong' }, body: '깨진' });
    expect(res.status).toBe(400);
  });
});

describe('사용자별 속도 제한', () => {
  it('토큰 버킷: 분당 N회를 넘기면 Retry-After를 주고 시간이 지나면 풀린다', () => {
    let t = 0;
    const rl = new RateLimiter(2, () => t);
    expect(rl.take('a')).toBeNull();
    expect(rl.take('a')).toBeNull();
    expect(rl.take('a')).toBe(30);
    expect(rl.take('b')).toBeNull(); // 사용자마다 따로
    t += 30_000;
    expect(rl.take('a')).toBeNull();
    expect(new RateLimiter(0).take('x')).toBeNull(); // 0이면 제한 없음
  });

  it('프록시가 429와 Retry-After를 내고 감사에 남긴다', async () => {
    perMinute = 2;
    await startProxy();
    expect((await chat('tok-new')).status).toBe(200);
    expect((await chat('tok-new')).status).toBe(200);
    const limited = await chat('tok-new');
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get('retry-after'))).toBeGreaterThan(0);
    expect((await chat('tok-hong')).status).toBe(200);
    expect(auditLines().some((l) => l.outcome === 'rate_limited' && l.userId === 'newbie')).toBe(true);
    perMinute = 0;
  });
});

describe('보조 함수', () => {
  it('응답 끝에서 토큰 수 숫자만 뽑는다', () => {
    expect(usageFromTail('..."usage":{"prompt_tokens":3,"completion_tokens":4,"total_tokens":7}}')).toEqual({ prompt: 3, completion: 4, total: 7 });
    expect(usageFromTail('내용만 있음')).toBeUndefined();
  });

  it('토큰 표 파일이 없으면 시작할 때 오류', () => {
    expect(() => new TokenTable(join(dir, '없음.json'))).toThrow('찾지 못했습니다');
  });
});
