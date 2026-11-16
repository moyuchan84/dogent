import { z } from 'zod';
import { TOOL_ARGS, type ToolName } from './actions';
import type { ElementItem, PageSnapshot } from './types';

/**
 * 제약 디코딩(structured output)에 쓸 동작 JSON 스키마.
 *
 * 모델 서버(vLLM·SGLang·TGI·Ollama 등)가 response_format json_schema를 받으면, 모델이 이 스키마에 맞는 글자만 낼 수 있다.
 * 그래서 없는 도구 이름, 틀린 인자 이름, 화면에 없는 ref 번호가 처음부터 나오지 않는다. 작은 모델(Gemma)에서 형식 오류와
 * 다시 묻기를 줄이는 것이 목적이다. 스키마는 parseAction이 받는 것보다 좁을 수는 있어도 넓으면 안 된다:
 * 스키마에 맞는 답은 parseAction도 받아야 한다 (tests/action-schema.test.ts).
 *
 * 스키마는 차례마다 새로 만든다. 지금 화면의 ref 번호, 이 실행에서 쓸 수 있는 도구(오피스·외부 도구·스킬 부르기·스크립트·그림)가
 * 차례마다 다르기 때문이다. 프롬프트(prompt.ts)에 안내하지 않은 도구는 스키마에도 넣지 않는다.
 */

/** 오피스 도구. 오피스 도구를 쓸 수 있는 실행에서만 넣는다 (prompt.ts OFFICE_PROMPT) */
export const OFFICE_TOOLS: readonly ToolName[] = [
  'excel_docs',
  'excel_read',
  'excel_write',
  'excel_save',
  'word_read',
  'word_write',
  'word_save',
  'ppt_read',
  'ppt_write',
  'ppt_save',
];

/** 표를 가리키는 ref만 받는 도구 */
const TABLE_TOOLS: readonly ToolName[] = ['extract_table', 'fill_table'];
/** ref 칸 이름 (ref, next_ref, add_ref) */
const REF_KEYS = ['ref', 'next_ref', 'add_ref'];
/** ref를 enum으로 좁히는 최대 요소 수. 이보다 많으면 정수만 강제한다 (스키마가 너무 커지면 서버의 문법 컴파일이 느려진다) */
export const MAX_REF_ENUM = 400;
/** thought 칸의 최대 길이. 작은 모델이 생각을 끝없이 늘어놓다 답이 잘리는 것을 막는다 */
export const THOUGHT_MAX = 300;

export interface ActionSchemaOptions {
  /** 지금 화면. 없으면(브라우저 없는 실행) 화면 도구를 빼고 ref는 정수만 강제한다 */
  snap?: PageSnapshot | null;
  /** 오피스 도구를 쓸 수 있는지 */
  office?: boolean;
  /** 부를 수 있는 외부 도구(MCP)의 이름 ("서버.도구") */
  external?: string[];
  /** run_skill로 부를 수 있는 스킬 id */
  skills?: string[];
  /** 이 스킬에 딸린 스크립트 이름 */
  scripts?: string[];
  /** 화면 그림(look)을 쓸 수 있는지 */
  vision?: boolean;
  /** PC 파일을 읽을 수 있는지 (list_files·read_file) */
  files?: boolean;
  /** 위 조건과 상관없이 넣을 도구. 지금 단계의 글에 이름이 적힌 도구 (예: "run_skill로 ..." 단계를 모델이 정할 때) */
  extra?: string[];
}

/** 글에 이름이 적힌 도구 (단계 글의 "extract_table로 ..." 같은 것) */
export function toolsNamedIn(text: string): ToolName[] {
  return (Object.keys(TOOL_ARGS) as ToolName[]).filter((t) => new RegExp(`(^|[^a-z_])${t}([^a-z_]|$)`).test(text));
}

/** response_format: { type: 'json_schema', json_schema } 에 넣는 값 */
export interface JsonSchemaSpec {
  name: string;
  schema: Record<string, unknown>;
}

type Json = Record<string, unknown>;

/**
 * zod가 만든 JSON 스키마를 문법 엔진들이 공통으로 받는 범위로 줄인다.
 * - format·pattern·propertyNames·$schema·default는 뺀다 (엔진마다 지원이 달라 거절되거나 무시된다. 값 검사는 parseAction이 다시 한다).
 * - 정수의 maximum 2^53-1, exclusiveMinimum은 뺀다.
 * - oneOf는 anyOf로, type 배열은 anyOf로 바꾼다.
 * - 속성이 정해진 객체에는 additionalProperties: false를 붙여 모르는 칸을 막는다.
 */
function portable(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(portable);
  if (!node || typeof node !== 'object') return node;
  const src = node as Json;
  const out: Json = {};
  for (const [k, v] of Object.entries(src)) {
    if (['$schema', 'format', 'pattern', 'propertyNames', 'default', 'exclusiveMinimum', 'exclusiveMaximum'].includes(k)) continue;
    if (k === 'maximum' && v === Number.MAX_SAFE_INTEGER) continue;
    if (k === 'oneOf') {
      out.anyOf = portable(v);
      continue;
    }
    out[k] = portable(v);
  }
  if (Array.isArray(out.type)) {
    const types = out.type as string[];
    delete out.type;
    return { ...out, anyOf: types.map((t) => ({ type: t })) };
  }
  if (out.type === 'object' && out.properties && out.additionalProperties === undefined) out.additionalProperties = false;
  if (out.additionalProperties && typeof out.additionalProperties === 'object' && Object.keys(out.additionalProperties).length === 0) {
    out.additionalProperties = true;
  }
  return out;
}

const argCache = new Map<ToolName, Json>();

/** 도구 하나의 args 스키마 (화면과 무관한 부분). 한 번 만들어 둔다 */
function baseArgs(tool: ToolName): Json {
  let s = argCache.get(tool);
  if (!s) {
    s = portable(z.toJSONSchema(TOOL_ARGS[tool], { io: 'input', unrepresentable: 'any' })) as Json;
    argCache.set(tool, s);
  }
  return s;
}

/** 이번 차례에 쓸 수 있는 도구. prompt.ts가 안내하는 도구와 같아야 한다 */
export function schemaTools(opts: ActionSchemaOptions): ToolName[] {
  const office = new Set(OFFICE_TOOLS);
  const hasTable = opts.snap?.items.some((i) => i.kind === 'el' && i.role === 'table') ?? false;
  const extra = new Set(opts.extra ?? []);
  return (Object.keys(TOOL_ARGS) as ToolName[]).filter((t) => {
    if (extra.has(t)) return true;
    if (office.has(t)) return opts.office === true;
    if (t === 'look') return opts.vision === true && !!opts.snap;
    if (t === 'list_files' || t === 'read_file') return opts.files === true;
    if (t === 'call_tool') return (opts.external?.length ?? 0) > 0;
    if (t === 'run_skill') return (opts.skills?.length ?? 0) > 0;
    if (t === 'run_script') return (opts.scripts?.length ?? 0) > 0;
    // 화면에 표가 없으면 표 도구는 쓸 데가 없다 (화면이 없으면 ref도 없다).
    if (TABLE_TOOLS.includes(t)) return hasTable;
    return true;
  });
}

/** ref 칸의 스키마. 화면이 있으면 그 화면의 번호 중 하나만 받는다 */
function refSchema(refs: number[] | null): Json {
  if (!refs) return { type: 'integer', minimum: 0 };
  return { type: 'integer', enum: refs };
}

/** 동작 하나({"thought", "tool", "args"})의 JSON 스키마 */
export function actionSchema(opts: ActionSchemaOptions = {}): JsonSchemaSpec {
  const els = (opts.snap?.items ?? []).filter((i): i is ElementItem => i.kind === 'el');
  const small = opts.snap && els.length > 0 && els.length <= MAX_REF_ENUM;
  const allRefs = small ? els.map((e) => e.ref) : null;
  const tables = els.filter((e) => e.role === 'table').map((e) => e.ref);
  // 표가 아직 없는데 단계가 표 도구를 말하면(extra) 모든 요소를 받는다. 빈 enum은 어떤 답도 받지 않는다.
  const tableRefs = small ? (tables.length > 0 ? tables : allRefs) : null;

  const variants = schemaTools(opts).map((tool) => {
    const args = structuredClone(baseArgs(tool));
    const props = (args.properties ?? {}) as Record<string, Json>;
    for (const key of REF_KEYS) {
      if (!props[key]) continue;
      // 표 도구의 ref는 표만, 그 밖(next_ref·add_ref 포함)은 화면의 모든 요소
      props[key] = refSchema(TABLE_TOOLS.includes(tool) && key === 'ref' ? tableRefs : allRefs);
    }
    if (tool === 'call_tool' && opts.external?.length) props.name = { type: 'string', enum: opts.external };
    if (tool === 'run_skill' && opts.skills?.length) props.id = { type: 'string', enum: opts.skills };
    if (tool === 'run_script' && opts.scripts?.length) props.script = { type: 'string', enum: opts.scripts };
    return {
      type: 'object',
      properties: {
        thought: { type: 'string', maxLength: THOUGHT_MAX },
        tool: { type: 'string', const: tool },
        args,
      },
      required: ['thought', 'tool', 'args'],
      additionalProperties: false,
    };
  });
  return { name: 'dogent_action', schema: { anyOf: variants } };
}
