import { z } from 'zod';
import { TransformStep } from './transform';
import type { ElementItem, PageSnapshot } from './types';

// 모델이 ref를 "12"처럼 문자열로 줄 때가 있어 숫자로 맞춘다.
const ref = z.coerce.number().int().nonnegative();
/** 표 안의 요소를 이름으로 가리킬 때, 그 행에 있는 글자. 같은 이름이 행마다 있을 때 행을 가린다. */
const row = z.string().optional();

export const TOOL_ARGS = {
  next_step: z.object({}),
  navigate: z.object({ url: z.url() }),
  click: z.object({
    ref,
    /** 누른 뒤 뜨는 확인 창에서 확인을 누른다. 없으면 취소한다. */
    accept_dialog: z.boolean().optional(),
    row,
  }),
  close_tab: z.object({}),
  type: z.object({ ref, text: z.string(), row }),
  select: z.object({ ref, value: z.string(), row }),
  wait_for: z.object({
    text: z.string().min(1),
    timeout_sec: z.number().positive().max(60).default(10),
  }),
  extract_table: z.object({
    ref,
    dataset: z.string().min(1),
    append: z.boolean().default(false),
    /** 다음 페이지 버튼. 주면 비활성이 될 때까지 눌러 가며 모든 페이지를 추출한다. */
    next_ref: ref.optional(),
  }),
  download_table: z.object({
    /** 엑셀·CSV 내려받기 버튼 */
    ref,
    dataset: z.string().min(1),
    timeout_sec: z.number().positive().max(120).default(30),
  }),
  fill_table: z.object({
    ref,
    dataset: z.string().min(1),
    /** 행 추가 버튼. 표의 빈 행이 모자랄 때 누른다. */
    add_ref: ref.optional(),
  }),
  transform: z.object({
    source: z.string().min(1),
    target: z.string().min(1),
    steps: z.array(TransformStep).min(1),
  }),
  write_excel: z.object({
    filename: z.string().min(1),
    sheets: z.array(z.object({ name: z.string().min(1), dataset: z.string().min(1) })).min(1),
  }),
  /** 화면(ref를 주면 그 요소)에 보이는 글을 읽는다. 게시글·공지처럼 글 내용이 필요할 때 쓴다. */
  read_text: z.object({ ref: ref.optional() }),
  /**
   * 화면의 글(source "page")이나 데이터셋을 지시대로 정리해 기록 값 name에 남긴다. 뒤 단계에서 {out.name}으로 쓴다.
   * 정리할 자료를 모델에 보낸다. 데이터셋은 앞부분 행만 보내므로, 많으면 transform으로 먼저 줄인다.
   */
  summarize: z.object({
    instruction: z.string().min(1),
    source: z.string().min(1).default('page'),
    name: z.string().regex(/^[a-z_][a-z0-9_]*$/).default('summary'),
  }),
  ask_user: z.object({ question: z.string().min(1) }),
  finish: z.object({ summary: z.string().min(1) }),
  abort: z.object({ reason: z.string().min(1) }),
} as const;

export type ToolName = keyof typeof TOOL_ARGS;

/** 모델 없이 실행할 수 있는 단계의 첫머리. 예: "select로 ...", "click으로 ..." */
const DIRECT_STEP =
  /^(navigate|click|close_tab|type|select|extract_table|download_table|fill_table|transform|write_excel|read_text|summarize|finish)(?:으로|로)\s/;

/**
 * 단계가 "도구로 ..."로 시작하고 `{...}` 인자가 적혀 있으면 그 도구 이름과 인자 원문을 돌려준다.
 * 이런 단계는 모델 없이 그대로 실행할 수 있다.
 */
export function directParts(stepText: string): { tool: ToolName; literal: string } | null {
  const tool = DIRECT_STEP.exec(stepText)?.[1] as ToolName | undefined;
  const literal = /`(\{.*\})`/.exec(stepText)?.[1];
  return tool && literal ? { tool, literal } : null;
}

export type Action = {
  [K in ToolName]: {
    step: number;
    thought: string;
    tool: K;
    args: z.infer<(typeof TOOL_ARGS)[K]>;
  };
}[ToolName];

const Envelope = z.object({
  step: z.coerce.number().int().nonnegative().default(0),
  thought: z.string().default(''),
  tool: z.string(),
  args: z.record(z.string(), z.unknown()).default({}),
});

/** 모델 응답에서 첫 번째 JSON 객체를 꺼낸다. 코드 펜스나 앞뒤 설명이 붙어 있어도 된다. */
export function extractJson(text: string): string | null {
  const start = text.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
    } else if (ch === '"') inString = true;
    else if (ch === '{') depth++;
    else if (ch === '}' && --depth === 0) return text.slice(start, i + 1);
  }
  return null;
}

export type ParseResult = { ok: true; action: Action } | { ok: false; error: string };

const ROLE_FOR_TOOL: Record<string, string> = {
  select: 'combobox',
  type: 'textbox',
  extract_table: 'table',
  fill_table: 'table',
};

/**
 * 작은 모델은 ref에 번호 대신 "조회" 같은 요소 이름이나 "[4]"를 넣곤 한다.
 * 화면에서 하나로 특정되면 번호로 바꿔 주고, 아니면 후보를 알려준다.
 */
function resolveRef(tool: string, ref: unknown, snap: PageSnapshot, row?: unknown): { ref: unknown } | { error: string } {
  if (typeof ref !== 'string') return { ref };
  const bracketed = /^\s*\[?\s*(\d+)\s*\]?\s*$/.exec(ref);
  if (bracketed) return { ref: Number(bracketed[1]) };
  const els = snap.items.filter((i): i is ElementItem => i.kind === 'el');
  let matches = els.filter((e) => e.name.trim() === ref.trim());
  const role = ROLE_FOR_TOOL[tool];
  if (role && matches.some((e) => e.role === role)) matches = matches.filter((e) => e.role === role);
  const show = (list: ElementItem[]) =>
    list
      .slice(0, 12)
      .map((e) => `[${e.ref}] ${e.role} "${e.name}"${e.row ? ` row="${e.row}"` : ''}`)
      .join(', ');
  if (typeof row === 'string' && row.trim() !== '' && matches.length > 0) {
    const inRow = matches.filter((e) => e.row?.includes(row.trim()));
    if (inRow.length === 0) {
      return { error: `"${row}" 글자가 있는 행에 "${ref}" 요소가 없습니다. 화면에 있는 것: ${show(matches)}` };
    }
    matches = inRow;
  }
  if (matches.length === 1) return { ref: matches[0].ref };
  return {
    error:
      matches.length === 0
        ? `ref "${ref}"에 해당하는 요소가 없습니다. ref에는 화면의 [ ] 안 번호를 숫자로 넣으세요. 예: ${show(els)}`
        : `"${ref}" 이름의 요소가 여러 개입니다: ${show(matches)}. 번호로 지정하세요`,
  };
}

/** snap을 주면 이름으로 적힌 ref를 현재 화면의 번호로 바꿔 준다. */
export function parseAction(text: string, snap?: PageSnapshot): ParseResult {
  const json = extractJson(text);
  if (!json) return { ok: false, error: 'JSON 객체가 없습니다' };
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch (e) {
    return { ok: false, error: `JSON 문법 오류: ${(e as Error).message}` };
  }
  const env = Envelope.safeParse(raw);
  if (!env.success) return { ok: false, error: z.prettifyError(env.error) };
  if (!(env.data.tool in TOOL_ARGS)) {
    return {
      ok: false,
      error: `알 수 없는 도구 "${env.data.tool}". 사용 가능: ${Object.keys(TOOL_ARGS).join(', ')}`,
    };
  }
  const tool = env.data.tool as ToolName;
  let rawArgs = env.data.args;
  if (snap && 'ref' in rawArgs) {
    const resolved = resolveRef(tool, rawArgs.ref, snap, rawArgs.row);
    if ('error' in resolved) return { ok: false, error: resolved.error };
    rawArgs = { ...rawArgs, ref: resolved.ref };
  }
  for (const key of ['next_ref', 'add_ref']) {
    if (!snap || rawArgs[key] === undefined) continue;
    const resolved = resolveRef('click', rawArgs[key], snap);
    if ('error' in resolved) return { ok: false, error: resolved.error };
    rawArgs = { ...rawArgs, [key]: resolved.ref };
  }
  const args = TOOL_ARGS[tool].safeParse(rawArgs);
  if (!args.success) return { ok: false, error: `${tool}의 args 오류:\n${z.prettifyError(args.error)}` };
  return {
    ok: true,
    action: { step: env.data.step, thought: env.data.thought, tool, args: args.data } as Action,
  };
}
