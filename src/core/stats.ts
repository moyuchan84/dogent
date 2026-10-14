import type { RunResult } from './types';

/**
 * 실행 기록으로 스킬의 상태를 본다.
 *
 * 화면이 바뀌어 스킬이 깨지면 누군가 실패해 봐야 알게 된다. 그 PC에 쌓인 기록만으로도
 * "전에는 되던 스킬이 요즘 계속 실패한다"는 것은 알 수 있으므로 그것을 드러낸다.
 */

/** 통계에 쓰는 실행 한 건 */
export interface RunBrief {
  skillId: string;
  startedAt: string;
  result: Pick<RunResult, 'status' | 'cause' | 'elapsedMs'>;
  /** 모델이 정한 동작 수 */
  modelActions: number;
}

/**
 * ok: 끝까지 감 (시험 실행이 제출 직전까지 간 것도 포함).
 * fail: 스킬이 일을 해내지 못함.
 * skip: 스킬 탓이 아님 — 사용자가 멈췄거나 승인하지 않음, 입력값이 정책에 걸림, 로그인이 풀림.
 */
export type RunVerdict = 'ok' | 'fail' | 'skip';

export function runVerdict(result: Pick<RunResult, 'status' | 'cause'>): RunVerdict {
  if (result.status === 'done' || result.status === 'dryrun') return 'ok';
  if (result.status === 'stopped' || result.cause) return 'skip';
  return 'fail';
}

export interface SkillStats {
  skillId: string;
  runs: number;
  ok: number;
  fail: number;
  /** 성공률 (0~1). 성공·실패로 판정된 실행이 없으면 null. */
  rate: number | null;
  lastAt: string;
  /** 가장 최근부터 이어진 실패 횟수 (판정에서 빠지는 실행은 건너뛴다) */
  failStreak: number;
  /** 성공한 실행의 평균 소요 시간(초)과 평균 모델 동작 수. 성공이 없으면 null. */
  avgSec: number | null;
  avgModelActions: number | null;
  /** 전에는 성공하던 스킬이 최근 2번 이상 연달아 실패함. 화면이 바뀌었을 가능성이 크다. */
  broken: boolean;
}

/** 스킬별 통계. 깨진 것으로 보이는 스킬이 앞에, 그다음은 최근에 실행한 순서다. */
export function skillStats(runs: RunBrief[]): SkillStats[] {
  const groups = new Map<string, RunBrief[]>();
  for (const run of runs) groups.set(run.skillId, [...(groups.get(run.skillId) ?? []), run]);

  const stats = [...groups.entries()].map(([skillId, list]): SkillStats => {
    const sorted = [...list].sort((a, b) => a.startedAt.localeCompare(b.startedAt));
    const judged = sorted.map((r) => runVerdict(r.result)).filter((v) => v !== 'skip');
    const ok = sorted.filter((r) => runVerdict(r.result) === 'ok');
    const fail = judged.length - ok.length;
    let failStreak = 0;
    for (let i = judged.length - 1; i >= 0 && judged[i] === 'fail'; i--) failStreak++;
    const mean = (values: number[]) => (values.length ? values.reduce((a, b) => a + b, 0) / values.length : null);
    return {
      skillId,
      runs: sorted.length,
      ok: ok.length,
      fail,
      rate: judged.length ? ok.length / judged.length : null,
      lastAt: sorted[sorted.length - 1].startedAt,
      failStreak,
      avgSec: mean(ok.map((r) => r.result.elapsedMs / 1000)),
      avgModelActions: mean(ok.map((r) => r.modelActions)),
      broken: failStreak >= 2 && ok.length > 0,
    };
  });
  return stats.sort((a, b) => Number(b.broken) - Number(a.broken) || b.lastAt.localeCompare(a.lastAt));
}
