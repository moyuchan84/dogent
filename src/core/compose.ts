import { z } from 'zod';
import { extractJson } from './actions';
import { firstHeading } from './author';
import { stepCheck, type Clause } from './check';
import { lintSkill, type LintReport } from './lint';
import { SUBMIT_PATTERN } from './policy';
import { SCRIPT_CONTRACT, SCRIPT_NAME } from './script';
import { renderSnapshot } from './snapshot';
import type { ElementItem, LlmPort, PageSnapshot } from './types';

/**
 * 말로 스킬 만들기. 사람이 업무를 말로 설명하면 모델이 지금 열린 화면을 보고 스킬 초안을 쓰고,
 * 사람이 말로 고치라고 하면 고친다 (녹화하지 않아도 된다).
 *
 * 모델은 SKILL.md를 직접 쓰지 않고 정해진 모양의 JSON(ComposeSpec)만 낸다. 문서는 renderSpec이 만든다.
 * 작은 모델이 YAML·마크다운 형식을 틀리지 않게 하고, 통제(사이트, 저장·상신 선언, 검사 식)를 코드가 정하기 위해서다.
 * - 시작 화면과 domains는 모델이 아니라 지금 탭의 주소로 정한다.
 * - 검사 식은 읽을 수 있는 것만 남기고, 시작 화면에 이미 보이는 글자라 단계를 하기 전에 통과해 버릴 검사는 뺀다.
 * - 품질 검사에 오류가 있으면 그 내용을 모델에 돌려 한 번 더 고치게 한다.
 */
export const COMPOSE_SYSTEM_PROMPT = `당신은 업무 절차서(스킬) 작성자입니다. 사내 웹 화면에서 하는 업무를 사람이 말로 설명하면, 에이전트가 그 화면을 조작해 수행할 수 있는 절차서를 씁니다.

에이전트는 단계마다 화면을 보고 클릭·입력·선택·표 읽기·정리·보고를 스스로 고릅니다. 그래서 단계는 "무엇을 할지"를 문장으로 적습니다. 버튼 좌표나 코드는 쓰지 않습니다.

JSON 객체 하나로만 답합니다.
{
  "id": "<영문 소문자·숫자·하이픈, 예: hold-reason-report>",
  "name": "<짧은 한글 이름>",
  "description": "<무엇을 하는 스킬인지 + 어떤 요청에 쓰는지 한두 문장. 예: '... 한다. \\"8라인 HOLD 사유 정리해줘\\" 같은 요청에 쓴다.'>",
  "risk": "R1 | R2 | R3",
  "tags": ["<찾을 때 쓸 말 3~5개: 화면·시스템 이름, 업무, 대상. 예: 재공, HOLD, 생산>"],
  "inputs": [{"name": "<영문 소문자>", "label": "<한글>", "description": "<요청의 어느 부분이 이 값인지, 예시 값>", "type": "string | number | text | enum", "values": ["<enum일 때 보기>"], "default": "<없으면 생략>", "required": true}],
  "steps": [{"text": "<할 일 한 문장. 입력값은 {name}으로>", "check": "<이 단계를 마친 뒤에만 화면에 보이는 것. 없으면 생략>", "script": "<이 단계에서 부를 스크립트 이름. 없으면 생략>"}],
  "scripts": [{"name": "<영문 소문자, 예: merge-lots>", "lang": "node | python", "description": "<무엇을 받아 무엇을 돌려주는지>", "network": false, "code": "<스크립트 전체>"}],
  "submit": {"step": <저장·상신 버튼을 누르는 steps의 번호(1부터)>, "labels": ["<그 버튼 이름>"]},
  "exceptions": ["<오류 메시지가 나오거나 결과가 없을 때 할 일>"],
  "result": "<마지막에 보고할 내용>"
}

규칙
- 시작 화면으로 이동하는 단계는 쓰지 않습니다 (자동으로 붙습니다). steps는 그 화면이 열린 다음부터입니다.
- 화면 요소는 아래 "지금 화면"에 보이는 이름 그대로 큰따옴표로 적습니다. combobox, textbox 같은 역할 이름은 쓰지 않습니다. 예: "라인"에서 {line}을 선택한다. "조회" 버튼을 누른다. 화면에 없는 이름을 지어내지 않습니다.
- 요청한 일에 필요한 칸만 다룹니다. 요청에 없는 칸(예: 공정을 "전체"로 두기, 값 없이 칸에 입력하기)은 단계로 쓰지 않습니다.
- 실행할 때마다 달라질 값(라인, 제품코드, 날짜, 기준 등)은 inputs로 빼고 단계에서 {name}으로 씁니다. 요청에 "매번 다름", "보통 ○○"라고 한 값은 반드시 inputs로 하고, "보통 ○○"는 default로 둡니다. "선택" 같은 빈 보기는 default로 쓰지 않습니다. 늘 같은 값만 글자로 적습니다.
- 입력의 description은 "8라인 HOLD 사유 정리해줘" 같은 요청에서 값을 뽑는 근거입니다. 요청의 어떤 말이 이 값인지와 예시를 적습니다. 요청에 없을 때 쓸 값이 있으면 default를 줍니다.
- 마지막 단계는 결과를 정리해 보고하는 문장입니다. 예: "공정별 Lot 수와 수량을 정리해 보고한다".
- check에 쓸 수 있는 것: text("글자"), no_text("글자"), url("주소 일부"), value("요소 이름") == "값", dialog("글자"). 여러 개는 and로 잇습니다. 시작 화면에 이미 보이는 글자는 쓰지 않습니다 (단계를 하기 전에 통과해 버립니다). 확실하지 않으면 생략합니다.
- risk: 조회·읽기·내려받기만 하면 R1, 화면에 값을 입력만 하고 저장하지 않으면 R2, 저장·상신·등록·삭제·승인 버튼을 누르면 R3. R3이면 submit을 반드시 적고, 아니면 submit을 생략합니다.
- 스크립트(scripts)는 에이전트의 표 가공(필터·정렬·집계·열 고르기)으로 할 수 없는 일에만 씁니다: 여러 표를 키로 합치기, 정규식으로 글에서 값 뽑기, 날짜 계산, 통계, 복잡한 규칙의 판정 등. 화면 조작에는 쓰지 않습니다. 필요 없으면 scripts를 생략합니다.
  - 스크립트를 부르는 단계는 "앞에서 읽은 표로 ○○를 계산한다"처럼 쓰고 script에 이름을 적습니다. 그 앞 단계에서 표를 읽어 두어야 합니다.
  - lang은 되도록 node(ES 모듈, Node 표준 라이브러리만)로 씁니다. python은 사용자가 원할 때만 씁니다(표준 라이브러리만).
  - ${SCRIPT_CONTRACT.split('\n').join('\n  - ')}
  - datasets의 표는 실행할 때 에이전트가 넘기므로 이름을 정해 두지 말고 Object.values(input.datasets)처럼 받습니다. 표의 열은 이름으로 찾습니다(columns.indexOf("열 이름")).
- 고쳐 달라는 말을 받으면 지금 초안에서 그 부분만 고치고, 나머지는 그대로 둔 전체 JSON을 다시 냅니다.`;

const InputDraft = z.object({
  name: z.string(),
  label: z.string().optional(),
  description: z.string().optional(),
  type: z.enum(['string', 'number', 'text', 'enum']).catch('string'),
  values: z.array(z.string()).optional(),
  default: z.union([z.string(), z.number()]).nullish(),
  required: z.boolean().default(false),
});

const StepDraft = z.union([
  z.string().transform((text) => ({ text, check: undefined as string | undefined, script: undefined as string | undefined })),
  z.object({
    text: z.string(),
    check: z.string().nullish().transform((c) => c ?? undefined),
    script: z.string().nullish().transform((s) => s ?? undefined),
  }),
]);

const ScriptDraft = z.object({
  name: z.string().min(1),
  lang: z.enum(['node', 'python']).catch('node'),
  description: z.string().min(1),
  network: z.boolean().catch(false).default(false),
  code: z.string().min(1),
});

export const ComposeSpec = z.object({
  id: z.string().default('new-skill'),
  name: z.string().min(1),
  description: z.string().min(1),
  risk: z.enum(['R1', 'R2', 'R3']).catch('R1'),
  tags: z.array(z.string()).catch([]).default([]),
  inputs: z.array(InputDraft).default([]),
  steps: z.array(StepDraft).min(1),
  submit: z.object({ step: z.number().int().positive(), labels: z.array(z.string()).default([]) }).nullish(),
  exceptions: z.array(z.string()).default([]),
  result: z.string().default(''),
  scripts: z.array(ScriptDraft).catch([]).default([]),
});
export type ComposeSpec = z.infer<typeof ComposeSpec>;

/** 초안을 쓰는 동안 바뀌지 않는 것: 시작 화면과 담당 부서 */
export interface ComposeStart {
  url: string;
  title?: string;
  /** 시작 화면의 제목 (검사에 쓴다) */
  heading?: string;
  owner?: string;
  /** 시작 화면에 보이던 글자. 단계를 하기 전에 통과해 버릴 검사를 걸러 내는 데 쓴다 */
  seen?: string;
  /** 시작 화면의 요소. 고르기·넣기·누르기 단계를 빠른 경로로 바꾸는 데 쓴다 */
  elements?: StartElement[];
}

export interface ComposeDraft {
  spec: ComposeSpec;
  start: ComposeStart;
  source: string;
  /** 스킬 폴더에 함께 저장할 파일 (scripts/<이름> → 내용) */
  files: Record<string, string>;
  report: LintReport;
  /** 코드가 고친 것, 사람이 알아야 할 것 */
  notes: string[];
}

const q = (s: string) => JSON.stringify(s);
const NAME = /^[a-z][a-z0-9_]*$/;
/** 목표 단계의 검사로 쓸 수 있는 것. 데이터셋·도구 이름은 모델이 실행할 때 정하므로 미리 알 수 없다. */
const GOAL_CLAUSES: Clause['kind'][] = ['text', 'url', 'value', 'dialog'];

function slug(raw: string, taken: Set<string>): string {
  let id = raw
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[^a-z]+|-$/g, '');
  if (!id) id = 'new-skill';
  let out = id;
  for (let k = 2; taken.has(out); k++) out = `${id}-${k}`;
  return out;
}

/** 주소에서 화면을 알아볼 수 있는 부분(경로) */
function urlKey(url: string): string {
  const u = new URL(url);
  return u.pathname.length > 1 ? u.pathname : u.host;
}

/** 화면에 보이는 글자 (검사가 시작 화면에서 이미 통과하는지 볼 때 쓴다) */
function visibleTexts(snap: PageSnapshot | undefined): string {
  if (!snap) return '';
  return snap.items
    .flatMap((i) => (i.kind === 'text' || i.kind === 'heading' ? [i.text] : i.kind === 'el' ? [i.name] : []))
    .join('\n');
}

/** 한 줄 YAML 값 (따옴표가 필요하면 JSON 문자열로) */
const yamlValue = (v: string | number) => (typeof v === 'number' ? String(v) : q(v));

/** 결과를 보고하는 단계의 말 */
const REPORT = /(보고|알려|정리|요약|답한다|답을)/;
/** 고르기 칸의 빈 보기 (기본값으로 쓰면 아무것도 고르지 않은 것이 된다) */
const PLACEHOLDER = /^(선택|선택하세요|전체|-+|)$/;

/** 시작 화면의 요소 (빠른 경로로 바꿀 수 있는지 볼 때 쓴다) */
export interface StartElement {
  role: string;
  name: string;
  value?: string;
  options?: string[];
}

/** 화면에서 이름이 하나뿐인 요소. 표 안의 요소(행마다 있는 버튼 등)는 뺀다 */
function startElements(snap: PageSnapshot | undefined): StartElement[] {
  if (!snap) return [];
  const els = snap.items.filter((i): i is ElementItem => i.kind === 'el' && !i.row && !!i.name && !i.disabled);
  const count = new Map<string, number>();
  for (const e of els) count.set(e.name, (count.get(e.name) ?? 0) + 1);
  return els
    .filter((e) => count.get(e.name) === 1 && e.role !== 'table')
    .map((e) => {
      const options = /^options=\[(.*)\]$/.exec(e.detail ?? '')?.[1];
      return {
        role: e.role,
        name: e.name,
        ...(e.value !== undefined ? { value: e.value } : {}),
        ...(options ? { options: options.split(', ').filter((o) => o !== '…') } : {}),
      };
    });
}

/** 단계 문장 다듬기: 화면 읽기의 역할 이름(combobox 등)을 빼고, 요소 이름은 큰따옴표로 */
function tidy(text: string): string {
  return text
    .trim()
    .replace(/\s*\n\s*/g, ' ')
    .replace(/\b(combobox|textbox|searchbox|button|link|table|checkbox|radio)\s+(?=["'‘“])/gi, '')
    .replace(/[‘'“]([^‘’'"“”]{1,60})[’'”]/g, '"$1"');
}

/** 목표 단계의 검사: 읽을 수 있고, 시작 화면에서 이미 참이 아닌 것만 남긴다 */
function goalChecks(check: string, n: number, shown: string, start: ComposeStart, notes: string[]): string[] {
  if (!check.trim()) return [];
  const kept: string[] = [];
  /** 시작 화면에서 이미 참인 것만 남으면 단계를 하기 전에 통과한다 */
  let onlyTrueAtStart = true;
  for (const raw of check.split(/\s+and\s+/)) {
    const clause = raw.trim();
    let c: Clause | undefined;
    try {
      c = stepCheck(`- 검사: ${clause}`)?.[0];
    } catch {
      notes.push(`${n}단계: 검사 "${clause}"는 읽을 수 없는 식이라 뺐습니다`);
      continue;
    }
    if (!c) continue;
    if (!GOAL_CLAUSES.includes(c.kind)) {
      notes.push(`${n}단계: 검사 "${clause}"는 말로 적은 단계에 쓸 수 없어 뺐습니다 (text, no_text, url, value, dialog만)`);
      continue;
    }
    // 시작 화면에 이미 있는 글자(표 이름, 버튼 이름 등)는 그 단계를 하기 전에 통과한다. 화면이 바뀌는 업무여도 드물게 놓치는 편이 낫다
    if (c.kind === 'text' && !c.negate && c.text && shown.includes(c.text)) {
      notes.push(`${n}단계: 검사 "${clause}"의 글자가 시작 화면에 이미 있어 단계를 하기 전에 통과하므로 뺐습니다`);
      continue;
    }
    const trueAtStart = (c.kind === 'text' && c.negate && !shown.includes(c.text)) || (c.kind === 'url' && start.url.includes(c.text));
    if (!trueAtStart) onlyTrueAtStart = false;
    kept.push(clause);
  }
  if (kept.length && onlyTrueAtStart && start.seen !== undefined) {
    notes.push(`${n}단계: 검사 "${kept.join(' and ')}"는 시작 화면에서 이미 참이라 단계를 하기 전에 통과하므로 뺐습니다. 단계를 마친 뒤에 보이는 글자를 text("...")로 더하세요`);
    return [];
  }
  return kept;
}

interface FastStep {
  head: string;
  args: Record<string, string>;
  /** 없으면 누르기: did("click")에 모델이 적은 결과 조건을 붙인다 */
  check?: string;
}

/**
 * 화면에 하나뿐인 요소를 고르기·넣기·누르기만 하는 단계는 빠른 경로(도구 + 인자)로 바꾼다. 녹화한 단계처럼 모델 없이 돌고,
 * 값이 들어갔는지를 검사로 확인하므로 작은 모델이 같은 동작을 되풀이하다 멈추지 않는다. 실패하면 그 단계만 모델이 "목적" 문장을 보고 다시 한다.
 * 고를 값이 글자로 적혔는데 같은 이름(라벨)의 입력이 있으면 그 입력으로 바꾼다 (모델이 예시 값을 박아 넣는 일이 잦다).
 * 넣을 값이 없는 넣기 단계("제품코드에 값을 입력한다")는 뺀다.
 */
function fastPath(
  text: string,
  inputs: ComposeSpec['inputs'],
  elements: StartElement[],
  ctx: { risk: string; isSubmit: boolean; step: number; notes: string[] },
): FastStep | 'drop' | null {
  const names = [...text.matchAll(/"([^"]{1,60})"/g)].map((m) => m[1]);
  const el = names.length ? elements.find((e) => e.name === names[0]) : undefined;
  if (!el) return null;
  const param = /\{([a-z][a-z0-9_]*)\}/.exec(text)?.[1];
  /** 글자로 적은 값을 같은 이름의 입력으로 바꾼다 */
  const asInput = (literal: string) => {
    const input = inputs.find((i) => i.label?.trim() === el.name || i.name === el.name);
    if (!input) return literal;
    if (input.default === undefined || input.default === null || PLACEHOLDER.test(String(input.default))) input.default = literal;
    ctx.notes.push(`${ctx.step}단계: "${literal}"을(를) 입력 {${input.name}}(으)로 바꿨습니다 (기본값 ${input.default})`);
    return `{${input.name}}`;
  };

  if (el.role === 'combobox' && /(선택|고른|고르|골라)/.test(text)) {
    let value = param ? `{${param}}` : (names[1] ?? /에서 (\S+?)(?:을|를|으로|로)\s*(?:선택|고)/.exec(text)?.[1]);
    if (!value) return null;
    if (!param) {
      if (el.options && !el.options.includes(value)) return null;
      // 처음부터 그 값인 칸을 다시 고르는 단계("공정을 전체로")는 할 일이 없다
      if (el.value === value && !inputs.some((i) => i.label?.trim() === el.name)) {
        ctx.notes.push(`${ctx.step}단계: "${el.name}"은(는) 처음부터 "${value}"라 뺐습니다`);
        return 'drop';
      }
      value = asInput(value);
    }
    return { head: `select로 "${el.name}"에서 ${value}을(를) 선택한다. args는 다음을 그대로 쓴다.`, args: { ref: el.name, value }, check: `value(${q(el.name)}) == ${q(value)}` };
  }
  if ((el.role === 'textbox' || el.role === 'searchbox') && /(입력|넣)/.test(text)) {
    // 값을 적지 않았어도 같은 이름(라벨)의 입력이 있으면 그 입력을 넣는 것으로 본다
    const named = inputs.find((i) => i.label?.trim() === el.name);
    let value = param ? `{${param}}` : (names[1] ?? (named ? `{${named.name}}` : undefined));
    if (!value) {
      ctx.notes.push(`${ctx.step}단계: "${el.name}"에 넣을 값이 없어 뺐습니다. 넣어야 하면 무엇을 넣을지 말해 주세요`);
      return 'drop';
    }
    if (!param && !value.startsWith('{')) value = asInput(value);
    return { head: `type으로 "${el.name}"에 ${value}을(를) 넣는다. args는 다음을 그대로 쓴다.`, args: { ref: el.name, text: value }, check: `value(${q(el.name)}) == ${q(value)}` };
  }
  if ((el.role === 'button' || el.role === 'link') && /(누른|누르|눌러|클릭)/.test(text)) {
    // 저장·상신 버튼은 선언한 단계에서만 누를 수 있다
    if (SUBMIT_PATTERN.test(el.name) && !(ctx.risk === 'R3' && ctx.isSubmit)) return null;
    return { head: `click으로 "${el.name}" ${el.role === 'link' ? '링크' : '버튼'}을 누른다. args는 다음을 그대로 쓴다.`, args: { ref: el.name } };
  }
  return null;
}

/**
 * 초안(JSON)을 SKILL.md로 만든다. 고친 것은 notes에 남긴다.
 * start.seen이 있으면 시작 화면에 이미 보이는 글자의 검사를 뺀다.
 */
export function renderSpec(spec: ComposeSpec, start: ComposeStart): { source: string; notes: string[]; files: Record<string, string> } {
  const notes: string[] = [];
  const url = new URL(start.url);
  const shown = start.seen ?? '';

  // 입력: 이름 규칙에 맞추고, 겹치는 것은 뺀다
  const inputs: ComposeSpec['inputs'] = [];
  const rename = new Map<string, string>();
  for (const i of spec.inputs) {
    let name = i.name.trim().toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^[^a-z]+/, '');
    if (!NAME.test(name)) name = `v${inputs.length + 1}`;
    if (inputs.some((x) => x.name === name)) {
      notes.push(`입력 "${i.name}"이(가) 겹쳐 뺐습니다`);
      continue;
    }
    if (name !== i.name) {
      rename.set(i.name, name);
      notes.push(`입력 이름 "${i.name}"을(를) "${name}"(으)로 바꿨습니다 (영문 소문자·숫자·_)`);
    }
    const placeholder = i.default !== undefined && i.default !== null && PLACEHOLDER.test(String(i.default).trim());
    if (placeholder && String(i.default).trim()) notes.push(`입력 {${name}}의 기본값 "${i.default}"는 빈 보기라 뺐습니다`);
    inputs.push({ ...i, name, ...(placeholder ? { default: undefined } : {}) });
  }
  const fixNames = (text: string) => text.replace(/\{([^{}\s]+)\}/g, (whole, n: string) => (rename.has(n) ? `{${rename.get(n)}}` : whole));

  const lines: string[] = [];
  let n = 0;
  const heading = start.heading && !/["`\n]/.test(start.heading) ? start.heading : undefined;
  lines.push(
    `${++n}. navigate로 ${heading ? `"${heading}" 화면` : '시작 화면'}으로 이동한다. args는 다음을 그대로 쓴다. 이미 열려 있으면 이동하지 않는다.`,
    `   \`${JSON.stringify({ url: start.url })}\``,
    `   - 검사: ${[`url(${q(urlKey(start.url))})`, ...(heading ? [`text(${q(heading)})`] : [])].join(' and ')}`,
  );

  const risk = spec.risk;
  const submitSteps: number[] = [];
  const submitLabels: string[] = [];
  const wantedSubmit = risk === 'R3' && spec.submit && spec.submit.step <= spec.steps.length ? spec.submit : undefined;
  if (wantedSubmit) submitLabels.push(...wantedSubmit.labels.map((l) => l.trim()).filter((l) => l && !/["\n]/.test(l)));

  // 스크립트: 이름을 규칙에 맞추고 파일로 만든다
  const files: Record<string, string> = {};
  const scripts: { name: string; file: string; description: string; network: boolean }[] = [];
  const scriptName = new Map<string, string>();
  for (const s of spec.scripts) {
    let name = s.name.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^[^a-z]+|-+$/g, '');
    if (!SCRIPT_NAME.test(name)) name = `script${scripts.length + 1}`;
    if (scripts.some((x) => x.name === name)) {
      notes.push(`스크립트 "${s.name}"이(가) 겹쳐 뺐습니다`);
      continue;
    }
    const file = `scripts/${name}.${s.lang === 'python' ? 'py' : 'mjs'}`;
    scriptName.set(s.name, name);
    scripts.push({ name, file, description: s.description.trim().replace(/\s*\n\s*/g, ' '), network: s.network });
    files[file] = s.code.replace(/\r\n/g, '\n').replace(/\n*$/, '\n');
  }
  const usedScripts = new Set<string>();

  spec.steps.forEach((step, idx) => {
    let text = tidy(fixNames(step.text));
    const checks = goalChecks(step.check ? fixNames(step.check) : '', n + 1, shown, start, notes);
    const isSubmit = wantedSubmit?.step === idx + 1;
    const script = step.script ? scriptName.get(step.script) : undefined;
    if (step.script && !script) notes.push(`${n + 1}단계: 스크립트 "${step.script}"이(가) scripts에 없어 부르지 않습니다`);
    if (script) {
      usedScripts.add(script);
      text = `${text.replace(/[.。\s]+$/, '')}. 스크립트 "${script}"을(를) run_script로 부르고, 앞에서 읽은 표를 datasets로 넘긴다`;
    }
    const fast = script ? null : fastPath(text, inputs, start.elements ?? [], { risk, isSubmit, step: n + 1, notes });
    if (fast === 'drop') return;
    lines.push(`${++n}. ${fast ? fast.head : text}`);
    if (isSubmit) submitSteps.push(n);
    if (fast) {
      lines.push(`   \`${JSON.stringify(fast.args)}\``, `   - 목적: ${text}`);
      // 고르기·넣기는 값이 들어갔는지를, 누르기는 모델이 적은 결과 조건을 (없으면 누른 것만) 검사한다
      const check = fast.check ?? (checks.length ? `did("click") and ${checks.join(' and ')}` : 'did("click")');
      lines.push(`   - 검사: ${check}`);
    } else if (checks.length) lines.push(`   - 검사: ${checks.join(' and ')}`);
  });

  // 마지막은 결과를 보고하는 단계여야 모델이 finish로 끝낸다. 모델이 빠뜨리면 붙인다.
  // 보고할 내용(spec.result)은 "## 결과" 절에 둔다. 단계 문장에 넣으면 모델이 지어낸 {자리표시자}가 섞인다.
  const lastLine = lines.at(-1) ?? '';
  const lastHead = lines.filter((l) => /^\d+\. /.test(l)).at(-1) ?? '';
  const lastIsGoal = /^\d+\. /.test(lastLine) && !/^\d+\. (navigate|select|type|click)으?로 /.test(lastLine);
  if (lastIsGoal && REPORT.test(lastHead)) {
    /* 모델이 쓴 보고 단계로 끝난다 */
  } else if (lastIsGoal && n > 1) {
    // 검사 없는 마지막 목표 단계("재공 목록에서 HOLD Lot 수를 확인한다")는 보고와 합친다. 단계를 넘기는 판단을 작은 모델에 맡기지 않는다
    lines[lines.length - 1] = `${lastLine.replace(/[.。\s]+$/, '')}. 그 결과를 정리해 보고한다`;
    notes.push(`${n}단계: 마지막 단계에 결과 보고를 합쳤습니다`);
  } else {
    lines.push(`${++n}. 결과를 정리해 보고한다`);
    notes.push(`${n}단계: 결과를 보고하는 단계가 없어 붙였습니다`);
  }

  // 저장·상신 선언
  if (risk === 'R3') {
    if (!wantedSubmit || submitSteps.length === 0) {
      notes.push('R3인데 저장·상신 버튼을 누르는 단계가 정해지지 않았습니다. "몇 단계에서 무슨 버튼을 누른다"고 말해 주세요');
    }
  } else {
    const hit = spec.steps.findIndex((s) => SUBMIT_PATTERN.test(s.text));
    if (hit >= 0) notes.push(`${hit + 2}단계에 저장·상신 계열 말이 있습니다. 실제로 그 버튼을 누르는 일이면 "저장 버튼을 누르는 스킬"이라고 말해 R3로 바꾸세요. 지금은 실행할 때 그 버튼을 누르지 못합니다`);
  }

  const exceptions = spec.exceptions.map((e) => e.trim()).filter(Boolean);
  if (exceptions.length === 0) exceptions.push('화면에 오류 메시지가 나오면 abort로 그 내용을 그대로 알린다.');

  const front = [
    '---',
    `id: ${spec.id}`,
    `name: ${q(spec.name.trim())}`,
    `description: ${q(spec.description.trim())}`,
    'version: 0.1.0',
    `owner: ${q(start.owner?.trim() || '(담당 부서)')}`,
    `risk: ${risk}`,
    'domains:',
    `  - ${q(url.host)}`,
  ];
  const tags = [...new Set(spec.tags.map((t) => t.trim()).filter((t) => t && t.length <= 30))].slice(0, 8);
  if (tags.length) front.push(`tags: [${tags.map(q).join(', ')}]`);
  if (inputs.length) {
    front.push('inputs:');
    for (const i of inputs) {
      front.push(`  - name: ${i.name}`);
      if (i.label?.trim()) front.push(`    label: ${q(i.label.trim())}`);
      if (i.description?.trim()) front.push(`    description: ${q(i.description.trim())}`);
      front.push(`    type: ${i.type}`);
      if (i.type === 'enum' && i.values?.length) front.push(`    values: [${i.values.map(q).join(', ')}]`);
      if (i.default !== undefined && i.default !== null && i.default !== '') front.push(`    default: ${yamlValue(i.default)}`);
      front.push(`    required: ${i.required && (i.default === undefined || i.default === null || i.default === '')}`);
    }
  }
  for (const s of scripts) if (!usedScripts.has(s.name)) notes.push(`스크립트 "${s.name}"을(를) 부르는 단계가 없습니다`);
  if (scripts.length) {
    front.push('scripts:');
    for (const s of scripts) {
      front.push(`  - name: ${s.name}`, `    file: ${s.file}`, `    description: ${q(s.description)}`);
      if (s.network) front.push('    network: true');
    }
  }
  if (submitSteps.length) front.push(`submit_steps: [${submitSteps.join(', ')}]`);
  if (submitLabels.length) front.push(`submit_labels: [${submitLabels.map(q).join(', ')}]`);
  front.push('limits:', `  max_steps: ${Math.max(30, n * 5)}`, '  timeout_sec: 300', '---');

  const source = [
    ...front,
    '',
    '## 단계',
    '',
    ...lines,
    '',
    '## 예외',
    '',
    ...exceptions.map((e) => `- ${e}`),
    ...(spec.result.trim() ? ['', '## 결과', '', spec.result.trim()] : []),
    '',
  ].join('\n');
  return { source, notes, files };
}

export interface ComposeContext {
  /** 지금 열린 화면 (시작 화면) */
  start: ComposeStart;
  snap?: PageSnapshot;
  /** 이미 있는 스킬 id (겹치지 않게) */
  takenIds?: Set<string>;
  signal?: AbortSignal;
}

/** 시작 화면 정보를 스냅샷에서 채운다. */
export function composeStart(url: string, title: string, snap?: PageSnapshot, owner?: string): ComposeStart {
  return { url, title, heading: snap ? firstHeading(snap) : undefined, owner, seen: visibleTexts(snap), elements: startElements(snap) };
}

function pagePart(ctx: ComposeContext): string {
  const head = `주소: ${ctx.start.url}\n제목: ${ctx.start.title ?? ''}`;
  return ctx.snap ? `${head}\n\n${renderSnapshot(ctx.snap, 6000)}` : head;
}

async function ask(llm: LlmPort, user: string, signal?: AbortSignal): Promise<ComposeSpec> {
  const text = await llm.complete(
    [
      { role: 'system', content: COMPOSE_SYSTEM_PROMPT },
      { role: 'user', content: user },
    ],
    signal,
  );
  const json = extractJson(text);
  if (!json) throw new Error('모델이 스킬 초안을 JSON으로 주지 않았습니다');
  const parsed = ComposeSpec.safeParse(JSON.parse(json));
  if (!parsed.success) throw new Error(`모델이 준 초안의 모양이 맞지 않습니다: ${parsed.error.issues.map((i) => `${i.path.join('.')} ${i.message}`).join('; ')}`);
  return parsed.data;
}

function finish(spec: ComposeSpec, ctx: ComposeContext): ComposeDraft {
  const fixed = { ...spec, id: slug(spec.id, ctx.takenIds ?? new Set()) };
  const { source, notes, files } = renderSpec(fixed, ctx.start);
  return { spec: fixed, start: ctx.start, source, files, report: lintSkill(source, undefined, files), notes };
}

/** 품질 검사 오류가 있으면 그 내용을 돌려 한 번 더 고치게 한다. */
async function repair(draft: ComposeDraft, llm: LlmPort, ctx: ComposeContext): Promise<ComposeDraft> {
  const errors = draft.report.findings.filter((f) => f.level === 'error');
  if (errors.length === 0) return draft;
  const list = errors.map((f) => `- ${f.step ? `${f.step}단계(이동 단계 포함 번호): ` : ''}${f.message}`).join('\n');
  try {
    const spec = await ask(llm, `${revisePrompt(draft, ctx)}\n\n## 고칠 점\n품질 검사에서 다음 오류가 나왔습니다. 고쳐 주세요.\n${list}`, ctx.signal);
    const again = finish(spec, ctx);
    // 고친 것이 더 나쁘면 처음 것을 쓴다
    return again.report.findings.filter((f) => f.level === 'error').length <= errors.length ? again : draft;
  } catch {
    return draft;
  }
}

function revisePrompt(draft: ComposeDraft, ctx: ComposeContext): string {
  return `## 지금 화면\n${pagePart(ctx)}\n\n## 지금 초안\n${JSON.stringify(draft.spec, null, 2)}`;
}

/** 업무 설명으로 첫 초안을 쓴다. */
export async function composeSkill(request: string, llm: LlmPort, ctx: ComposeContext): Promise<ComposeDraft> {
  const spec = await ask(llm, `## 지금 화면\n${pagePart(ctx)}\n\n## 만들 업무\n${request}`, ctx.signal);
  return repair(finish(spec, ctx), llm, ctx);
}

/**
 * 말로 고친다. lastRun을 주면(시험 실행 결과) 함께 보여 줘 실패한 곳을 고치게 한다.
 * 화면이 바뀌었을 수 있으므로 ctx.snap은 지금 화면을 준다. 시작 화면(ctx.start)은 처음 것을 그대로 쓴다.
 */
export async function reviseSkill(draft: ComposeDraft, feedback: string, llm: LlmPort, ctx: ComposeContext, lastRun?: string): Promise<ComposeDraft> {
  const run = lastRun ? `\n\n## 시험 실행 결과\n${lastRun}` : '';
  const spec = await ask(llm, `${revisePrompt(draft, ctx)}${run}\n\n## 고칠 점\n${feedback}`, ctx.signal);
  return repair(finish({ ...spec, id: draft.spec.id }, { ...ctx, takenIds: new Set([...(ctx.takenIds ?? [])].filter((i) => i !== draft.spec.id)) }), llm, ctx);
}

/** 저장하기 전에 담당 부서와 id를 정한다. */
export function finalizeDraft(draft: ComposeDraft, owner: string, id = draft.spec.id): ComposeDraft {
  const start = { ...draft.start, owner };
  const spec = { ...draft.spec, id };
  const { source, notes, files } = renderSpec(spec, start);
  return { ...draft, spec, start, source, files, report: lintSkill(source, undefined, files), notes };
}
