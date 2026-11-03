import { mkdtempSync, readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { checkTokens, computeStats, createHubHandler, FileStore, sanitizeRun, tokenEquals, type RunSummary } from '../tools/hub-core';

const CLIENT = 'client-token-0123456789';
const ADMIN = 'admin-token-0123456789a';
const run = (o: Record<string, unknown> = {}) => ({
  runId: crypto.randomUUID(),
  userId: 'hong',
  skillId: 'wip-check',
  skillVersion: '1.0.0',
  risk: 'R1',
  result: 'ok',
  startedAt: new Date().toISOString(),
  durationMs: 1000,
  modelCalls: 3,
  approved: false,
  clientVersion: '0.1.0',
  ...o,
});

let dir = '';
let server: Server;
let base = '';

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'dogent-hub-'));
  server = createServer(createHubHandler({ store: new FileStore(dir), token: CLIENT, adminToken: ADMIN }));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(() => server.close());

const call = (method: string, path: string, opts: { token?: string; body?: unknown; headers?: Record<string, string> } = {}) =>
  fetch(base + path, {
    method,
    headers: { ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}), ...(opts.body !== undefined ? { 'content-type': 'application/json' } : {}), ...opts.headers },
    body: opts.body === undefined ? undefined : typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body),
  });

describe('시작 조건과 인증', () => {
  it('토큰이 없거나 짧거나 같으면 시작을 거부한다', () => {
    expect(checkTokens(undefined, ADMIN)).toContain('HUB_TOKEN');
    expect(checkTokens(CLIENT, undefined)).toContain('HUB_ADMIN_TOKEN');
    expect(checkTokens('짧음', ADMIN)).toContain('16자');
    expect(checkTokens(CLIENT, CLIENT)).toContain('달라야');
    expect(checkTokens(CLIENT, ADMIN)).toBeNull();
  });

  it('토큰 비교는 길이가 달라도 안전하게 거짓을 낸다', () => {
    expect(tokenEquals('a', ADMIN)).toBe(false);
    expect(tokenEquals(undefined, ADMIN)).toBe(false);
    expect(tokenEquals(ADMIN, ADMIN)).toBe(true);
  });

  it('/health는 인증 없이, 나머지는 토큰이 있어야 한다. 클라이언트 토큰으로 관리 기능은 못 쓴다', async () => {
    expect((await call('GET', '/health')).status).toBe(200);
    expect((await call('GET', '/v1/policy')).status).toBe(401);
    expect((await call('GET', '/v1/policy', { token: 'nope' })).status).toBe(403);
    expect((await call('GET', '/v1/policy', { token: CLIENT })).status).toBe(200);
    expect((await call('GET', '/v1/admin/stats', { token: CLIENT })).status).toBe(403);
    expect((await call('GET', '/v1/admin/stats')).status).toBe(401);
    expect((await call('PUT', '/v1/admin/policy', { token: CLIENT, body: { ttlSec: 60 } })).status).toBe(403);
    expect((await call('POST', '/v1/admin/killswitch', { token: CLIENT, body: { scope: 'all', reason: 'x' } })).status).toBe(403);
    expect((await call('GET', '/v1/nothing', { token: ADMIN })).status).toBe(404);
  });
});

describe('정책과 중지 스위치', () => {
  it('정책은 ETag로 304를 낸다. 바뀌면 판이 올라 다시 200', async () => {
    const r1 = await call('GET', '/v1/policy', { token: CLIENT });
    const p1 = await r1.json();
    expect(p1).toMatchObject({ ttlSec: 600, killSwitches: [] });
    expect(typeof p1.issuedAt).toBe('string');
    const etag = r1.headers.get('etag')!;
    expect((await call('GET', '/v1/policy', { token: CLIENT, headers: { 'if-none-match': etag } })).status).toBe(304);

    const put = await call('PUT', '/v1/admin/policy', { token: ADMIN, body: { ttlSec: 120, notice: '점검 예정' } });
    expect(put.status).toBe(200);
    const r2 = await call('GET', '/v1/policy', { token: CLIENT, headers: { 'if-none-match': etag } });
    expect(r2.status).toBe(200);
    expect(await r2.json()).toMatchObject({ ttlSec: 120, notice: '점검 예정' });
    // 공지는 null로 지운다
    await call('PUT', '/v1/admin/policy', { token: ADMIN, body: { notice: null } });
    expect((await (await call('GET', '/v1/policy', { token: CLIENT })).json()).notice).toBeUndefined();
  });

  it('정책 값 검사: 너무 작은 ttl, 긴 공지는 400', async () => {
    expect((await call('PUT', '/v1/admin/policy', { token: ADMIN, body: { ttlSec: 5 } })).status).toBe(400);
    expect((await call('PUT', '/v1/admin/policy', { token: ADMIN, body: { notice: 'x'.repeat(501) } })).status).toBe(400);
  });

  it('중지 스위치를 걸고 풀면 정책에 반영되고 감사에 남는다', async () => {
    const bad = await call('POST', '/v1/admin/killswitch', { token: ADMIN, body: { scope: 'skill', reason: '' } });
    expect(bad.status).toBe(400);
    expect((await call('POST', '/v1/admin/killswitch', { token: ADMIN, body: { scope: 'skill', reason: '화면 변경' } })).status).toBe(400); // target 없음

    const set = await call('POST', '/v1/admin/killswitch', { token: ADMIN, body: { scope: 'skill', target: 'gsams-request', reason: '화면 변경으로 깨짐' } });
    expect(set.status).toBe(201);
    const item = await set.json();
    const all = await (await call('POST', '/v1/admin/killswitch', { token: ADMIN, body: { scope: 'all', reason: '긴급' } })).json();
    expect(all.target).toBe('*');

    const policy = await (await call('GET', '/v1/policy', { token: CLIENT })).json();
    expect(policy.killSwitches.map((k: { scope: string; target: string }) => `${k.scope}:${k.target}`)).toEqual(['skill:gsams-request', 'all:*']);
    expect(policy.killSwitches[0].reason).toBe('화면 변경으로 깨짐');

    expect((await call('DELETE', `/v1/admin/killswitch/${item.id}`, { token: ADMIN })).status).toBe(204);
    expect((await call('DELETE', `/v1/admin/killswitch/${item.id}`, { token: ADMIN })).status).toBe(404);
    await call('DELETE', `/v1/admin/killswitch/${all.id}`, { token: ADMIN });
    expect((await (await call('GET', '/v1/policy', { token: CLIENT })).json()).killSwitches).toEqual([]);

    const audit = await (await call('GET', '/v1/admin/audit?limit=50', { token: ADMIN })).json();
    const actions = audit.entries.map((e: { action: string }) => e.action);
    expect(actions).toContain('killswitch.set');
    expect(actions).toContain('killswitch.clear');
    expect(actions).toContain('policy.update');
    // 최근 것이 먼저, 토큰은 감사에 없다
    expect(audit.entries[0].action).toBe('killswitch.clear');
    expect(JSON.stringify(audit)).not.toContain(ADMIN);
  });

  it('정책 상태는 파일에 남아 다시 띄워도 이어진다', async () => {
    const d = mkdtempSync(join(tmpdir(), 'dogent-hub-'));
    const a = new FileStore(d);
    await a.addKillSwitch({ scope: 'system', target: 'gsams', reason: '점검' });
    await a.setPolicy({ ttlSec: 90 });
    const b = new FileStore(d);
    expect((await b.listKillSwitches()).map((k) => k.target)).toEqual(['gsams']);
    expect((await b.getPolicy()).ttlSec).toBe(90);
    expect(JSON.parse(readFileSync(join(d, 'state.json'), 'utf8')).policy.version).toBe(3);
  });
});

describe('실행 요약', () => {
  it('runId로 멱등이다 (같은 것을 다시 보내도 한 번만 저장)', async () => {
    const r = run({ skillId: 'idem-skill' });
    const a = await (await call('POST', '/v1/runs', { token: CLIENT, body: r })).json();
    expect(a).toEqual({ accepted: 1, duplicates: 0, rejected: 0 });
    const b = await (await call('POST', '/v1/runs', { token: CLIENT, body: [r, run({ skillId: 'idem-skill' })] })).json();
    expect(b).toEqual({ accepted: 1, duplicates: 1, rejected: 0 });
    const stats = await (await call('GET', '/v1/admin/stats?days=1', { token: ADMIN })).json();
    expect(stats.skills.find((s: { skillId: string }) => s.skillId === 'idem-skill').runs).toBe(2);
  });

  it('화이트리스트 밖의 필드는 저장하지 않는다 (값, 화면 글자, 입력값, 요청 문장)', async () => {
    const secret = '비밀-표값-123';
    const r = run({
      skillId: 'leak-check',
      rows: [[secret]],
      inputs: { 신청내용: secret },
      screenText: secret,
      request: `${secret} 처리해 줘`,
      message: secret,
      outputs: { 번호: secret },
      tabUrl: `https://x/${secret}`,
    });
    const res = await (await call('POST', '/v1/runs', { token: CLIENT, body: r })).json();
    expect(res.accepted).toBe(1);
    const saved = readFileSync(join(dir, 'runs.jsonl'), 'utf8');
    expect(saved).not.toContain(secret);
    const line = JSON.parse(saved.split('\n').filter((l) => l.includes('leak-check'))[0]);
    expect(Object.keys(line).sort()).toEqual(['approved', 'clientVersion', 'durationMs', 'modelCalls', 'result', 'risk', 'runId', 'skillId', 'skillVersion', 'startedAt', 'userId'].sort());
  });

  it('형식이 틀린 요약은 거절하고 긴 글·이상한 값은 버린다', () => {
    expect(sanitizeRun(null)).toBeNull();
    expect(sanitizeRun(run({ risk: 'R9' }))).toBeNull();
    expect(sanitizeRun(run({ result: 'maybe' }))).toBeNull();
    expect(sanitizeRun(run({ runId: 'x'.repeat(65) }))).toBeNull();
    expect(sanitizeRun(run({ startedAt: '어제' }))).toBeNull();
    const s = sanitizeRun(run({ errorClass: '화면 글자가 섞인 아주 긴 문장입니다 '.repeat(5), durationMs: -5, modelCalls: 1e12, approved: 'yes', skillVersion: 'v'.repeat(40) }))!;
    expect(s.errorClass).toBeUndefined();
    expect(s.durationMs).toBeUndefined();
    expect(s.modelCalls).toBeUndefined();
    expect(s.approved).toBeUndefined();
    expect(s.skillVersion).toBeUndefined();
    expect(sanitizeRun(run({ errorClass: 'timeout' }))!.errorClass).toBe('timeout');
  });

  it('본문 크기와 배열 길이를 제한한다', async () => {
    const big = await call('POST', '/v1/runs', { token: CLIENT, body: JSON.stringify([run({ pad: 'x'.repeat(1_100_000) })]) });
    expect(big.status).toBe(413);
    const many = await call('POST', '/v1/runs', { token: CLIENT, body: Array.from({ length: 201 }, () => run()) });
    expect(many.status).toBe(413);
    expect((await call('POST', '/v1/runs', { token: CLIENT, body: '{깨진' })).status).toBe(400);
    // 서버는 계속 산다
    expect((await call('GET', '/health')).status).toBe(200);
  });
});

describe('통계', () => {
  it('스킬별 실행 수, 성공률, 평균 시간, 연속 실패, 사용자 수를 센다 (취소·차단은 성공률에서 뺀다)', () => {
    const t = Date.parse('2026-11-03T12:00:00Z');
    const at = (min: number) => new Date(t - min * 60_000).toISOString();
    const runs = [
      run({ skillId: 'a', result: 'ok', startedAt: at(50), durationMs: 1000, userId: 'u1' }),
      run({ skillId: 'a', result: 'fail', startedAt: at(40), durationMs: 3000, userId: 'u2' }),
      run({ skillId: 'a', result: 'aborted', startedAt: at(30), durationMs: 2000, userId: 'u2' }),
      run({ skillId: 'a', result: 'fail', startedAt: at(20), durationMs: 2000, userId: 'u1' }),
      run({ skillId: 'b', result: 'ok', startedAt: at(10), durationMs: 500, userId: 'u3' }),
      run({ skillId: 'old', result: 'ok', startedAt: new Date(t - 30 * 86_400_000).toISOString(), userId: 'u9' }),
    ] as RunSummary[];
    const s = computeStats(runs, 7, t);
    expect(s.users).toBe(3);
    expect(s.runs).toBe(5);
    const a = s.skills.find((x) => x.skillId === 'a')!;
    expect(a).toMatchObject({ runs: 4, ok: 1, successRate: 0.333, avgDurationMs: 2000, consecutiveFailures: 2 });
    expect(s.skills.find((x) => x.skillId === 'b')).toMatchObject({ successRate: 1, consecutiveFailures: 0 });
    expect(s.skills.some((x) => x.skillId === 'old')).toBe(false);
  });
});
