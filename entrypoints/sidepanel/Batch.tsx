import { batchSummary, outcomeLabel, runVerdict, type BatchOutcome, type BatchPlan } from '@/src/core';

/** 묶어 실행하기의 행 목록. 실행 전에는 입력값과 입력 오류를, 실행 중·후에는 행마다의 결과를 보여 준다. */
export function BatchView(props: {
  batch: { file: string; plan: BatchPlan; outcomes: BatchOutcome[]; at: number };
  running: boolean;
  onReport: () => void;
  onClear: () => void;
}) {
  const { file, plan, outcomes, at } = props.batch;
  const finished = at >= plan.rows.length;
  const invalid = plan.rows.filter((r) => r.errors.length > 0).length;
  const summary = batchSummary(outcomes);
  const mapping = Object.entries(plan.mapped)
    .map(([column, name]) => (column === name ? column : `${column} → ${name}`))
    .join(', ');

  return (
    <div id="batch" className="batch-view" data-at={at} data-finished={finished}>
      <p>
        <b>{file}</b> · {plan.rows.length}건{invalid > 0 && <span className="chip warn">입력 오류 {invalid}건은 실행하지 않음</span>}
      </p>
      <p className="hint">
        연결한 컬럼: {mapping}
        {plan.common.length > 0 && ` · 모든 행에 같은 값: ${plan.common.join(', ')}`}
        {plan.ignored.length > 0 && ` · 쓰지 않는 컬럼: ${plan.ignored.join(', ')}`}
      </p>
      {at >= 0 && !finished && (
        <p className="notice" id="batch-progress">
          {Math.min(at + 1, plan.rows.length)}/{plan.rows.length}번째 행 실행 중 (엑셀 {plan.rows[at]?.line}행)
        </p>
      )}
      {finished && (
        <p className="notice" id="batch-summary">
          끝났습니다. 성공 {summary.ok}건, 실패 {summary.fail}건, 실행 안 함 {summary.skipped + summary.invalid}건
        </p>
      )}
      <div className="tablewrap">
        <table className="batch-rows">
          <thead>
            <tr>
              <th>행</th>
              <th>입력값</th>
              <th>결과</th>
            </tr>
          </thead>
          <tbody>
            {plan.rows.map((row, i) => {
              const result = outcomes[i]?.result;
              // 사용자가 승인하지 않은 행처럼 스킬 탓이 아닌 중단은 실패로 칠하지 않는다.
              const state = row.errors.length ? 'invalid' : result ? (runVerdict(result) === 'skip' ? 'skipped' : result.status) : i === at ? 'running' : 'waiting';
              return (
                <tr key={row.line} data-line={row.line} data-state={state}>
                  <td>{row.line}</td>
                  <td>{Object.values(row.values).join(' · ')}</td>
                  <td>
                    {row.errors.length
                      ? row.errors.join(' / ')
                      : result
                        ? `${outcomeLabel(result)}${runVerdict(result) === 'ok' ? '' : ` — ${result.message}`}`
                        : i === at
                          ? '실행 중'
                          : '대기'}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {!props.running && (
        <div className="row">
          <button className="ghost" id="batch-clear" onClick={props.onClear}>
            {finished ? '닫기' : '묶어 실행 취소'}
          </button>
          {finished && (
            <button className="secondary" id="batch-report" onClick={props.onReport}>
              결과 엑셀 내려받기
            </button>
          )}
        </div>
      )}
    </div>
  );
}
