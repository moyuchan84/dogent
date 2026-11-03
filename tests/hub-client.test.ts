import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  buildRunSummary,
  classifyError,
  evaluatePolicy,
  fetchPolicy,
  flushOutbox,
  hubStale,
  loadHubCache,
  policyExpired,
  readOutbox,
  reportRun,
  systemsCoveredBy,
  type HubCache,
  type HubRunSummary,
} from '../client/src/hub';
import type { RunEvent } from '../src/core';

const ROOT = join(import.meta.dirname, '..');
const NOW = Date.parse('2026-11-03T12:00:00Z');
const cache = (o: { fetchedAt?: string; ttlSec?: number; kill?: HubCache['policy']['killSwitches'] } = {}): HubCache => ({
  url: 'http://hub',
  fetchedAt: o.fetchedAt ?? new Date(NOW - 60_000).toISOString(),
  etag: '"1"',
  policy: { version: 1, issuedAt: new Date(NOW - 60_000).toISOString(), ttlSec: o.ttlSec ?? 600, killSwitches: o.kill ?? [] },
});
const target = (o: Partial<{ skillId: string; risk: 'R1' | 'R2' | 'R3'; systemIds: string[] }> = {}) => ({ skillId: 'gsams-request', risk: 'R1' as const, systemIds: ['gsams'], ...o });
const kill = (scope: 'skill' | 'system' | 'all', t: string) => ({ id: 'k1', scope, target: t, reason: '화면이 바뀜', since: '2026-11-03T00:00:00Z' });

describe('정책 판정 (순수 함수)', () => {
  it('중지 스위치: 그 스킬, 그 시스템, all이면 막고 이유를 보여 준다. 다른 스킬·시스템은 통과', () => {
    const v = evaluatePolicy(cache({ kill: [kill('skill', 'gsams-request')] }), target(), NOW);
    expect(v).toMatchObject({ allow: false, errorClass: 'killswitch' });
    expect((v as { reason: string }).reason).toContain('gsams-request');
    expect((v as { reason: string }).reason).toContain('화면이 바뀜');
    expect(evaluatePolicy(cache({ kill: [kill('skill', 'other')] }), target(), NOW).allow).toBe(true);
    expect(evaluatePolicy(cache({ kill: [kill('system', 'gsams')] }), target(), NOW).allow).toBe(false);
    expect(evaluatePolicy(cache({ kill: [kill('system', 'mes')] }), target(), NOW).allow).toBe(true);
    expect(evaluatePolicy(cache({ kill: [kill('all', '*')] }), target({ skillId: 'anything', systemIds: [] }), NOW).allow).toBe(false);
  });

  it('중지는 위험도와 상관없이 막고, 정책이 만료돼도 받아 둔 중지 스위치는 계속 지킨다', () => {
    const old = cache({ fetchedAt: new Date(NOW - 3_600_000).toISOString(), kill: [kill('skill', 'x')] });
    expect(evaluatePolicy(old, target({ skillId: 'x', risk: 'R1' }), NOW).allow).toBe(false);
  });

  it('만료되면 R3만 막고 R1·R2는 허용한다 (경고만)', () => {
    const old = cache({ fetchedAt: new Date(NOW - 3_600_000).toISOString(), ttlSec: 600 });
    expect(policyExpired(old, NOW)).toBe(true);
    expect(evaluatePolicy(old, target({ risk: 'R3' }), NOW)).toMatchObject({ allow: false, errorClass: 'expired' });
    expect(evaluatePolicy(old, target({ risk: 'R2' }), NOW)).toMatchObject({ allow: true, warn: expect.stringContaining('만료') });
    expect(evaluatePolicy(old, target({ risk: 'R1' }), NOW).allow).toBe(true);
    // 만료 전이면 R3도 통과
    expect(policyExpired(cache(), NOW)).toBe(false);
    expect(evaluatePolicy(cache(), target({ risk: 'R3' }), NOW)).toEqual({ allow: true });
  });

  it('정책을 한 번도 받은 적이 없으면 막지 않고 경고만 한다', () => {
    expect(evaluatePolicy(null, target({ risk: 'R3' }), NOW)).toMatchObject({ allow: true, warn: expect.stringContaining('한 번도') });
  });

  it('스킬이 다루는 사이트로 시스템 id를 찾는다', () => {
    const systems = [
      { id: 'gsams', domains: ['gsams.corp.net'] },
      { id: 'mes', domains: ['mes.corp.net', '*.mes-sub.corp.net'] },
    ];
    expect(systemsCoveredBy(['gsams.corp.net'], systems)).toEqual(['gsams']);
    expect(systemsCoveredBy(['*.corp.net'], systems)).toEqual(['gsams', 'mes']);
    expect(systemsCoveredBy(['mes.corp.net', 'x.mes-sub.corp.net'], systems)).toEqual(['mes']);
    expect(systemsCoveredBy(['other.net'], systems)).toEqual([]);
    expect(systemsCoveredBy([], systems)).toEqual([]);
  });

  it('언제 다시 받나: 없거나 주소가 바뀌었거나 ttl의 절반이 지났을 때', () => {
    expect(hubStale(null, 'http://hub', NOW)).toBe(true);
    expect(hubStale(cache(), 'http://hub/', NOW)).toBe(false); // 60초 < 300초
    expect(hubStale(cache(), 'http://other', NOW)).toBe(true);
    expect(hubStale(cache({ fetchedAt: new Date(NOW - 400_000).toISOString() }), 'http://hub', NOW)).toBe(true);
  });
});

describe('실행 요약 만들기', () => {
  const SECRET = '비밀-값-4321';
  const events: RunEvent[] = [
    { type: 'llm_usage', n: 1, systemChars: 10, userChars: 10, replyChars: 10, ms: 5 },
    { type: 'llm_usage', n: 2, systemChars: 10, userChars: 10, replyChars: 10, ms: 5 },
    { type: 'observe', n: 1, url: `https://gsams/${SECRET}`, title: SECRET },
    { type: 'approval', n: 2, request: { tool: 'click', summary: SECRET } as never, approved: true, dryRun: false },
  ];

  it('화이트리스트 필드만 담는다 (입력값·화면 글자·결과 글·출력은 없다)', () => {
    const s = buildRunSummary({
      runId: 'r1',
      userId: 'hong',
      skill: { id: 'gsams-request', version: '1.2.0', risk: 'R3' },
      result: { status: 'done', message: `${SECRET} 신청 완료`, elapsedMs: 4200.4 },
      events,
      startedAt: '2026-11-03T12:00:00.000Z',
      clientVersion: '0.1.0',
    });
    expect(s).toEqual({ runId: 'r1', userId: 'hong', skillId: 'gsams-request', skillVersion: '1.2.0', risk: 'R3', result: 'ok', startedAt: '2026-11-03T12:00:00.000Z', durationMs: 4200, modelCalls: 2, approved: true, clientVersion: '0.1.0' });
    expect(JSON.stringify(s)).not.toContain(SECRET);
  });

  it('결과 상태를 ok/fail/aborted/blocked로 옮기고 오류는 분류어만 보낸다', () => {
    const base = { runId: 'r', userId: 'u', skill: { id: 's', version: '1', risk: 'R1' as const }, events: [], startedAt: '2026-11-03T12:00:00Z' };
    const r = (status: 'done' | 'dryrun' | 'error' | 'stopped' | 'aborted', message = '', cause?: 'user' | 'policy' | 'login') => buildRunSummary({ ...base, result: { status, message, cause, elapsedMs: 1 } });
    expect(r('dryrun').result).toBe('ok');
    expect(r('stopped').result).toBe('aborted');
    expect(r('aborted', '', 'user')).toMatchObject({ result: 'aborted', errorClass: 'user' });
    expect(r('aborted', '', 'policy')).toMatchObject({ result: 'blocked', errorClass: 'policy' });
    const f = r('error', `로그인이 풀렸습니다 ${SECRET}`);
    expect(f).toMatchObject({ result: 'fail', errorClass: 'login' });
    expect(JSON.stringify(f)).not.toContain(SECRET);
    expect(buildRunSummary({ ...base, result: { status: 'aborted', message: '', elapsedMs: 0 }, blocked: 'killswitch' })).toMatchObject({ result: 'blocked', errorClass: 'killswitch' });
    expect(classifyError('알 수 없는 문제')).toBe('other');
    expect(classifyError('시간이 초과됐습니다')).toBe('timeout');
  });

  it('승인 안 한 실행은 approved=false, 승인 단계가 없으면 필드 없음', () => {
    const base = { runId: 'r', userId: 'u', skill: { id: 's', version: '1', risk: 'R3' as const }, result: { status: 'aborted' as const, message: '', elapsedMs: 1 }, startedAt: '2026-11-03T12:00:00Z' };
    const no = buildRunSummary({ ...base, events: [{ type: 'approval', n: 1, request: {} as never, approved: false, dryRun: false }] });
    expect(no.approved).toBe(false);
    expect('approved' in buildRunSummary({ ...base, events: [] })).toBe(false);
  });
});

/** 임시 Hub 서버: 정책, 304, 실행 요약 받기 */
describe('정책 받기와 아웃박스 (임시 서버)', () => {
  let server: Server;
  let url = '';
  let version = 1;
  let up = true;
  const posted: HubRunSummary[] = [];
  const seen: { auth?: string; inm?: string }[] = [];

  beforeAll(async () => {
    server = createServer((req, res) => {
      if (!up) return void req.socket.destroy();
      seen.push({ auth: req.headers.authorization, inm: req.headers['if-none-match'] as string | undefined });
      if (req.headers.authorization !== 'Bearer tok') return void res.writeHead(401).end();
      if (req.url === '/v1/policy') {
        if (req.headers['if-none-match'] === `"${version}"`) return void res.writeHead(304, { etag: `"${version}"` }).end();
        return void res.writeHead(200, { 'content-type': 'application/json', etag: `"${version}"` }).end(JSON.stringify({ version, issuedAt: new Date().toISOString(), ttlSec: 600, killSwitches: [{ id: 'a1', scope: 'skill', target: 'x', reason: '점검', since: '2026-11-03T00:00:00Z' }, { scope: 'bogus', target: 'y' }], notice: '공지' }));
      }
      if (req.url === '/v1/runs' && req.method === 'POST') {
        let b = '';
        req.on('data', (c) => (b += c));
        req.on('end', () => {
          posted.push(...(JSON.parse(b) as HubRunSummary[]));
          res.writeHead(200, { 'content-type': 'application/json' }).end('{}');
        });
        return;
      }
      res.writeHead(404).end();
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });
  afterAll(() => server.close());

  const sum = (id: string): HubRunSummary => ({ runId: id, userId: 'hong', skillId: 's', risk: 'R1', result: 'ok', startedAt: '2026-11-03T12:00:00.000Z' });

  it('받아서 캐시에 저장하고, 같은 판이면 304로 fetchedAt만 갱신하고, 서버가 죽으면 던지되 캐시는 남는다', async () => {
    const home = mkdtempSync(join(tmpdir(), 'dogent-hubc-'));
    expect(loadHubCache(home)).toBeNull();
    const a = await fetchPolicy(home, url, { token: 'tok', now: NOW });
    expect(a.changed).toBe(true);
    expect(a.cache.policy.killSwitches).toEqual([{ id: 'a1', scope: 'skill', target: 'x', reason: '점검', since: '2026-11-03T00:00:00Z' }]); // 이상한 항목은 버린다
    expect(a.cache.policy.notice).toBe('공지');
    expect(loadHubCache(home)).toMatchObject({ url, fetchedAt: new Date(NOW).toISOString(), etag: '"1"' });

    const b = await fetchPolicy(home, url, { token: 'tok', now: NOW + 60_000 });
    expect(b.changed).toBe(false);
    expect(seen.at(-1)?.inm).toBe('"1"');
    expect(loadHubCache(home)?.fetchedAt).toBe(new Date(NOW + 60_000).toISOString());

    up = false;
    await expect(fetchPolicy(home, url, { token: 'tok', timeoutMs: 1000 })).rejects.toThrow();
    up = true;
    expect(loadHubCache(home)?.policy.version).toBe(1); // 받아 둔 것은 그대로
    await expect(fetchPolicy(home, url, { token: 'wrong' })).rejects.toThrow('HTTP 401');
    version = 2;
    expect((await fetchPolicy(home, url, { token: 'tok' })).changed).toBe(true);
    version = 1;
  });

  it('서버가 이상한 응답을 주면 오류, 캐시 파일이 깨졌으면 없는 것으로 본다', async () => {
    const home = mkdtempSync(join(tmpdir(), 'dogent-hubc-'));
    const other = createServer((_q, r) => void r.writeHead(200).end('<html>로그인</html>'));
    await new Promise<void>((r) => other.listen(0, '127.0.0.1', r));
    try {
      await expect(fetchPolicy(home, `http://127.0.0.1:${(other.address() as { port: number }).port}`, {})).rejects.toThrow('JSON이 아닙니다');
    } finally {
      other.close();
    }
    writeFileSync(join(home, 'hub-policy.json'), '{깨짐');
    expect(loadHubCache(home)).toBeNull();
  });

  it('보내지 못한 요약은 아웃박스에 쌓였다가 다음에 다시 보낸다 (runId 그대로)', async () => {
    const home = mkdtempSync(join(tmpdir(), 'dogent-hubo-'));
    posted.length = 0;
    up = false;
    await reportRun(home, url, 'tok', sum('r1'), { timeoutMs: 800 });
    await reportRun(home, url, 'tok', sum('r2'), { timeoutMs: 800 });
    expect(readOutbox(home).map((r) => r.runId)).toEqual(['r1', 'r2']);
    expect(posted).toHaveLength(0);

    up = true;
    await reportRun(home, url, 'tok', sum('r3'));
    expect(posted.map((r) => r.runId)).toEqual(['r1', 'r2', 'r3']);
    expect(readOutbox(home)).toEqual([]);
    expect(existsSync(join(home, 'hub-outbox.jsonl'))).toBe(true);
    expect(await flushOutbox(home, url, { token: 'tok' })).toEqual({ sent: 0, left: 0 });
  });

  it('토큰이 틀려 거절되면 아웃박스에 남겨 두고 오류를 던지지 않는다', async () => {
    const home = mkdtempSync(join(tmpdir(), 'dogent-hubo-'));
    await expect(reportRun(home, url, 'wrong', sum('r9'))).resolves.toBeUndefined();
    expect(readOutbox(home).map((r) => r.runId)).toEqual(['r9']);
  });

  it('주소가 이상해도 던지지 않는다', async () => {
    const home = mkdtempSync(join(tmpdir(), 'dogent-hubo-'));
    await expect(reportRun(home, 'not a url', undefined, sum('r8'))).resolves.toBeUndefined();
    expect(readOutbox(home)).toHaveLength(1);
  });
});

/** 실제로 묶인 Hub·프록시(templates/dogent-hub/tools/*.mjs)를 띄워 클라이언트 모듈로 붙는다 */
describe('묶인 Hub 서버와 연결', () => {
  let proc: ChildProcess;
  let url = '';
  const ADMIN = 'admin-token-0123456789a';
  const CLIENT = 'client-token-0123456789';
  const bundle = (name: string) => join(ROOT, 'templates/dogent-hub/tools', name);

  beforeAll(async () => {
    const port = 20000 + Math.floor(Math.random() * 20000);
    url = `http://127.0.0.1:${port}`;
    const data = mkdtempSync(join(tmpdir(), 'dogent-hubd-'));
    proc = spawn(process.execPath, [bundle('hub.mjs'), '--data', data, '--port', String(port)], { env: { ...process.env, HUB_TOKEN: CLIENT, HUB_ADMIN_TOKEN: ADMIN }, stdio: 'ignore' });
    for (let i = 0; i < 500; i++) {
      try {
        if ((await fetch(`${url}/health`)).ok) return;
      } catch {
        /* 아직 */
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error('Hub가 뜨지 않았습니다');
  }, 90_000);
  afterAll(() => proc?.kill());

  it('토큰 없이는 시작하지 않는다', async () => {
    const code = await new Promise<number | null>((resolve) => {
      const p = spawn(process.execPath, [bundle('hub.mjs'), '--port', '0'], { env: { ...process.env, HUB_TOKEN: '', HUB_ADMIN_TOKEN: '' }, stdio: 'ignore' });
      p.on('exit', resolve);
    });
    expect(code).toBe(2);
  });

  it('관리자가 스킬을 중지하면 클라이언트가 정책을 받아 막고, 풀면 통과한다. 실행 요약이 통계에 잡힌다', async () => {
    const home = mkdtempSync(join(tmpdir(), 'dogent-hubi-'));
    const admin = (method: string, path: string, body?: unknown) =>
      fetch(url + path, { method, headers: { authorization: `Bearer ${ADMIN}`, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });

    const first = await fetchPolicy(home, url, { token: CLIENT });
    expect(evaluatePolicy(first.cache, target()).allow).toBe(true);

    const ks = await (await admin('POST', '/v1/admin/killswitch', { scope: 'skill', target: 'gsams-request', reason: '연동 시험' })).json();
    const second = await fetchPolicy(home, url, { token: CLIENT });
    expect(second.changed).toBe(true);
    expect(evaluatePolicy(second.cache, target())).toMatchObject({ allow: false });

    await admin('DELETE', `/v1/admin/killswitch/${ks.id}`);
    const third = await fetchPolicy(home, url, { token: CLIENT });
    expect(evaluatePolicy(third.cache, target()).allow).toBe(true);

    await reportRun(home, url, CLIENT, buildRunSummary({ runId: 'int-1', userId: 'hong', skill: { id: 'gsams-request', version: '1', risk: 'R1' }, result: { status: 'done', message: '비밀', elapsedMs: 1500 }, events: [], startedAt: new Date().toISOString() }));
    expect(readOutbox(home)).toEqual([]);
    const stats = await (await admin('GET', '/v1/admin/stats?days=1')).json();
    expect(stats.skills.find((s: { skillId: string }) => s.skillId === 'gsams-request')).toMatchObject({ runs: 1, ok: 1, avgDurationMs: 1500 });
  });
});

describe('묶인 LLM 프록시와 연결', () => {
  it('프록시를 띄워 개인 토큰으로 대화 요청을 업스트림에 전달한다. 설정이 빠지면 시작하지 않는다', { timeout: 90_000 }, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dogent-pxy-'));
    const got: Record<string, string | string[] | undefined>[] = [];
    const up = createServer((req, res) => {
      got.push(req.headers);
      req.resume();
      req.on('end', () => res.writeHead(200, { 'content-type': 'application/json' }).end('{"choices":[{"message":{"content":"ok"}}]}'));
    });
    await new Promise<void>((r) => up.listen(0, '127.0.0.1', r));
    writeFileSync(join(dir, 'tokens.json'), JSON.stringify({ 'my-token': { userId: 'hong', userType: 'employee' } }));
    const port = 20000 + Math.floor(Math.random() * 20000);
    const file = join(ROOT, 'templates/dogent-hub/tools/llm-proxy.mjs');
    const noUp = await new Promise<number | null>((resolve) => spawn(process.execPath, [file, '--tokens', join(dir, 'tokens.json')], { env: { ...process.env, LLM_UPSTREAM_URL: '' }, stdio: 'ignore' }).on('exit', resolve));
    expect(noUp).toBe(2);
    const proc = spawn(process.execPath, [file, '--tokens', join(dir, 'tokens.json'), '--port', String(port), '--audit', join(dir, 'a.jsonl')], {
      env: { ...process.env, LLM_UPSTREAM_URL: `http://127.0.0.1:${(up.address() as { port: number }).port}/v1`, LLM_UPSTREAM_KEY: 'K', LLM_UPSTREAM_HEADERS: '{"x-dep-ticket":"{key}","user-id":"{userId}","user-type":"{userType}"}' },
      stdio: 'ignore',
    });
    try {
      let ready = false;
      for (let i = 0; i < 500 && !ready; i++) {
        ready = await fetch(`http://127.0.0.1:${port}/health`).then((r) => r.ok, () => false);
        if (!ready) await new Promise((r) => setTimeout(r, 100));
      }
      expect(ready).toBe(true);
      const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, { method: 'POST', headers: { authorization: 'Bearer my-token', 'content-type': 'application/json' }, body: JSON.stringify({ model: 'm', messages: [] }) });
      expect(res.status).toBe(200);
      await res.text();
      expect(got[0]['x-dep-ticket']).toBe('K');
      expect(got[0]['user-id']).toBe('hong');
      expect(readFileSync(join(dir, 'a.jsonl'), 'utf8')).toContain('"userId":"hong"');
    } finally {
      proc.kill();
      up.close();
    }
  });
});
