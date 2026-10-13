import { SUBMIT_PATTERN, looksLikeDownload } from './policy';
import type { PageSnapshot, RecordedEvent } from './types';

/**
 * 녹화한 조작으로 스킬 초안을 만든다.
 *
 * 사람이 형식을 외워 쓰지 않아도 모든 초안이 같은 모양으로 나오게 하는 것이 목적이다.
 * - 단계는 전부 "도구로 ..." + `{...}` 인자 형식이라 모델 없이 실행된다.
 * - 단계마다 검사 식이 붙는다.
 * - 저장·상신 계열 버튼을 누르면 R3, submit_steps, submit_labels가 자동으로 선언된다.
 */
export type AuthorStep =
  | (Extract<RecordedEvent, { kind: 'click' }> & { expect?: string })
  /** variable이면 실행할 때마다 입력받고, 아니면 녹화한 값을 그대로 쓴다. */
  | (Extract<RecordedEvent, { kind: 'type' | 'select' }> & { variable: boolean })
  | { kind: 'extract'; name: string };

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
  let n = 0;
  let vars = 0;

  const push = (head: string, literal: object | null, check?: string) => {
    lines.push(`${++n}. ${head}`);
    if (literal) lines.push(`   \`${JSON.stringify(literal)}\``);
    if (check) lines.push(`   - 검사: ${check}`);
  };
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

  for (const step of steps) {
    if (step.kind === 'extract') {
      const dataset = `data${datasets.length + 1}`;
      datasets.push(dataset);
      push(`extract_table로 "${step.name}" 표를 데이터셋 \`${dataset}\`에 추출한다. args는 다음을 그대로 쓴다.`, { ref: step.name, dataset }, `dataset(${q(dataset)})`);
      notes.push(`${n}단계: 표가 여러 페이지면 인자에 "next_ref": "다음" 처럼 다음 페이지 버튼 이름을 더하세요.`);
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
        );
        notes.push(`${n}단계: "${step.name}"을(를) 파일 내려받기로 보고 받은 파일을 읽게 했습니다. 내려받기가 아니면 도구를 click으로 바꾸세요.`);
        continue;
      }
      const toggle = step.role === 'checkbox' || step.role === 'radio';
      const parts = toggle
        ? [`value(${q(step.name)}) == "선택됨"`]
        : ['did("click")', ...(step.expect ? [`text(${q(step.expect)})`] : [])];
      const submit = SUBMIT_PATTERN.test(step.name);
      push(
        `click으로 "${step.name}" ${toggle ? '항목을 선택한다' : '버튼을 한 번 누른다'}. args는 다음을 그대로 쓴다.${submit ? ' 누르기 전에 사용자 승인을 받는다.' : ''}`,
        step.dup && step.row ? { ref: step.name, row: step.row } : { ref: step.name },
        quotable(step.name) ? parts.join(' and ') : undefined,
      );
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
      const name = `v${++vars}`;
      value = `{${name}}`;
      inputs.push(
        `  - name: ${name}`,
        `    label: ${q(step.name)}`,
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
    );
  }

  if (datasets.length > 0) {
    push(
      'write_excel로 엑셀 파일을 저장한다. args는 다음을 그대로 쓴다.',
      { filename: meta.name, sheets: datasets.map((d, i) => ({ name: `표${i + 1}`, dataset: d })) },
      'did("write_excel")',
    );
  }
  const summary =
    datasets.length > 0
      ? `${datasets.map((d, i) => `표${i + 1} {rows.${d}}행`).join(', ')}을 저장했습니다. 파일: ${meta.name}.xlsx`
      : `${meta.name}을(를) 마쳤습니다.`;
  push('finish로 결과를 보고한다. args는 다음을 그대로 쓴다.', { summary });

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
    '',
    '## 결과',
    '',
    datasets.length > 0 ? '저장한 파일 이름과 표의 행 수.' : '작업을 마쳤다는 안내.',
    '',
  ];
  return { source: [...front, ...body].join('\n'), notes };
}
