import { beforeEach, describe, expect, it } from 'vitest';
import { resolveInputs, runSkill, runVerdict, skillStats, type RunBrief, type RunResult } from '../src/core';
import { JsdomBrowser, fwLog, fwSkill, memoryFiles, mockLlm, scriptedLlm } from './helpers';

let clock = 0;
const run = (skillId: string, status: RunResult['status'], more: Partial<RunBrief['result']> & { modelActions?: number } = {}): RunBrief => ({
  skillId,
  startedAt: new Date(Date.UTC(2026, 9, 1, 0, clock++)).toISOString(),
  result: { status, elapsedMs: more.elapsedMs ?? 10_000, cause: more.cause },
  modelActions: more.modelActions ?? 0,
});

beforeEach(() => {
  clock = 0;
  fwLog.length = 0;
});

describe('스킬별 실행 통계', () => {
  it('끝까지 간 실행의 비율을 세고, 스킬 탓이 아닌 중단은 뺀다', () => {
    const [s] = skillStats([
      run('wip', 'done', { elapsedMs: 8000, modelActions: 4 }),
      run('wip', 'aborted'),
      run('wip', 'stopped'),
      run('wip', 'aborted', { cause: 'user' }),
      run('wip', 'aborted', { cause: 'login' }),
      run('wip', 'dryrun', { elapsedMs: 4000, modelActions: 0 }),
      run('wip', 'error'),
    ]);
    expect(s).toMatchObject({ skillId: 'wip', runs: 7, ok: 2, fail: 2, rate: 0.5, failStreak: 1, avgSec: 6, avgModelActions: 2, broken: false });
  });

  it('전에는 되던 스킬이 연달아 실패하면 깨진 것으로 보고 맨 앞에 둔다', () => {
    const stats = skillStats([
      run('fw', 'done'),
      run('fw', 'aborted'),
      // 사용자가 멈춘 실행은 연속 실패를 끊지 않는다.
      run('fw', 'stopped'),
      run('fw', 'error'),
      run('new', 'aborted'),
      run('new', 'aborted'),
      run('wip', 'done'),
    ]);
    expect(stats.map((s) => [s.skillId, s.broken, s.failStreak])).toEqual([
      ['fw', true, 2],
      ['wip', false, 0],
      // 한 번도 성공한 적이 없으면 화면이 바뀐 것인지 알 수 없다.
      ['new', false, 2],
    ]);
    expect(stats[2]).toMatchObject({ rate: 0, avgSec: null, avgModelActions: null });
  });

  it('판정할 실행이 없으면 성공률을 내지 않는다', () => {
    expect(skillStats([run('wip', 'stopped')])[0]).toMatchObject({ rate: null, ok: 0, fail: 0 });
    expect(skillStats([])).toEqual([]);
  });
});

describe('중단의 이유', () => {
  const RAW = { src_ip: '10.10.1.15', dst_ip: '10.20.3.7', port: '1521', protocol: 'TCP', period_days: '90', reason: '개발 서버에서 운영 DB 조회 배치를 실행하기 위함' };
  const deps = (approve: boolean) => ({
    llm: mockLlm,
    browser: new JsdomBrowser(),
    ui: { ask: async () => '', approve: async () => approve },
    files: memoryFiles(),
  });

  it('사용자가 승인하지 않은 것과 정책에 걸린 것은 스킬의 실패로 세지 않는다', async () => {
    const { values } = resolveInputs(fwSkill(), RAW);
    const declined = await runSkill(fwSkill(), values, deps(false));
    expect(declined).toMatchObject({ status: 'aborted', cause: 'user' });
    expect(runVerdict(declined)).toBe('skip');

    const blocked = await runSkill(fwSkill(), { ...values, src_ip: '10.0.0.0/8' }, deps(true));
    expect(blocked).toMatchObject({ status: 'aborted', cause: 'policy' });
    expect(runVerdict(blocked)).toBe('skip');

    const done = await runSkill(fwSkill(), values, deps(true));
    expect(done.cause).toBeUndefined();
    expect(runVerdict(done)).toBe('ok');
  });

  it('로그인이 풀린 것도 세지 않고, 스킬이 스스로 그만둔 것은 실패로 센다', async () => {
    const { values } = resolveInputs(fwSkill(), RAW);
    const login = await runSkill(fwSkill(), values, { ...deps(true), browser: await JsdomBrowser.open('/login.html') });
    expect(login).toMatchObject({ status: 'aborted', cause: 'login' });

    const gaveUp = await runSkill(fwSkill(), values, { ...deps(true), llm: scriptedLlm([{ tool: 'abort', args: { reason: '화면이 다릅니다' } }]) });
    expect(gaveUp.status).toBe('aborted');
    expect(runVerdict(gaveUp)).toBe('fail');
  });
});
