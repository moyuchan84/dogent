import { useEffect, useMemo, useState } from 'react';
import { runVerdict, skillStats, type RunBrief, type RunResult } from '@/src/core';
import { clearRuns, loadRuns, type RunRecord } from '@/src/ext/storage';
import { download } from './util';

const STATUS_LABEL: Record<RunResult['status'], string> = {
  done: '완료',
  aborted: '중단',
  stopped: '사용자 중지',
  error: '오류',
  dryrun: '시험 실행 완료',
};

const when = (iso: string) => new Date(iso).toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });

const brief = (r: RunRecord): RunBrief => ({
  skillId: r.skill.id,
  startedAt: r.startedAt,
  result: r.result,
  modelActions: r.events.filter((e) => e.type === 'action' && e.entry.by === 'model').length,
});

/**
 * 실행 기록. 이 PC에서 돌린 실행을 다시 열어 보고, 스킬별로 얼마나 성공하는지 본다.
 * 기록은 이 PC의 브라우저에만 있고 최근 50건까지 남는다.
 */
export function History(props: { names: Record<string, string> }) {
  const [runs, setRuns] = useState<RunRecord[]>([]);
  const [open, setOpen] = useState<string | null>(null);
  useEffect(() => {
    void loadRuns().then(setRuns);
  }, []);

  const stats = useMemo(() => skillStats(runs.map(brief)), [runs]);
  const recent = useMemo(() => [...runs].reverse(), [runs]);
  const nameOf = (id: string) => props.names[id] ?? id;

  if (runs.length === 0) {
    return (
      <section className="card" id="history">
        <h2>실행 기록</h2>
        <p className="hint">아직 실행한 기록이 없습니다.</p>
      </section>
    );
  }

  return (
    <>
      <section className="card" id="history">
        <h2>스킬별 상태</h2>
        <table className="stats">
          <thead>
            <tr>
              <th>스킬</th>
              <th>실행</th>
              <th>성공률</th>
              <th>평균</th>
              <th>최근</th>
            </tr>
          </thead>
          <tbody>
            {stats.map((s) => (
              <tr key={s.skillId} data-skill={s.skillId} data-broken={s.broken}>
                <td>
                  {nameOf(s.skillId)}
                  {s.broken && (
                    <span className="chip warn" title="전에는 성공하던 스킬입니다. 화면이 바뀌었을 수 있습니다">
                      최근 {s.failStreak}번 연속 실패
                    </span>
                  )}
                </td>
                <td>{s.runs}</td>
                <td data-rate>{s.rate === null ? '-' : `${Math.round(s.rate * 100)}% (${s.ok}/${s.ok + s.fail})`}</td>
                <td>{s.avgSec === null ? '-' : `${s.avgSec.toFixed(1)}초 · 모델 ${s.avgModelActions!.toFixed(1)}회`}</td>
                <td>{when(s.lastAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="hint">
          성공률은 끝까지 간 실행의 비율입니다. 사용자가 멈췄거나 승인하지 않은 실행, 입력값이 정책에 걸린 실행, 로그인이 풀려 멈춘 실행은 계산에서
          뺍니다.
        </p>
        {stats.some((s) => s.broken) && (
          <p className="notice error">연속으로 실패하는 스킬은 화면이 바뀌었을 수 있습니다. 스킬 담당 부서에 알려 주세요.</p>
        )}
      </section>

      <section className="card">
        <h2>최근 실행 {runs.length}건</h2>
        <ul className="runs">
          {recent.map((r) => {
            const verdict = runVerdict(r.result);
            const actions = r.events.flatMap((e) => (e.type === 'action' ? [e.entry] : []));
            return (
              <li key={r.id} className={verdict} data-run={r.skill.id}>
                <button className="run-head" onClick={() => setOpen(open === r.id ? null : r.id)}>
                  <span className="when">{when(r.startedAt)}</span>
                  <b>{nameOf(r.skill.id)}</b>
                  <span className={`chip ${verdict === 'fail' ? 'warn' : ''}`}>{STATUS_LABEL[r.result.status]}</span>
                </button>
                {open === r.id && (
                  <div className="run-body">
                    <p>{r.result.message}</p>
                    <p className="hint">
                      버전 {r.skill.version} · 동작 {r.result.actions}회 · {(r.result.elapsedMs / 1000).toFixed(1)}초 · {r.tabUrl}
                    </p>
                    {Object.keys(r.inputs).length > 0 && (
                      <p className="hint">
                        입력값:{' '}
                        {Object.entries(r.inputs)
                          .map(([k, v]) => `${k}=${v}`)
                          .join(', ')}
                      </p>
                    )}
                    {r.result.files.length > 0 && <p className="hint">저장한 파일: {r.result.files.join(', ')}</p>}
                    <ol className="log">
                      {actions.map((h) => (
                        <li key={h.n} className={h.ok ? '' : 'fail'}>
                          <div className="log-head">
                            <span className="step">단계 {h.step}</span>
                            {h.by !== 'model' && <span className="chip">{h.by === 'skill' ? '모델 호출 없음' : '기억한 경로'}</span>}
                            <b>{h.tool}</b>
                          </div>
                          <div>{h.result}</div>
                        </li>
                      ))}
                    </ol>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
        <div className="row">
          <button
            className="secondary"
            onClick={() => download(`dogent-log-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(runs, null, 2), 'application/json')}
          >
            기록 내보내기
          </button>
          <button
            className="ghost"
            id="clear-runs"
            onClick={async () => {
              await clearRuns();
              setRuns([]);
            }}
          >
            기록 지우기
          </button>
        </div>
      </section>
    </>
  );
}
