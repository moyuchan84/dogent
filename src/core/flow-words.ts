import { z } from 'zod';
import { stepCheck, type Clause } from './check';
import { composeSkill, type ComposeContext, type ComposeDraft } from './compose';
import {
  addInput,
  describeBlock,
  insertBlock,
  isStartBlock,
  moveBlock,
  removeBlock,
  setInput,
  setMeta,
  startLocked,
  updateBlock,
  parseFlow,
  type Flow,
  type FlowBlock,
} from './flow';
import { renderSnapshot } from './snapshot';
import type { LlmPort, PageSnapshot } from './types';

/**
 * 말로 흐름 고치기. 사용자가 "3번 앞에 HOLD만 거르는 단계 추가"처럼 말하면 모델이 연산 JSON을 내고, 코드가 검증해 적용한다.
 *
 * 모델은 문서를 쓰지 않는다. 낼 수 있는 것은 아래 연산뿐이고, 허용되지 않는 것은 버려 skipped에 이유와 함께 남긴다.
 * - 1번(시작 화면) 단계는 건드릴 수 없다.
 * - 인자 줄이 있는 단계(모델 없이 실행되는 단계)의 문장은 고치지 못한다. 목적·검사는 고칠 수 있다.
 * - 모델이 만드는 새 단계는 인자 줄 없는 목표 단계뿐이다.
 * - 번호는 모두 "지금 보여 준 번호"다. 여러 연산이 있어도 처음 번호를 기준으로 읽는다.
 */

export const FLOW_EDIT_PROMPT = `당신은 업무 절차서(스킬)를 말로 고치는 편집 도우미입니다. 절차서는 번호 붙은 단계 목록이고, 에이전트가 단계마다 화면을 보고 조작합니다.
사용자의 요청대로 단계 목록을 고치는 "연산"만 JSON으로 냅니다. 다른 설명은 쓰지 않습니다.

JSON 객체 하나로만 답합니다.
{"ops": [연산, ...]}

연산의 종류 (번호 N은 아래 "지금 단계"에 보이는 번호)
- {"op":"insert","after":N,"text":"<새 단계 문장>","check":"<선택>","note":"<선택: 이 단계의 목적>"}  N번 단계 뒤에 새 단계를 넣는다
- {"op":"update","n":N,"text":"<고친 문장>","check":"<선택>","note":"<선택>"}  N번 단계를 고친다 (바꾸는 항목만 쓴다)
- {"op":"remove","n":N}  N번 단계를 지운다
- {"op":"move","n":N,"to":M}  N번 단계를 M번 자리로 옮긴다
- {"op":"input","name":"<영문 소문자>","label":"<한글>","description":"<설명>","type":"string|number|text|enum","default":"<기본값>"}  입력값을 추가하거나 고친다
- {"op":"meta","name":"<이름>","description":"<설명>","tags":["<찾을 때 쓸 말>"]}  스킬의 이름·설명·태그를 고친다

규칙
- 요청한 부분만 고치고 나머지는 그대로 둡니다. 요청과 상관없는 연산을 내지 않습니다. 고칠 것이 없으면 {"ops": []}.
- 분기와 반복은 단계 문장으로 씁니다. 예: "표의 각 행마다 상태를 확인해 HOLD이면 사유를 적어 둔다", "데이터가 없으면 알리고 끝낸다".
- 실행할 때마다 달라지는 값은 input으로 만들고 단계 문장에서 {이름}으로 씁니다. 늘 같은 값은 글자로 적습니다.
- 화면에 보이는 요소의 이름은 "현재 화면"에 있는 그대로 큰따옴표로 적습니다. 없는 이름을 지어내지 않습니다.
- 1번 단계(시작 화면 이동)는 고치거나 옮기거나 지울 수 없고 그 앞에 넣을 수 없습니다.
- "[인자 있음]" 표시가 있는 단계는 문장(text)을 고칠 수 없습니다. 목적(note)과 검사(check)만 고치거나, 지우거나, 옮길 수 있습니다. 다르게 하고 싶으면 그 단계 뒤에 새 단계를 넣습니다.
- check에 쓸 수 있는 것: text("글자"), no_text("글자"), url("주소 일부"), value("요소 이름") == "값", dialog("글자"). 여러 개는 and로 잇습니다. 확실하지 않으면 생략합니다.
- 저장·상신·삭제·승인 버튼을 누르는 단계는 새로 만들지 않습니다.`;

const Str = z.string().min(1);
const Num = z.coerce.number().int();

const Op = z.discriminatedUnion('op', [
  z.object({ op: z.literal('insert'), after: Num, text: Str, check: z.string().nullish(), note: z.string().nullish() }),
  z.object({ op: z.literal('update'), n: Num, text: z.string().nullish(), check: z.string().nullish(), note: z.string().nullish() }),
  z.object({ op: z.literal('remove'), n: Num }),
  z.object({ op: z.literal('move'), n: Num, to: Num }),
  z.object({
    op: z.literal('input'),
    name: Str,
    label: z.string().nullish(),
    description: z.string().nullish(),
    type: z.string().nullish(),
    default: z.union([z.string(), z.number()]).nullish(),
    required: z.boolean().nullish(),
  }),
  z.object({ op: z.literal('meta'), name: z.string().nullish(), description: z.string().nullish(), tags: z.array(z.string()).nullish() }),
]);
export type FlowOp = z.infer<typeof Op>;

export interface ReviseResult {
  flow: Flow;
  /** 바뀐 것 (사람이 읽는 문장) */
  changes: string[];
  /** 건너뛴 것과 그 이유 */
  skipped: string[];
  /** 모델이 낸 연산 수 */
  asked: number;
}

export interface ReviseContext {
  url: string;
  title: string;
  snap?: PageSnapshot;
}

/** 응답에서 연산 목록을 꺼낸다. {"ops":[…]}, 그냥 […], 연산 하나 {…} 모두 받는다. */
export function parseOps(text: string): unknown[] | null {
  const tryParse = (s: string): unknown => {
    try {
      return JSON.parse(s);
    } catch {
      return undefined;
    }
  };
  for (let at = 0; at < text.length; at++) {
    if (text[at] !== '{' && text[at] !== '[') continue;
    const end = balanced(text, at);
    if (end < 0) continue;
    const v = tryParse(text.slice(at, end + 1));
    if (Array.isArray(v)) return v;
    if (v && typeof v === 'object') {
      const ops = (v as { ops?: unknown }).ops;
      if (Array.isArray(ops)) return ops;
      if (typeof (v as { op?: unknown }).op === 'string') return [v];
    }
  }
  return null;
}

/** start의 여는 괄호에 짝이 맞는 닫는 괄호 위치 (문자열 안은 건너뛴다). 없으면 -1 */
function balanced(text: string, start: number): number {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{' || ch === '[') depth++;
    else if (ch === '}' || ch === ']') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function stepsPart(flow: Flow): string {
  const rows = flow.blocks.map((b, i) => {
    const v = describeBlock(b);
    const lines = [`${i + 1}. [${v.label}] ${b.head}${b.literal !== null ? ' [인자 있음]' : ''}${i === 0 && isStartBlock(b) ? ' [고칠 수 없음]' : ''}`];
    if (b.note) lines.push(`   목적: ${b.note}`);
    if (b.check) lines.push(`   검사: ${b.check}`);
    return lines.join('\n');
  });
  const inputs = flow.meta.inputs.length
    ? flow.meta.inputs.map((i) => `- {${i.name}} (${i.type ?? 'string'})${i.label ? ` ${i.label}` : ''}${i.description ? `: ${i.description}` : ''}${i.default !== undefined ? ` 기본값 ${i.default}` : ''}`).join('\n')
    : '(없음)';
  return `스킬: ${flow.meta.name} — ${flow.meta.description}\n\n## 지금 단계\n${rows.join('\n')}\n\n## 지금 입력값\n${inputs}`;
}

/** 목표 단계에 쓸 수 있는 검사 조각만 남긴다. 읽을 수 없거나 쓸 수 없으면 이유를 돌려준다. */
function usableCheck(check: string, goal: boolean): { ok: string } | { bad: string } {
  const kept: string[] = [];
  for (const raw of check.split(/\s+and\s+/)) {
    const clause = raw.trim();
    if (!clause) continue;
    let c: Clause | undefined;
    try {
      c = stepCheck(`- 검사: ${clause}`)?.[0];
    } catch {
      return { bad: `검사 "${clause}"는 읽을 수 없는 식입니다` };
    }
    if (!c) continue;
    if (goal && !['text', 'url', 'value', 'dialog'].includes(c.kind)) {
      return { bad: `검사 "${clause}"는 말로 적은 단계에 쓸 수 없습니다 (text, no_text, url, value, dialog만)` };
    }
    kept.push(clause);
  }
  return kept.length ? { ok: kept.join(' and ') } : { bad: '검사가 비어 있습니다' };
}

const short = (s: string) => (s.length > 40 ? `${s.slice(0, 40)}…` : s);

/**
 * 말로 흐름을 고친다. lastRun을 주면(여기까지 시험한 결과) 함께 보여 줘 실패한 곳을 고치게 한다.
 * 모델이 JSON을 주지 않으면 사람이 읽을 수 있는 오류를 던진다 (흐름은 바뀌지 않는다).
 */
export async function reviseFlowByWords(
  flow: Flow,
  instruction: string,
  llm: LlmPort,
  ctx: ReviseContext,
  opts: { lastRun?: string; signal?: AbortSignal } = {},
): Promise<ReviseResult> {
  const page = ctx.snap ? `주소: ${ctx.url}\n제목: ${ctx.title}\n\n${renderSnapshot(ctx.snap, 6000)}` : `주소: ${ctx.url}\n제목: ${ctx.title}`;
  const run = opts.lastRun ? `\n\n## 방금 시험 결과\n${opts.lastRun}` : '';
  const text = await llm.complete(
    [
      { role: 'system', content: FLOW_EDIT_PROMPT },
      { role: 'user', content: `## 현재 화면\n${page}\n\n${stepsPart(flow)}${run}\n\n## 사용자의 말\n${instruction}` },
    ],
    opts.signal,
  );
  const raw = parseOps(text);
  if (!raw) throw new Error('모델의 답을 고치는 방법(JSON)으로 읽지 못했습니다. 말을 조금 바꿔 다시 시도해 주세요');
  return applyOps(flow, raw);
}

/** 연산을 검증해 적용한다 (모델 없이 시험할 수 있다). 번호는 적용 전 흐름의 번호다. */
export function applyOps(flow: Flow, raw: unknown[]): ReviseResult {
  const changes: string[] = [];
  const skipped: string[] = [];
  // 번호를 단계 key로 바꿔 두면, 앞 연산이 번호를 밀어도 뒤 연산이 같은 단계를 가리킨다
  const keys = flow.blocks.map((b) => b.key);
  const locked = startLocked(flow);
  let cur = flow;
  const indexOf = (key: string) => cur.blocks.findIndex((b) => b.key === key);
  const find = (n: number, what: string): { key: string; i: number } | null => {
    if (!Number.isInteger(n) || n < 1 || n > keys.length) {
      skipped.push(`${what}: ${n}번 단계는 없습니다 (1~${keys.length}번)`);
      return null;
    }
    if (n === 1 && locked) {
      skipped.push(`${what}: 1번(시작 화면) 단계는 고칠 수 없습니다`);
      return null;
    }
    const i = indexOf(keys[n - 1]);
    if (i < 0) {
      skipped.push(`${what}: ${n}번 단계는 이미 지웠습니다`);
      return null;
    }
    return { key: keys[n - 1], i };
  };
  const label = (b: FlowBlock) => `"${short(describeBlock(b).title)}"`;

  for (const item of raw) {
    const parsed = Op.safeParse(item);
    if (!parsed.success) {
      skipped.push(`알 수 없는 연산: ${short(JSON.stringify(item) ?? String(item))}`);
      continue;
    }
    const op = parsed.data;
    if (op.op === 'insert') {
      if (!Number.isInteger(op.after) || op.after < 0 || op.after > keys.length) {
        skipped.push(`단계 넣기: ${op.after}번 뒤는 없는 위치입니다`);
        continue;
      }
      if (op.after === 0 && locked) {
        skipped.push('단계 넣기: 1번(시작 화면) 앞에는 단계를 넣을 수 없습니다');
        continue;
      }
      // 기준이 된 단계 바로 뒤. 기준 단계가 지워졌으면 그 자리에 가장 가까운 앞 단계 뒤
      let at = 0;
      for (let k = op.after; k >= 1; k--) {
        const i = indexOf(keys[k - 1]);
        if (i >= 0) {
          at = i + 1;
          break;
        }
      }
      const head = op.text.trim();
      let check: string | null = null;
      if (op.check?.trim()) {
        const c = usableCheck(op.check, true);
        if ('ok' in c) check = c.ok;
        else skipped.push(`새 단계의 ${c.bad}. 검사 없이 넣었습니다`);
      }
      const before = cur.blocks.length;
      cur = insertBlock(cur, at, { head, note: op.note?.trim() || null, check });
      if (cur.blocks.length > before) changes.push(`${at + 1}번 자리에 새 단계를 넣었습니다: "${short(head)}"`);
      continue;
    }
    if (op.op === 'update') {
      const f = find(op.n, '단계 고치기');
      if (!f) continue;
      const b = cur.blocks[f.i];
      const patch: { head?: string; note?: string | null; check?: string | null } = {};
      const parts: string[] = [];
      if (op.text?.trim()) {
        if (b.literal !== null) skipped.push(`${op.n}번 단계는 인자가 정해진 단계라 문장을 말로 고칠 수 없습니다 (직접 고치거나 뒤에 새 단계를 넣으세요)`);
        else if (op.text.trim() !== b.head) {
          patch.head = op.text.trim();
          parts.push('문장');
        }
      }
      if (op.note?.trim() && op.note.trim() !== b.note) {
        patch.note = op.note.trim();
        parts.push('목적');
      }
      if (op.check !== undefined && op.check !== null && op.check.trim() !== (b.check ?? '')) {
        if (op.check.trim() === '') {
          patch.check = null;
          parts.push('검사 지움');
        } else {
          const c = usableCheck(op.check, b.literal === null);
          if ('ok' in c) {
            patch.check = c.ok;
            parts.push('검사');
          } else skipped.push(`${op.n}번 단계의 ${c.bad}`);
        }
      }
      if (parts.length === 0) continue;
      cur = updateBlock(cur, f.i, patch);
      changes.push(`${op.n}번 단계의 ${parts.join('·')}을(를) 고쳤습니다: ${label(cur.blocks[f.i])}`);
      continue;
    }
    if (op.op === 'remove') {
      const f = find(op.n, '단계 지우기');
      if (!f) continue;
      const title = label(cur.blocks[f.i]);
      const before = cur.blocks.length;
      cur = removeBlock(cur, f.i);
      if (cur.blocks.length < before) {
        changes.push(`${op.n}번 단계를 지웠습니다: ${title}`);
        for (const n of cur.notices) changes.push(n);
      } else skipped.push(`${op.n}번 단계를 지우지 못했습니다: ${cur.notices[0] ?? ''}`);
      continue;
    }
    if (op.op === 'move') {
      const f = find(op.n, '단계 옮기기');
      if (!f) continue;
      if (!Number.isInteger(op.to) || op.to < 1 || op.to > keys.length) {
        skipped.push(`단계 옮기기: ${op.to}번 자리는 없습니다`);
        continue;
      }
      if (op.to === 1 && locked) {
        skipped.push('단계 옮기기: 1번(시작 화면) 자리로는 옮길 수 없습니다');
        continue;
      }
      // 기준 단계(M번)의 앞 또는 뒤로: 아래로 옮기면 M번 뒤, 위로 옮기면 M번 앞
      const anchor = indexOf(keys[op.to - 1]);
      if (anchor < 0 || op.to === op.n) continue;
      const title = label(cur.blocks[f.i]);
      cur = moveBlock(cur, f.i, anchor);
      changes.push(`${op.n}번 단계를 ${op.to}번 자리로 옮겼습니다: ${title}`);
      continue;
    }
    if (op.op === 'input') {
      if (!/^[a-z][a-z0-9_]*$/.test(op.name)) {
        skipped.push(`입력 이름 "${op.name}"은(는) 영문 소문자로 시작하는 영문·숫자·_만 쓸 수 있습니다`);
        continue;
      }
      const patch = {
        ...(op.label ? { label: op.label } : {}),
        ...(op.description ? { description: op.description } : {}),
        ...(op.type ? { type: op.type } : {}),
        ...(op.default !== undefined && op.default !== null ? { default: op.default } : {}),
        ...(op.required !== undefined && op.required !== null ? { required: op.required } : {}),
      };
      const exists = cur.meta.inputs.some((i) => i.name === op.name);
      cur = exists ? setInput(cur, op.name, patch) : addInput(cur, { name: op.name, ...patch });
      if (!exists && !cur.meta.inputs.some((i) => i.name === op.name)) skipped.push(cur.notices[0] ?? `입력 "${op.name}"을(를) 넣지 못했습니다`);
      else changes.push(`입력 {${op.name}}을(를) ${exists ? '고쳤' : '추가했'}습니다${op.default !== undefined && op.default !== null ? ` (기본값 ${op.default})` : ''}`);
      continue;
    }
    // meta
    const patch = {
      ...(op.name?.trim() ? { name: op.name } : {}),
      ...(op.description?.trim() ? { description: op.description } : {}),
      ...(op.tags ? { tags: op.tags } : {}),
    };
    if (Object.keys(patch).length === 0) continue;
    cur = setMeta(cur, patch);
    changes.push(`스킬 ${Object.keys(patch).map((k) => ({ name: '이름', description: '설명', tags: '태그' })[k as 'name']).join('·')}을(를) 고쳤습니다`);
  }
  return { flow: { ...cur, notices: [] }, changes, skipped, asked: raw.length };
}

/**
 * 말로 새 흐름을 만든다. 두 번째 생성 경로를 만들지 않고 composeSkill을 그대로 부른 뒤 그 문서를 연다.
 */
export async function createFlowByWords(request: string, llm: LlmPort, ctx: ComposeContext): Promise<{ flow: Flow; draft: ComposeDraft }> {
  const draft = await composeSkill(request, llm, ctx);
  const flow = parseFlow(draft.source);
  if (!flow.ok) throw new Error(`만든 초안을 단계로 열지 못했습니다: ${flow.reason}`);
  return { flow, draft };
}
