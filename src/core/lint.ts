import { TOOL_ARGS, directParts, type ToolName } from './actions';
import { stepCaptures, stepCheck } from './check';
import { SUBMIT_PATTERN, downloadBlocked, hostAllowed } from './policy';
import { scriptLang } from './script';
import { parseSkill, type Skill } from './skill';

/**
 * 스킬 품질 검사. 누가 쓰든 같은 기준으로 스킬을 보기 위한 규칙 모음이다.
 *
 * - 오류(error): 실행이 안 되거나 통제를 벗어날 수 있는 문제. 하나라도 있으면 배포할 수 없다.
 * - 경고(warn): 실행은 되지만 결과 확인이 약하거나 통제가 빠져 재현성이 떨어지는 부분.
 * - 안내(info): 등급에 들어가지 않는 참고. 목표만 적힌 단계(모델이 화면을 보고 수행)가 그렇다.
 *
 * 패널의 스킬 만들기 화면, `pnpm skill:lint`, CI가 모두 이 함수를 쓴다.
 */
export interface Finding {
  level: 'error' | 'warn' | 'info';
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
  const warns = findings.filter((f) => f.level === 'warn').length;
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

/** files는 스킬 폴더의 다른 파일 (경로 → 내용). 주면 선언한 스크립트가 실제로 있는지도 본다 */
export function lintSkill(source: string, policySource?: string, files?: Record<string, string>): LintReport {
  let skill: Skill;
  try {
    skill = parseSkill(source, policySource, files);
  } catch (e) {
    return report([{ level: 'error', rule: 'E01', message: (e as Error).message }], { count: 0, total: 0 });
  }

  const findings: Finding[] = [];
  const error = (rule: string, message: string, step?: number) => findings.push({ level: 'error', rule, step, message });
  const warn = (rule: string, message: string, step?: number) => findings.push({ level: 'warn', rule, step, message });
  const info = (rule: string, message: string, step?: number) => findings.push({ level: 'info', rule, step, message });

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

  // run_skill로 부른 스킬이 만드는 데이터셋은 이름을 알 수 없어, 그 뒤로는 데이터셋 존재 검사를 하지 않는다.
  let unknownDatasets = false;
  const needDataset = (name: string, step: number) => {
    usedDatasets.add(name);
    if (!datasets.has(name) && !unknownDatasets) error('E05', `데이터셋 "${name}"을 쓰지만 앞 단계에서 만들지 않았습니다`, step);
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
      // 목표만 적힌 단계는 모델이 화면을 보고 수행한다. 화면이나 값이 달라져도 맞춰 가므로 유연하지만, 매번 모델을 부른다.
      info('I01', '목표 단계: 모델이 화면을 보고 수행합니다. 늘 같은 동작이면 녹화한 빠른 경로("도구로 ..." + `{...}` 인자)를 붙이면 빨라집니다', n);
      // 목표 단계가 "데이터셋 `이름`에 담는다"처럼 만들 데이터셋을 적었으면 뒤 단계가 그 이름을 쓸 수 있다
      for (const m of text.matchAll(/데이터셋\s*`([^`]+)`/g)) datasets.add(m[1]);
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
      if ((tool === 'navigate' || tool === 'open_tab') && !hostAllowed(String(args.url), skill.domains)) {
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
      if (tool === 'run_skill') unknownDatasets = true;
      if (tool === 'run_script') {
        if (!skill.scripts.some((s) => s.name === args.script)) error('E07', `스크립트 "${args.script}"을(를) 선언부의 scripts에 적지 않았습니다`, n);
        for (const d of args.datasets ?? []) needDataset(d, n);
        // 스크립트가 돌려주는 데이터셋은 이름을 미리 알 수 없다
        unknownDatasets = true;
        outputs.add(args.name ?? 'script');
      }
      if (tool === 'transform') needDataset(args.source, n);
      if (tool === 'fill_table') needDataset(args.dataset, n);
      if (tool === 'write_excel') for (const s of args.sheets) needDataset(s.dataset, n);
      if (tool === 'write_html') {
        for (const d of [...(args.datasets ?? []), ...(args.charts ?? []).map((c: { dataset: string }) => c.dataset)]) needDataset(d, n);
      }
      if (tool === 'excel_write') needDataset(args.dataset, n);
      if (tool === 'extract_table' || tool === 'download_table' || tool === 'excel_read') datasets.add(args.dataset);
      if (tool === 'call_tool' && args.dataset) datasets.add(args.dataset);
      if (tool === 'transform') datasets.add(args.target);
      if (tool === 'summarize') {
        if (args.source !== 'page') needDataset(args.source, n);
        outputs.add(args.name ?? 'summary');
      }
    }

    // 마지막 목표 단계("정리해 보고한다")는 모델이 finish로 보고하며 끝낸다.
    const closingGoal = last && !parts;
    if (!check) {
      if (!(tool === 'finish' && last) && !closingGoal) {
        warn('W01', '검사 식이 없어 단계가 끝났는지를 모델이 판단합니다. "- 검사:" 줄을 추가하세요', n);
      }
    } else if (tool === 'click' && check.every((c) => c.kind === 'did')) {
      warn('W03', '누른 뒤 화면에 무엇이 보여야 하는지가 없습니다. 검사에 text("...") 같은 결과 조건을 더하세요', n);
    }
    if (last && tool !== 'finish' && !closingGoal) {
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
  for (const s of skill.scripts) {
    const code = skill.scriptSources[s.file];
    if (files && code === undefined) error('E07', `스크립트 ${s.file}이(가) 스킬 폴더에 없습니다`);
    if (scriptLang(s.file) === 'python') warn('W10', `${s.file}: Python 스크립트는 권한 모드 없이 PC 권한 그대로 돕니다. 되도록 Node(.mjs)로 쓰세요`);
    if (code !== undefined && !s.network && /\b(fetch\s*\(|https?\.request|XMLHttpRequest|WebSocket|urllib|requests\.|http\.client|socket\.)/.test(code)) {
      warn('W10', `${s.file}이(가) 네트워크를 쓰는 것 같은데 network: true로 선언하지 않았습니다`);
    }
  }
  if (skill.limits.max_steps < skill.steps.length * 2) {
    warn('W09', `max_steps(${skill.limits.max_steps})가 단계 수(${skill.steps.length})의 2배보다 작아 재시도 여유가 없습니다`);
  }

  return report(findings, { count: directCount, total: skill.steps.length }, skill);
}
