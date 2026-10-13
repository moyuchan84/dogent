import { TOOL_ARGS, directParts, type ToolName } from './actions';
import { stepCaptures, stepCheck } from './check';
import { SUBMIT_PATTERN, downloadBlocked, hostAllowed } from './policy';
import { parseSkill, type Skill } from './skill';

/**
 * 스킬 품질 검사. 누가 쓰든 같은 기준으로 스킬을 보기 위한 규칙 모음이다.
 *
 * - 오류(error): 실행이 안 되거나 통제를 벗어날 수 있는 문제. 하나라도 있으면 배포할 수 없다.
 * - 경고(warn): 실행은 되지만 모델 판단에 기대거나 결과 확인이 약해 재현성이 떨어지는 부분.
 *
 * 패널의 스킬 만들기 화면, `pnpm skill:lint`, CI가 모두 이 함수를 쓴다.
 */
export interface Finding {
  level: 'error' | 'warn';
  /** 규칙 번호. docs/06-skill-authoring.md의 표와 같다. */
  rule: string;
  /** 문제가 있는 단계 번호. 스킬 전체에 대한 것이면 없다. */
  step?: number;
  message: string;
}

/** A: 경고 없음, B: 경고 1~2개, C: 경고 3개 이상, F: 오류 있음. 배포 기준은 B 이상. */
export type Grade = 'A' | 'B' | 'C' | 'F';

export interface LintReport {
  grade: Grade;
  score: number;
  /** 배포 기준(B 이상)을 넘는지 */
  deployable: boolean;
  findings: Finding[];
  /** 모델 없이 실행되는 단계 수 / 전체 단계 수 */
  direct: { count: number; total: number };
  skill?: Skill;
}

const REF_KEYS = ['ref', 'next_ref', 'add_ref'];

function report(findings: Finding[], direct: { count: number; total: number }, skill?: Skill): LintReport {
  const errors = findings.filter((f) => f.level === 'error').length;
  const warns = findings.length - errors;
  const grade: Grade = errors > 0 ? 'F' : warns === 0 ? 'A' : warns <= 2 ? 'B' : 'C';
  return {
    grade,
    score: Math.max(0, 100 - errors * 30 - warns * 7),
    deployable: grade === 'A' || grade === 'B',
    findings,
    direct,
    skill,
  };
}

export function lintSkill(source: string, policySource?: string): LintReport {
  let skill: Skill;
  try {
    skill = parseSkill(source, policySource);
  } catch (e) {
    return report([{ level: 'error', rule: 'E01', message: (e as Error).message }], { count: 0, total: 0 });
  }

  const findings: Finding[] = [];
  const error = (rule: string, message: string, step?: number) => findings.push({ level: 'error', rule, step, message });
  const warn = (rule: string, message: string, step?: number) => findings.push({ level: 'warn', rule, step, message });

  const inputs = new Map(skill.inputs.map((i) => [i.name, i]));
  const usedInputs = new Set<string>();
  // 앞 단계에서 만들어져 지금 쓸 수 있는 데이터셋과 기록 값
  const datasets = new Set(skill.inputs.flatMap((i) => (i.type === 'file' && i.dataset ? [i.dataset] : [])));
  const usedDatasets = new Set<string>();
  const outputs = new Set<string>();
  let directCount = 0;

  /** 자리표시자를 형식에 맞는 임시 값으로 바꾼다. 인자 원문을 JSON으로 읽어 보기 위해서다. */
  const sample = (text: string) =>
    text
      .replace(/\{(?:out|rows)\.[a-z_][a-z0-9_]*\}/g, '1')
      .replace(/\{([a-z][a-z0-9_]*)\}/g, (whole, name: string) =>
        inputs.has(name) ? (inputs.get(name)!.type === 'number' ? '1' : 'x') : whole,
      );

  const needDataset = (name: string, step: number) => {
    usedDatasets.add(name);
    if (!datasets.has(name)) error('E05', `데이터셋 "${name}"을 쓰지만 앞 단계에서 만들지 않았습니다`, step);
  };

  skill.steps.forEach((text, idx) => {
    const n = idx + 1;
    const last = n === skill.steps.length;

    for (const m of text.matchAll(/\{([a-z][a-z0-9_]*)\}/g)) {
      if (inputs.has(m[1])) usedInputs.add(m[1]);
      else error('E03', `{${m[1]}}은(는) 선언한 입력이 아닙니다`, n);
    }
    for (const m of text.matchAll(/\{out\.([a-z_][a-z0-9_]*)\}/g)) {
      if (!outputs.has(m[1])) error('E03', `{out.${m[1]}}을 쓰지만 앞 단계에 "기록: ${m[1]} = ..."이 없습니다`, n);
    }
    for (const m of text.matchAll(/\{rows\.([a-z_][a-z0-9_]*)\}/g)) needDataset(m[1], n);

    const check = stepCheck(text);
    const parts = directParts(text);
    let tool: ToolName | undefined;
    let args: Record<string, any> | undefined;

    if (!parts) {
      warn('W02', '도구와 인자가 적혀 있지 않아 모델이 동작을 정합니다. "도구로 ..." 형식과 `{...}` 인자로 적으세요', n);
    } else {
      tool = parts.tool;
      try {
        args = JSON.parse(sample(parts.literal));
      } catch (e) {
        error('E02', `인자가 JSON이 아닙니다: ${(e as Error).message}`, n);
      }
      if (args) {
        // 요소는 이름으로 적으므로 번호 자리에 임시 값을 넣고 나머지 형식을 본다.
        const probe = { ...args };
        for (const key of REF_KEYS) if (typeof probe[key] === 'string') probe[key] = 0;
        const parsed = TOOL_ARGS[tool].safeParse(probe);
        if (!parsed.success) {
          error('E02', `${tool}의 인자 형식이 맞지 않습니다: ${parsed.error.issues.map((i) => `${i.path.join('.')} ${i.message}`).join('; ')}`, n);
          args = undefined;
        } else directCount++;
      }
    }

    if (tool && args) {
      if (tool === 'navigate' && !hostAllowed(String(args.url), skill.domains)) {
        error('E06', `${args.url} 은(는) domains(${skill.domains.join(', ')})에 없는 주소입니다`, n);
      }
      if (tool === 'click' && typeof args.ref === 'string' && SUBMIT_PATTERN.test(args.ref)) {
        const label = args.ref.trim();
        if (skill.risk !== 'R3') error('E04', `"${label}"은(는) 저장·상신 계열 버튼입니다. risk를 R3로 선언해야 합니다`, n);
        else if (!skill.submit_steps.includes(n)) error('E04', `"${label}"을(를) 누르는 단계인데 submit_steps에 ${n}이 없습니다`, n);
        else if (skill.submit_labels.length > 0 && !skill.submit_labels.includes(label)) {
          error('E04', `"${label}"이(가) submit_labels(${skill.submit_labels.join(', ')})에 없습니다`, n);
        }
      }
      if (tool === 'download_table' && typeof args.ref === 'string') {
        const blocked = downloadBlocked(args.ref);
        if (blocked) error('E04', `${blocked}. 저장·상신은 click 단계로 적고 R3로 선언하세요`, n);
      }
      if (tool === 'transform') needDataset(args.source, n);
      if (tool === 'fill_table') needDataset(args.dataset, n);
      if (tool === 'write_excel') for (const s of args.sheets) needDataset(s.dataset, n);
      if (tool === 'extract_table' || tool === 'download_table') datasets.add(args.dataset);
      if (tool === 'transform') datasets.add(args.target);
    }

    if (!check) {
      if (!(tool === 'finish' && last)) {
        warn('W01', '검사 식이 없어 단계가 끝났는지를 모델이 판단합니다. "- 검사:" 줄을 추가하세요', n);
      }
    } else if (tool === 'click' && check.every((c) => c.kind === 'did')) {
      warn('W03', '누른 뒤 화면에 무엇이 보여야 하는지가 없습니다. 검사에 text("...") 같은 결과 조건을 더하세요', n);
    }
    if (last && tool !== 'finish') {
      warn('W05', '마지막 단계가 finish가 아닙니다. 결과 보고 문구를 스킬에 적어 두세요', n);
    }
    for (const c of stepCaptures(text)) outputs.add(c.name);
  });

  if (skill.risk === 'R3' && skill.submit_steps.length === 0) {
    error('E04', 'risk가 R3인데 submit_steps가 비어 있습니다. 저장·상신하는 단계 번호를 선언하세요');
  }
  if (skill.risk === 'R3' && skill.submit_steps.length > 0 && skill.submit_labels.length === 0) {
    warn('W06', 'submit_labels가 비어 있어 저장·상신 계열 버튼 전부가 승인 대상이 됩니다. 누를 버튼 이름을 적으세요');
  }
  for (const i of skill.inputs) {
    if (i.type === 'file') {
      if (!usedDatasets.has(i.dataset!)) warn('W04', `파일 입력 "${i.name}"의 데이터셋 "${i.dataset}"을 쓰는 단계가 없습니다`);
    } else if (!usedInputs.has(i.name)) warn('W04', `입력 "${i.name}"을(를) 쓰는 단계가 없습니다`);
  }
  if (skill.risk === 'R3' && skill.rules.length === 0 && skill.inputs.some((i) => i.type !== 'file' && i.type !== 'enum')) {
    warn('W07', '저장·상신하는 스킬인데 입력값 규칙(policy.yaml)이 없습니다. 넣으면 안 되는 값을 규칙으로 막으세요');
  }
  if (!/^##\s*예외\s*$/m.test(skill.body)) {
    warn('W08', '"## 예외" 절이 없습니다. 오류 메시지가 나오거나 결과가 없을 때 어떻게 할지 적으세요');
  }
  if (skill.limits.max_steps < skill.steps.length * 2) {
    warn('W09', `max_steps(${skill.limits.max_steps})가 단계 수(${skill.steps.length})의 2배보다 작아 재시도 여유가 없습니다`);
  }

  return report(findings, { count: directCount, total: skill.steps.length }, skill);
}
