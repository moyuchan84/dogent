import { runVerdict } from './stats';
import { resolveInputs, type Skill, type SkillInputs } from './skill';
import type { Cell, Dataset, RunResult } from './types';

/**
 * 묶어 실행하기. 엑셀의 행마다 같은 스킬을 한 번씩 돌린다.
 *
 * 컬럼은 이름이나 라벨이 같은 입력에 붙는다. 엑셀에 없는 입력은 화면에 적은 값을 모든 행에 쓴다.
 * 입력값 검사와 policy.yaml 규칙은 실행 전에 행마다 적용하고, 걸린 행은 돌리지 않는다.
 * 실행 자체는 한 건씩 돌릴 때와 같아서 R3 스킬은 행마다 승인을 받는다.
 */

/** 한 번에 돌릴 수 있는 최대 행 수. 행마다 승인을 받아야 하는 업무도 있으므로 너무 크게 두지 않는다. */
export const MAX_BATCH_ROWS = 200;

export interface BatchRow {
  /** 엑셀의 행 번호 (머리글이 1행이므로 데이터는 2행부터) */
  line: number;
  values: SkillInputs;
  errors: string[];
}

export interface BatchPlan {
  rows: BatchRow[];
  /** 엑셀 컬럼 → 입력 이름 */
  mapped: Record<string, string>;
  /** 어느 입력에도 붙지 않아 쓰지 않는 컬럼 */
  ignored: string[];
  /** 엑셀에 없어 화면의 값을 모든 행에 쓰는 입력 */
  common: string[];
}

const text = (c: Cell | undefined) => (c === undefined ? '' : String(c).trim());
const key = (s: string) => s.replace(/\s+/g, '').toLowerCase();

export function planBatch(skill: Skill, table: Pick<Dataset, 'columns' | 'rows'>, form: Record<string, string>): BatchPlan {
  if (skill.inputs.some((i) => i.type === 'file')) throw new Error('파일을 입력으로 받는 스킬은 묶어 실행할 수 없습니다');
  const mapped: Record<string, string> = {};
  const ignored: string[] = [];
  table.columns.forEach((column) => {
    const spec = skill.inputs.find((i) => key(i.name) === key(column) || (i.label && key(i.label) === key(column)));
    if (spec && !Object.values(mapped).includes(spec.name)) mapped[column] = spec.name;
    else ignored.push(column);
  });
  if (Object.keys(mapped).length === 0) {
    const names = skill.inputs.map((i) => (i.label ? `${i.label}(${i.name})` : i.name)).join(', ');
    throw new Error(`엑셀의 첫 행에 스킬 입력과 같은 이름의 컬럼이 없습니다. 쓸 수 있는 이름: ${names}`);
  }
  const filled = table.rows.filter((r) => r.some((c) => text(c) !== ''));
  if (filled.length === 0) throw new Error('엑셀에 실행할 행이 없습니다');
  if (filled.length > MAX_BATCH_ROWS) throw new Error(`한 번에 ${MAX_BATCH_ROWS}건까지 실행할 수 있습니다 (지금 ${filled.length}건)`);

  const columnOf = Object.fromEntries(Object.entries(mapped).map(([column, name]) => [name, table.columns.indexOf(column)]));
  const rows = table.rows.flatMap((row, i): BatchRow[] => {
    if (row.every((c) => text(c) === '')) return [];
    const raw: Record<string, string> = { ...form };
    for (const [name, index] of Object.entries(columnOf)) {
      // 엑셀 칸이 비어 있으면 화면의 값(없으면 기본값)을 쓴다.
      const v = text(row[index]);
      if (v !== '') raw[name] = v;
    }
    const { values, errors } = resolveInputs(skill, raw);
    return [{ line: i + 2, values, errors }];
  });
  const common = skill.inputs.filter((i) => !(i.name in columnOf) && form[i.name]?.trim()).map((i) => i.name);
  return { rows, mapped, ignored, common };
}

export interface BatchOutcome {
  row: BatchRow;
  /** 입력값 검사에 걸려 돌리지 않았거나, 앞에서 멈춰 돌리지 못한 행은 없다. */
  result?: Pick<RunResult, 'status' | 'message' | 'cause' | 'outputs'>;
}

/** 이 결과가 나오면 남은 행을 돌리지 않는다. 사람이 멈췄거나 로그인이 풀렸으면 이어 가도 소용없다. */
export function stopsBatch(result: Pick<RunResult, 'status' | 'cause'>): boolean {
  return result.status === 'stopped' || result.cause === 'login';
}

const LABEL: Record<RunResult['status'], string> = {
  done: '완료',
  aborted: '중단',
  stopped: '사용자 중지',
  error: '오류',
  dryrun: '시험 실행 완료',
};

/** 스킬 탓이 아닌 중단은 실패와 구분해 적는다. */
const CAUSE_LABEL: Record<NonNullable<RunResult['cause']>, string> = {
  user: '사용자가 멈춤·승인 안 함',
  policy: '입력값 정책 위반',
  login: '로그인 필요',
};

/** 결과 칸에 적는 말 */
export function outcomeLabel(result: Pick<RunResult, 'status' | 'cause'>): string {
  return result.cause ? CAUSE_LABEL[result.cause] : LABEL[result.status];
}

/** 행마다 입력값, 결과, 메시지, 기록한 값을 한 표로 만든다. 결과 엑셀로 내려받는다. */
export function batchReport(skill: Skill, outcomes: BatchOutcome[]): Pick<Dataset, 'columns' | 'rows'> {
  const inputs = skill.inputs.map((i) => i.name);
  const outputs = [...new Set(outcomes.flatMap((o) => Object.keys(o.result?.outputs ?? {})))];
  const columns = ['행', ...skill.inputs.map((i) => i.label ?? i.name), '결과', '메시지', ...outputs];
  const rows = outcomes.map((o): Cell[] => {
    const status = o.row.errors.length ? '입력 오류' : o.result ? outcomeLabel(o.result) : '실행 안 함';
    const message = o.row.errors.length ? o.row.errors.join(' / ') : (o.result?.message ?? '앞에서 멈춰 실행하지 않았습니다');
    return [o.row.line, ...inputs.map((n) => o.row.values[n] ?? ''), status, message, ...outputs.map((k) => o.result?.outputs[k] ?? '')];
  });
  return { columns, rows };
}

/** 묶음 전체의 한 줄 요약 */
export function batchSummary(outcomes: BatchOutcome[]): { ok: number; fail: number; skipped: number; invalid: number } {
  let ok = 0;
  let fail = 0;
  let skipped = 0;
  let invalid = 0;
  for (const o of outcomes) {
    if (o.row.errors.length) invalid++;
    else if (!o.result) skipped++;
    else if (runVerdict(o.result) === 'ok') ok++;
    else if (runVerdict(o.result) === 'fail') fail++;
    else skipped++;
  }
  return { ok, fail, skipped, invalid };
}
