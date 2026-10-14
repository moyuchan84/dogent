import { z } from 'zod';
import { extractJson } from './actions';
import { lintSkill } from './lint';
import { parseSkill, type Skill } from './skill';
import type { LlmPort } from './types';

/**
 * 녹화로 만든 초안을 모델로 다듬는다.
 *
 * 모델은 글만 제안한다 — 스킬 설명, 입력 이름, 단계 설명, 예외, 결과 문구.
 * 제안을 초안에 넣는 것은 이 코드이고, 넣을 때마다 다듬기 전과 견주어
 * 도구·인자·검사·기록·통제 선언이 그대로인지 확인한다. 달라지면 그 제안은 버린다.
 * 그래서 모델이 틀려도 녹화한 동작은 바뀌지 않는다.
 */
export const POLISH_SYSTEM_PROMPT = `당신은 스킬 문서 편집자입니다. 사람이 화면에서 한 번 해 보인 조작으로 만든 업무 절차서(SKILL.md) 초안을 읽고, 사람이 읽기 좋게 다듬을 내용을 제안합니다.

JSON 객체 하나로만 답합니다.
{"description": "<스킬이 하는 일 한 문장>", "inputs": {"<지금 입력 이름>": "<새 이름>"}, "steps": {"<단계 번호>": "<이 단계를 왜 하는지 한 문장>"}, "exceptions": ["<예외 상황과 그때 할 일 한 문장>"], "result": "<끝나고 사용자에게 알릴 내용 한 문장>", "review": ["<사람이 확인해야 할 점>"]}

- 도구, 인자, 검사 식은 바꿀 수 없습니다. 고쳐야 할 것 같으면 review에 적습니다.
- inputs의 새 이름은 영문 소문자로 시작하고 소문자, 숫자, 밑줄만 씁니다. 입력의 label을 보고 뜻이 드러나게 짓습니다 (예: v1 → lot_id). 바꿀 필요가 없으면 넣지 않습니다.
- steps에는 설명이 도움이 되는 단계만 넣습니다. 단계 문장을 되풀이하지 않습니다.
- exceptions는 이 업무에서 실제로 생길 만한 것만 3개까지 적습니다. 초안에 이미 있는 것은 넣지 않습니다.
- 초안에 없는 화면, 버튼, 값을 지어내지 않습니다. 모르면 그 항목을 비웁니다.
- 모든 문장은 한국어 한 줄로 쓰고 백틱과 중괄호를 쓰지 않습니다.`;

const text = z.string().catch('');
const Proposal = z.object({
  description: text,
  inputs: z.record(z.string(), z.string()).catch({}),
  steps: z.record(z.string(), z.string()).catch({}),
  exceptions: z.array(z.string()).catch([]),
  result: text,
  review: z.array(z.string()).catch([]),
});
export type PolishProposal = z.infer<typeof Proposal>;

export interface PolishResult {
  source: string;
  /** 초안에 넣은 것 */
  applied: string[];
  /** 넣지 않은 제안과 그 이유 */
  rejected: string[];
  /** 모델이 사람에게 확인을 부탁한 점. 초안에는 넣지 않는다. */
  review: string[];
}

const MAX_LEN = 200;
const MAX_EXCEPTIONS = 3;
const NOTE_LINE = /^\s*-\s*설명:/;
const SUB_LINE = /^\s*-\s*(검사|기록):/;
const RESERVED = new Set(['out', 'rows']);

/** 모델이 쓴 문장을 한 줄로 만들고, 스킬 형식에서 뜻을 갖는 글자를 뺀다. */
function clean(s: string): string {
  return s
    .replace(/[`{}]/g, '')
    .replace(/\s+/g, ' ')
    .replace(/^(?:[\s#\-*]+|\d+[.)]\s+)+/, '')
    .trim()
    .slice(0, MAX_LEN);
}

const withoutNotes = (step: string) =>
  step
    .split('\n')
    .filter((l) => !NOTE_LINE.test(l))
    .join('\n');

/**
 * 다듬은 뒤에도 같은 일을 하는 스킬인지 본다.
 * 설명 줄을 뺀 단계 본문과, 설명을 뺀 선언부가 글자까지 같아야 한다.
 * renamed는 새 입력 이름 → 옛 이름. 이름만 바꾼 것은 같은 것으로 본다.
 */
function sameBehavior(before: Skill, afterSource: string, renamed: Map<string, string>): string | null {
  let after: Skill;
  try {
    after = parseSkill(afterSource);
  } catch (e) {
    return `형식이 깨집니다 (${(e as Error).message.split('\n')[0]})`;
  }
  const back = (s: string) => s.replace(/\{([a-z][a-z0-9_]*)\}/g, (whole, name: string) => (renamed.has(name) ? `{${renamed.get(name)}}` : whole));
  if (after.steps.length !== before.steps.length) return '단계 수가 달라집니다';
  for (let i = 0; i < before.steps.length; i++) {
    if (back(withoutNotes(after.steps[i])) !== withoutNotes(before.steps[i])) return `${i + 1}단계의 동작이 달라집니다`;
  }
  const meta = (s: Skill, names: (n: string) => string) =>
    JSON.stringify({ ...s, description: '', body: '', steps: [], inputs: s.inputs.map((i) => ({ ...i, name: names(i.name) })) });
  if (meta(after, (n) => renamed.get(n) ?? n) !== meta(before, (n) => n)) return '선언부가 달라집니다';
  return null;
}

/** 본문에서 "## 제목" 절의 범위(제목 다음 줄 ~ 다음 절 앞)를 찾는다. */
function sectionRange(lines: string[], title: string): { from: number; to: number } | null {
  const head = lines.findIndex((l) => new RegExp(`^##\\s*${title}\\s*$`).test(l));
  if (head < 0) return null;
  let to = lines.findIndex((l, i) => i > head && /^##\s/.test(l));
  if (to < 0) to = lines.length;
  return { from: head + 1, to };
}

/** 범위 끝의 빈 줄을 뺀 끝 위치 */
function trimEnd(lines: string[], from: number, to: number): number {
  while (to > from && lines[to - 1].trim() === '') to--;
  return to;
}

function setDescription(source: string, description: string): string | null {
  const lines = source.split('\n');
  const end = lines.indexOf('---', 1);
  const at = lines.findIndex((l, i) => i < end && /^description:\s*\S/.test(l));
  // 여러 줄로 적은 설명은 건드리지 않는다.
  if (at < 0 || /^description:\s*[|>]/.test(lines[at])) return null;
  lines[at] = `description: ${JSON.stringify(description)}`;
  return lines.join('\n');
}

function renameInput(source: string, from: string, to: string): string {
  return source
    .replace(new RegExp(`^(\\s*-\\s*name:\\s*)${from}\\s*$`, 'm'), `$1${to}`)
    .replace(new RegExp(`\\{${from}\\}`, 'g'), `{${to}}`);
}

function setStepNote(source: string, step: number, note: string): string | null {
  const lines = source.split('\n');
  const range = sectionRange(lines, '단계');
  if (!range) return null;
  const starts: number[] = [];
  for (let i = range.from; i < range.to; i++) if (/^\d+\.\s+\S/.test(lines[i])) starts.push(i);
  const from = starts[step - 1];
  if (from === undefined) return null;
  const to = trimEnd(lines, from, starts[step] ?? range.to);
  const kept = lines.slice(from, to).filter((l) => !NOTE_LINE.test(l));
  // 검사·기록 줄 앞에 둔다. 사람이 읽을 때 "무엇을, 왜, 어떻게 확인"의 순서가 된다.
  const sub = kept.findIndex((l, i) => i > 0 && SUB_LINE.test(l));
  kept.splice(sub < 0 ? kept.length : sub, 0, `   - 설명: ${note}`);
  lines.splice(from, to - from, ...kept);
  return lines.join('\n');
}

function addException(source: string, line: string): string {
  const lines = source.split('\n');
  const range = sectionRange(lines, '예외');
  if (!range) {
    const result = lines.findIndex((l) => /^##\s*결과\s*$/.test(l));
    const block = ['## 예외', '', `- ${line}`, ''];
    if (result < 0) lines.push('', ...block);
    else lines.splice(result, 0, ...block);
    return lines.join('\n');
  }
  lines.splice(trimEnd(lines, range.from, range.to), 0, `- ${line}`);
  return lines.join('\n');
}

function setResult(source: string, line: string): string {
  const lines = source.split('\n');
  const range = sectionRange(lines, '결과');
  if (!range) return [...lines, '', '## 결과', '', line, ''].join('\n');
  lines.splice(range.from, range.to - range.from, '', line, '');
  return lines.join('\n');
}

/** 모델의 제안을 초안에 넣는다. 동작을 바꾸거나 품질 검사를 나쁘게 하는 제안은 하나씩 버린다. */
export function applyPolish(original: string, proposal: PolishProposal): PolishResult {
  const before = parseSkill(original);
  const baseline = lintSkill(original).findings.length;
  const renamed = new Map<string, string>();
  const applied: string[] = [];
  const rejected: string[] = [];
  let source = original.replace(/\r\n/g, '\n');

  const attempt = (next: string | null, what: string, names = renamed) => {
    if (next === null) return void rejected.push(`${what}: 넣을 자리를 찾지 못했습니다`);
    if (next === source) return;
    const broken = sameBehavior(before, next, names) ?? (lintSkill(next).findings.length > baseline ? '품질 검사 결과가 나빠집니다' : null);
    if (broken) return void rejected.push(`${what}: ${broken}`);
    source = next;
    applied.push(what);
    return true;
  };

  const taken = new Set(before.inputs.map((i) => i.name));
  for (const [from, raw] of Object.entries(proposal.inputs)) {
    const to = raw.trim();
    if (from === to) continue;
    const what = `입력 이름 ${from} → ${to}`;
    if (!before.inputs.some((i) => i.name === from)) rejected.push(`${what}: ${from}은(는) 스킬에 없는 입력입니다`);
    else if (renamed.has(from) || [...renamed.values()].includes(from)) continue;
    else if (!/^[a-z][a-z0-9_]{0,30}$/.test(to) || RESERVED.has(to)) rejected.push(`${what}: 입력 이름으로 쓸 수 없습니다`);
    else if (taken.has(to)) rejected.push(`${what}: 이미 쓰는 이름입니다`);
    else if (attempt(renameInput(source, from, to), what, new Map([...renamed, [to, from]]))) {
      renamed.set(to, from);
      taken.add(to);
    }
  }

  const description = clean(proposal.description);
  if (description && description !== before.description) attempt(setDescription(source, description), '스킬 설명');

  for (const [key, raw] of Object.entries(proposal.steps)) {
    const n = Number(key);
    const note = clean(raw);
    if (!note) continue;
    if (!Number.isInteger(n) || n < 1 || n > before.steps.length) rejected.push(`${key}단계 설명: 없는 단계입니다`);
    else attempt(setStepNote(source, n, note), `${n}단계 설명`);
  }

  let added = 0;
  for (const raw of proposal.exceptions) {
    const line = clean(raw);
    if (!line || source.split('\n').includes(`- ${line}`)) continue;
    if (added >= MAX_EXCEPTIONS) {
      rejected.push(`예외 "${line}": 예외는 한 번에 ${MAX_EXCEPTIONS}개까지만 더합니다`);
      continue;
    }
    if (attempt(addException(source, line), `예외 "${line}"`)) added++;
  }

  const result = clean(proposal.result);
  if (result) attempt(setResult(source, result), '결과 문구');

  return { source, applied, rejected, review: proposal.review.map(clean).filter(Boolean) };
}

/** 초안을 모델에 보여 주고 받은 제안을 넣는다. 초안이 스킬 형식이 아니면 모델을 부르지 않는다. */
export async function polishSkill(source: string, llm: LlmPort, signal?: AbortSignal): Promise<PolishResult> {
  const report = lintSkill(source);
  if (!report.skill) throw new Error('형식 오류가 있는 초안은 다듬을 수 없습니다. 품질 검사의 오류부터 고쳐 주세요');
  const findings = report.findings.map((f) => `- ${f.rule}${f.step ? ` (${f.step}단계)` : ''}: ${f.message}`).join('\n');
  const reply = await llm.complete(
    [
      { role: 'system', content: POLISH_SYSTEM_PROMPT },
      { role: 'user', content: `## 스킬 초안\n${source.trim()}\n\n## 품질 검사 결과\n${findings || '지적 사항 없음'}` },
    ],
    signal,
  );
  const json = extractJson(reply);
  if (!json) throw new Error('모델이 다듬을 내용을 JSON으로 주지 않았습니다');
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error('모델의 답이 중간에 끊겼거나 JSON 형식이 아닙니다');
  }
  const proposal = Proposal.safeParse(parsed);
  if (!proposal.success) throw new Error('모델의 답이 약속한 형식이 아닙니다');
  return applyPolish(source, proposal.data);
}
