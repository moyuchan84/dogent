import { SUBMIT_PATTERN, looksLikeDownload } from './policy';
import type { PageDialog, PageSnapshot, RecordedEvent } from './types';

/**
 * 녹화한 조작으로 스킬 초안을 만든다.
 *
 * 사람이 형식을 외워 쓰지 않아도 모든 초안이 같은 모양으로 나오게 하는 것이 목적이다.
 * - 단계는 전부 "도구로 ..." + `{...}` 인자 형식이라 모델 없이 실행된다.
 * - 단계마다 검사 식이 붙는다.
 * - 저장·상신 계열 버튼을 누르면 R3, submit_steps, submit_labels가 자동으로 선언된다.
 */
export type AuthorStep = (
  /** dialogs는 누른 뒤에 뜬 알림·확인 창과 사람이 한 답이다. */
  | (Extract<RecordedEvent, { kind: 'click' }> & { expect?: string; dialogs?: PageDialog[] })
  /**
   * variable이면 실행할 때마다 입력받고, 아니면 녹화한 값을 그대로 쓴다.
   * param은 입력받을 때의 이름(영문)과 설명이다. 설명은 요청을 해석할 때 모델이 값을 뽑는 근거가 된다.
   */
  | (Extract<RecordedEvent, { kind: 'type' | 'select' }> & { variable: boolean; param?: { name?: string; description?: string } })
  /** next는 다음 페이지 버튼의 이름. 있으면 마지막 페이지까지 넘기며 읽는다. */
  | { kind: 'extract'; name: string; next?: string }
  /**
   * 엑셀 파일의 행을 표에 채운다. columns는 표에서 값을 넣을 수 있는 컬럼(= 엑셀 파일의 첫 행),
   * add는 빈 행이 모자랄 때 누를 버튼의 이름이다.
   */
  | { kind: 'fill'; name: string; columns: string[]; add?: string }
  /** 말로 적은 단계. 클릭 대신 할 일을 문장으로 두고, 실행할 때 모델이 화면을 보고 수행한다. */
  | { kind: 'goal'; text: string }
  /**
   * 화면 정리. 화면의 글(source "page")이나 표를 지시대로 정리해 보고에 넣는다.
   * 표면 그 표를 읽은 뒤(next가 있으면 끝 페이지까지) 정리한다.
   */
  | { kind: 'summarize'; instruction: string; source: 'page' | { table: string; next?: string } }
) & {
  /** 이 조작의 목적. 빠른 경로가 실패했을 때 모델이 같은 일을 하는 요소를 찾는 근거가 된다. */
  note?: string;
};

/** 입력 이름으로 쓸 수 있는지 (스킬의 {name} 규칙) */
export const PARAM_NAME = /^[a-z][a-z0-9_]*$/;

export interface DraftMeta {
  id: string;
  name: string;
  description: string;
  owner: string;
}

export interface DraftStart {
  url: string;
  /** 시작 화면의 제목. 화면이 맞게 열렸는지 검사하는 데 쓴다. */
  heading?: string;
}

/** 같은 칸을 고쳐 입력한 것은 마지막 값만 남긴다. */
export function addRecorded(steps: AuthorStep[], event: RecordedEvent): AuthorStep[] {
  const prev = steps[steps.length - 1];
  if (event.kind === 'click') return [...steps, event];
  const step = { ...event, variable: true } as AuthorStep;
  if (prev && prev.kind === event.kind && prev.name === event.name) return [...steps.slice(0, -1), step];
  return [...steps, step];
}

/** 화면의 제목 하나. 시작 화면을 알아보는 데 쓴다. */
export function firstHeading(snap: PageSnapshot): string | undefined {
  const h = snap.items.find((i) => i.kind === 'heading');
  return h?.kind === 'heading' ? h.text : undefined;
}

const textsOf = (snap: PageSnapshot) =>
  snap.items.flatMap((i) => (i.kind === 'heading' || i.kind === 'text' ? [{ heading: i.kind === 'heading', text: i.text }] : []));

/**
 * 버튼을 누른 뒤 화면에 새로 나타난 글자 중 "눌린 결과"로 검사할 만한 것을 고른다.
 * 건수나 번호처럼 매번 바뀌는 부분은 잘라내고 앞의 고정된 글자만 쓴다.
 */
export function pickAppeared(before: PageSnapshot, after: PageSnapshot): string | undefined {
  const seen = new Set(textsOf(before).map((t) => t.text));
  const fresh = textsOf(after).filter((t) => !seen.has(t.text));
  for (const { text } of [...fresh.filter((t) => t.heading), ...fresh.filter((t) => !t.heading)]) {
    let s = text.split(/\d/)[0];
    const sentence = /^.*?[.!?](?=\s|$)/.exec(s);
    if (sentence) s = sentence[0];
    s = s.replace(/[\s:\-–([]+$/, '').trim();
    if (s.length >= 1 && !s.includes('"')) return s.slice(0, 40);
  }
  return undefined;
}

const INPUT_ROLES = new Set(['textbox', 'combobox', 'checkbox', 'radio']);

/** 표의 컬럼 중 값을 넣을 수 있는 것. 칸 안의 입력 칸은 컬럼 이름으로 읽히므로 그 이름으로 가린다. */
export function fillableColumns(snap: PageSnapshot, columns: string[]): string[] {
  const names = new Set(snap.items.flatMap((i) => (i.kind === 'el' && INPUT_ROLES.has(i.role) ? [i.name] : [])));
  const editable = columns.filter((c) => names.has(c));
  return editable.length > 0 ? editable : columns;
}

/** 화면에서 행 추가 버튼으로 보이는 요소의 이름 (이름이 하나뿐인 것만) */
export function addRowButtons(snap: PageSnapshot): string[] {
  const names = snap.items.flatMap((i) =>
    i.kind === 'el' && (i.role === 'button' || i.role === 'link') && !i.row && /추가|add|^\+$/i.test(i.name.trim()) ? [i.name] : [],
  );
  return names.filter((n) => names.indexOf(n) === names.lastIndexOf(n));
}

const q = (s: string) => JSON.stringify(s);
/** 검사 식의 "..." 안에 쓸 수 있는 글자인지 */
const quotable = (s: string) => s !== '' && !/["`\n]/.test(s);

/** 주소에서 화면을 알아볼 수 있는 부분(경로)만 꺼낸다. 검사 식의 url("...")에 쓴다. */
function urlKey(url: string): string {
  const u = new URL(url);
  return u.pathname.length > 1 ? u.pathname : u.host;
}

export function draftSkill(meta: DraftMeta, start: DraftStart, steps: AuthorStep[]): { source: string; notes: string[] } {
  const notes: string[] = [];
  const lines: string[] = [];
  const inputs: string[] = [];
  const submitSteps: number[] = [];
  const submitLabels: string[] = [];
  const datasets: string[] = [];
  const filled: string[] = [];
  let n = 0;
  let vars = 0;

  const push = (head: string, literal: object | null, check?: string, note?: string) => {
    lines.push(`${++n}. ${head}`);
    if (literal) lines.push(`   \`${JSON.stringify(literal)}\``);
    // 목적은 모델이 읽는 줄이다. 빠른 경로가 실패하면 이 문장을 보고 같은 일을 하는 요소를 찾는다.
    if (note?.trim()) lines.push(`   - 목적: ${note.trim().replace(/\s*\n\s*/g, ' ')}`);
    if (check) lines.push(`   - 검사: ${check}`);
  };
  const usedNames = new Set<string>();
  /** 입력 이름을 정한다. 사람이 붙인 이름이 규칙에 맞고 겹치지 않으면 그것을, 아니면 v1, v2… */
  const paramName = (wanted?: string) => {
    const w = wanted?.trim();
    if (w && PARAM_NAME.test(w) && !usedNames.has(w)) {
      usedNames.add(w);
      return w;
    }
    if (w) notes.push(`입력 이름 "${w}"은(는) 영문 소문자로 시작하는 영문·숫자·_만 쓸 수 있고 겹치면 안 되어 v${vars + 1}로 바꿨습니다.`);
    let name: string;
    do name = `v${++vars}`;
    while (usedNames.has(name));
    usedNames.add(name);
    return name;
  };
  const summaries: string[] = [];
  /** 이름을 읽지 못했거나 여럿이라 그대로는 실행할 수 없는 조작 */
  const vague = (what: string, step: AuthorStep & { name: string; dup?: boolean; row?: string }) => {
    if (step.name === '') {
      notes.push(`${n + 1}단계: 요소의 이름을 읽지 못했습니다. 어떤 요소인지 글로 설명해 주세요 (모델이 찾습니다).`);
      lines.push(`${++n}. 화면에서 (여기에 요소를 설명) ${what}`);
      return true;
    }
    if (step.dup && step.row) notes.push(`${n + 1}단계: "${step.name}"이(가) 표의 행마다 있어 "${step.row}" 글자가 있는 행의 것으로 적었습니다. 행이 실행할 때마다 달라지면 "row"를 {입력값}으로 바꾸세요.`);
    else if (step.dup) notes.push(`${n + 1}단계: "${step.name}" 이름의 요소가 화면에 여러 개입니다. 실행할 때 모델이 고르게 되니 위치 설명을 덧붙이세요.`);
    return false;
  };

  const startCheck = [`url(${q(urlKey(start.url))})`, ...(start.heading && quotable(start.heading) ? [`text(${q(start.heading)})`] : [])];
  push(
    `navigate로 ${start.heading ? `"${start.heading}" 화면` : '시작 화면'}으로 이동한다. args는 다음을 그대로 쓴다. 이미 열려 있으면 이동하지 않는다.`,
    { url: start.url },
    startCheck.join(' and '),
  );

  // 표를 엑셀로 채우기로 했으면, 해 보이느라 표에 직접 넣은 값과 행 추가 누름은 엑셀 파일과 fill_table이 대신한다.
  const fills = steps.filter((s): s is Extract<AuthorStep, { kind: 'fill' }> => s.kind === 'fill');
  const byHand = (s: AuthorStep) =>
    ((s.kind === 'type' || s.kind === 'select') && fills.some((f) => f.columns.includes(s.name))) ||
    (s.kind === 'click' && fills.some((f) => f.add === s.name));
  const dropped = steps.filter(byHand).length;
  if (dropped > 0) notes.push(`표에 직접 넣은 값과 행 추가 누름 ${dropped}개는 뺐습니다. 실행할 때는 엑셀 파일의 행이 표에 들어갑니다.`);

  const recorded = steps.filter((s) => !byHand(s));
  // 마지막이 말로 적은 단계면 그 단계가 결과를 정리해 보고한다 (모델이 finish로 끝냄). 고정 문구의 finish를 붙이지 않는다.
  const closing = recorded.at(-1)?.kind === 'goal' ? (recorded.pop() as Extract<AuthorStep, { kind: 'goal' }>) : undefined;

  for (const step of recorded) {
    if (step.kind === 'goal') {
      push(step.text.trim().replace(/\s*\n\s*/g, ' '), null, undefined, step.note);
      notes.push(`${n}단계: 말로 적은 단계라 실행할 때 모델이 화면을 보고 수행합니다. 끝났는지 확인할 조건이 있으면 "- 검사:" 줄을 더하세요 (없으면 모델이 판단합니다).`);
      continue;
    }
    if (step.kind === 'summarize') {
      const k = summaries.length + 1;
      const report = `report${k}`;
      let source = 'page';
      if (step.source !== 'page') {
        // 정리할 표를 먼저 읽는다. 엑셀로 저장하는 표와는 따로 둔다.
        source = `sum${k}`;
        push(
          `extract_table로 "${step.source.table}" 표를 ${step.source.next ? `"${step.source.next}" 버튼으로 마지막 페이지까지 넘기며 ` : ''}데이터셋 \`${source}\`에 읽는다. args는 다음을 그대로 쓴다.`,
          step.source.next ? { ref: step.source.table, dataset: source, next_ref: step.source.next } : { ref: step.source.table, dataset: source },
          `dataset(${q(source)})`,
        );
      }
      summaries.push(report);
      push(
        `summarize로 ${source === 'page' ? '화면의 글' : `"${(step.source as { table: string }).table}" 표`}을(를) 정리한다. args는 다음을 그대로 쓴다.`,
        { instruction: step.instruction.trim(), source, name: report },
        'did("summarize")',
        step.note,
      );
      notes.push(`${n}단계: 정리할 자료(${source === 'page' ? '화면 글 12,000자' : '표 앞 200행'}까지)를 사내 모델에 보냅니다. 표가 크면 집계(transform) 단계를 앞에 두는 편이 정확합니다.`);
      continue;
    }
    if (step.kind === 'fill') {
      const k = filled.length + 1;
      const dataset = `src${k}`;
      filled.push(dataset);
      inputs.push(
        `  - name: file${k}`,
        `    label: ${q(`엑셀 파일 (${step.columns.join(', ')})`)}`,
        '    type: file',
        `    dataset: ${dataset}`,
        '    required: true',
      );
      push(
        `fill_table로 엑셀 데이터 \`${dataset}\`을 "${step.name}" 표에 채운다. args는 다음을 그대로 쓴다.`,
        { ref: step.name, dataset, ...(step.add ? { add_ref: step.add } : {}) },
        'did("fill_table")',
        step.note,
      );
      notes.push(`${n}단계: 엑셀 파일의 첫 행은 표의 컬럼 이름(${step.columns.join(', ')})과 같아야 합니다. 표는 비어 있어야 하고, 넣은 값은 화면에서 다시 읽어 파일과 대조합니다.`);
      if (!step.add) notes.push(`${n}단계: 행 추가 버튼을 정하지 않아, 엑셀의 행이 화면의 빈 행보다 많으면 멈춥니다. 필요하면 인자에 "add_ref": "버튼 이름"을 더하세요.`);
      continue;
    }
    if (step.kind === 'extract') {
      const dataset = `data${datasets.length + 1}`;
      datasets.push(dataset);
      push(
        `extract_table로 "${step.name}" 표를 ${step.next ? `"${step.next}" 버튼으로 마지막 페이지까지 넘기며 ` : ''}데이터셋 \`${dataset}\`에 추출한다. args는 다음을 그대로 쓴다.`,
        step.next ? { ref: step.name, dataset, next_ref: step.next } : { ref: step.name, dataset },
        `dataset(${q(dataset)})`,
        step.note,
      );
      if (!step.next) notes.push(`${n}단계: 표가 여러 페이지면 인자에 "next_ref": "다음" 처럼 다음 페이지 버튼 이름을 더하세요.`);
      continue;
    }
    if (step.kind === 'click') {
      if (vague('요소를 한 번 누른다.', step)) continue;
      if (looksLikeDownload(step.name)) {
        const dataset = `data${datasets.length + 1}`;
        datasets.push(dataset);
        push(
          `download_table로 "${step.name}" 버튼을 눌러 받은 파일을 데이터셋 \`${dataset}\`에 담는다. args는 다음을 그대로 쓴다.`,
          { ref: step.name, dataset },
          `dataset(${q(dataset)})`,
          step.note,
        );
        notes.push(`${n}단계: "${step.name}"을(를) 파일 내려받기로 보고 받은 파일을 읽게 했습니다. 내려받기가 아니면 도구를 click으로 바꾸세요.`);
        continue;
      }
      const toggle = step.role === 'checkbox' || step.role === 'radio';
      const shown = step.dialogs ?? [];
      const agreed = shown.filter((d) => d.kind === 'confirm' && d.accepted);
      // 마지막 알림 창의 첫 문장. 접수 번호처럼 매번 달라지는 뒷부분은 검사에 넣지 않는다.
      const said = shown.filter((d) => d.kind === 'alert').pop()?.message.split(/[.!?\n]/)[0].trim();
      const parts = toggle
        ? [`value(${q(step.name)}) == "선택됨"`]
        : ['did("click")', ...(step.expect ? [`text(${q(step.expect)})`] : []), ...(said && quotable(said) ? [`dialog(${q(said)})`] : [])];
      // 버튼 이름이 평범해도 "상신하시겠습니까?"에 확인을 눌렀으면 제출이다.
      const submit = SUBMIT_PATTERN.test(step.name) || agreed.some((d) => SUBMIT_PATTERN.test(d.message));
      const accept = agreed.length > 0 && !submit;
      push(
        `click으로 "${step.name}" ${toggle ? '항목을 선택한다' : '버튼을 한 번 누른다'}. args는 다음을 그대로 쓴다.${submit ? ' 누르기 전에 사용자 승인을 받는다.' : ''}`,
        { ref: step.name, ...(step.dup && step.row ? { row: step.row } : {}), ...(accept ? { accept_dialog: true } : {}) },
        quotable(step.name) ? parts.join(' and ') : undefined,
        step.note,
      );
      if (accept) notes.push(`${n}단계: 확인 창 "${agreed[0].message}"에 확인을 누르도록 적었습니다 ("accept_dialog").`);
      if (said) notes.push(`${n}단계: 알림 창의 접수 번호 같은 값을 결과에 남기려면 \`- 기록: 이름 = dialog_text("정규식")\` 줄을 더하세요.`);
      if (shown.some((d) => d.kind === 'prompt')) notes.push(`${n}단계: 값을 묻는 입력 창이 떴습니다. 에이전트는 이 창에 답할 수 없어 이 단계에서 멈춥니다.`);
      if (submit) {
        submitSteps.push(n);
        if (!submitLabels.includes(step.name.trim())) submitLabels.push(step.name.trim());
      }
      continue;
    }
    // 입력·선택
    const verb = step.kind === 'type' ? '입력한다' : '선택한다';
    if (vague(`칸에 값을 ${verb}.`, step)) continue;
    let value = step.value;
    if (step.variable) {
      const name = paramName(step.param?.name);
      value = `{${name}}`;
      const description = step.param?.description?.trim();
      inputs.push(
        `  - name: ${name}`,
        `    label: ${q(step.name)}`,
        ...(description ? [`    description: ${q(description)}`] : []),
        ...(step.kind === 'select'
          ? ['    type: enum', `    values: [${step.options.map(q).join(', ')}]`]
          : [`    type: ${step.numeric ? 'number' : step.multiline ? 'text' : 'string'}`]),
        '    required: true',
      );
    }
    const key = step.kind === 'type' ? 'text' : 'value';
    push(
      `${step.kind === 'type' ? 'type으로' : 'select로'} "${step.name}"${step.kind === 'type' ? '을(를)' : '에서 값을'} ${verb}. args는 다음을 그대로 쓴다.`,
      { ref: step.name, [key]: value },
      quotable(step.name) && quotable(value) ? `value(${q(step.name)}) == ${q(value)}` : undefined,
      step.note,
    );
  }

  if (datasets.length > 0) {
    push(
      'write_excel로 엑셀 파일을 저장한다. args는 다음을 그대로 쓴다.',
      { filename: meta.name, sheets: datasets.map((d, i) => ({ name: `표${i + 1}`, dataset: d })) },
      'did("write_excel")',
    );
  }
  const done =
    datasets.length > 0
      ? `${datasets.map((d, i) => `표${i + 1} {rows.${d}}행`).join(', ')}을 저장했습니다. 파일: ${meta.name}.xlsx`
      : filled.length > 0
        ? `${filled.map((d) => `{rows.${d}}행`).join(', ')}을 표에 입력하고 ${meta.name}을(를) 마쳤습니다.`
        : `${meta.name}을(를) 마쳤습니다.`;
  if (closing) {
    push(closing.text.trim().replace(/\s*\n\s*/g, ' '), null, undefined, closing.note);
    notes.push(`${n}단계: 마지막 단계를 말로 적어, 모델이 정리해 보고하며 끝냅니다.${summaries.length ? ` 앞에서 정리한 내용은 {out.${summaries[0]}}처럼 보고에 넣을 수 있습니다.` : ''}`);
  } else {
    // 정리한 내용이 있으면 보고 아래에 붙인다.
    const summary = [done, ...summaries.map((r) => `{out.${r}}`)].join('\n');
    push('finish로 결과를 보고한다. args는 다음을 그대로 쓴다.', { summary });
  }

  const risk = submitSteps.length > 0 ? 'R3' : 'R1';
  if (risk === 'R3') notes.push('저장·상신 버튼이 있어 R3로 선언했습니다. 넣으면 안 되는 값이 있으면 policy.yaml에 규칙을 적으세요.');
  const front = [
    '---',
    `id: ${meta.id}`,
    `name: ${q(meta.name)}`,
    `description: ${q(meta.description)}`,
    'version: 0.1.0',
    `owner: ${q(meta.owner)}`,
    `risk: ${risk}`,
    'domains:',
    `  - ${q(new URL(start.url).host)}`,
    ...(inputs.length ? ['inputs:', ...inputs] : []),
    ...(submitSteps.length ? [`submit_steps: [${submitSteps.join(', ')}]`, `submit_labels: [${submitLabels.map(q).join(', ')}]`] : []),
    'schedulable: false',
    'limits:',
    `  max_steps: ${Math.max(20, n * 3)}`,
    '  timeout_sec: 300',
    '---',
  ];
  const body = [
    '',
    '## 단계',
    '',
    ...lines,
    '',
    '## 예외',
    '',
    '- 화면에 오류 메시지가 나오면 abort로 메시지 원문을 그대로 알린다. 같은 동작을 다시 하지 않는다.',
    '- 입력값을 고쳐 쓰거나 지어내지 않는다. 받은 그대로 넣는다.',
    ...(filled.length > 0 ? ['- fill_table이 실패하면 abort로 오류 메시지를 그대로 알린다. 값을 고치거나 일부만 넣지 않는다.'] : []),
    '',
    '## 결과',
    '',
    datasets.length > 0 ? '저장한 파일 이름과 표의 행 수.' : '작업을 마쳤다는 안내.',
    '',
  ];
  return { source: [...front, ...body].join('\n'), notes };
}
