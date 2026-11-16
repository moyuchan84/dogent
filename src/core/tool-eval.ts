import { z } from 'zod';
import { parseAction, type Action } from './actions';
import { actionSchema, toolsNamedIn, type JsonSchemaSpec } from './action-schema';
import { MAX_FORMAT_RETRIES } from './loop';
import { buildTurnMessages, retryPrompt, type TurnInput } from './prompt';
import type { Skill } from './skill';
import { renderSnapshot } from './snapshot';
import type { ChatMessage, ElementItem, ExternalTool, LlmPort, PageSnapshot } from './types';

/**
 * 도구 호출 평가 세트.
 *
 * 케이스 하나는 "한 차례의 판단"이다: 모델이 그때 본 것(스킬, 단계, 화면, 지금까지의 동작, 데이터셋)과 정답 동작.
 * 화면은 그린 글이 아니라 스냅샷 원본으로 두고, 평가할 때 지금의 프롬프트(buildTurnMessages)와 화면 그리기(renderSnapshot)로
 * 다시 그린다. 그래서 프롬프트·스키마·화면 표기를 바꿀 때마다 같은 케이스로 정답률이 오르는지 내리는지 잴 수 있다.
 *
 * 케이스를 얻는 길
 * - 저장소의 evals/tool-calls/*.json: 모의 사이트에서 만든 기본 케이스 (클라이언트에도 들어 있다)
 * - 실제 실행에서 모으기: dogent config evalCapture <폴더>를 켜 두면 모델이 정한 차례마다 케이스 파일이 생긴다
 *   (모델이 고른 동작을 정답 자리에 두고 reviewed: false). `dogent eval review`로 사람이 맞는지 보고 고친다.
 *   사내 화면의 글이 그대로 들어가므로 사내에만 둔다.
 */

const Snapshot = z
  .object({
    url: z.string(),
    title: z.string().default(''),
    hasPassword: z.boolean().default(false),
    items: z.array(z.record(z.string(), z.unknown())),
  })
  .passthrough();

const ExpectAction = z.object({
  tool: z.string().min(1),
  /** 기대하는 인자. 적은 칸만 비교한다. 값 대신 {"$contains"}, {"$regex"}, {"$any": true}, {"$oneOf": [...]}, {"$el": {"name", "role"}}을 쓸 수 있다 */
  args: z.record(z.string(), z.unknown()).default({}),
});
export type ExpectAction = z.infer<typeof ExpectAction>;

export const EvalCase = z.object({
  id: z.string().min(1),
  note: z.string().optional(),
  tags: z.array(z.string()).default([]),
  /** 사람이 정답을 확인했는지. 실행에서 모은 케이스는 false로 시작한다 */
  reviewed: z.boolean().default(true),
  /** seed(모의 사이트에서 만듦), capture(실제 실행에서 모음), manual */
  source: z.string().optional(),
  turn: z.object({
    skill: z.object({
      id: z.string(),
      name: z.string(),
      version: z.string().default('0.0.0'),
      domains: z.array(z.string()).default([]),
      scripts: z.array(z.object({ name: z.string(), description: z.string().default('') })).default([]),
    }),
    body: z.string(),
    inputs: z.record(z.string(), z.union([z.string(), z.number()])).default({}),
    history: z
      .array(
        z
          .object({
            n: z.number(),
            step: z.number(),
            tool: z.string(),
            args: z.record(z.string(), z.unknown()).default({}),
            thought: z.string().default(''),
            ok: z.boolean(),
            result: z.string(),
            by: z.enum(['model', 'skill', 'cache']).default('model'),
          })
          .passthrough(),
      )
      .default([]),
    datasets: z.string().default('(없음)'),
    office: z.string().optional(),
    tools: z
      .array(
        z.object({
          name: z.string(),
          description: z.string().default(''),
          schema: z.any().optional(),
          readOnly: z.boolean().default(true),
          permission: z.enum(['allow', 'ask', 'deny']).default('allow'),
        }),
      )
      .default([]),
    skills: z
      .array(
        z.object({
          id: z.string(),
          name: z.string(),
          description: z.string().default(''),
          inputs: z.array(z.object({ name: z.string(), required: z.boolean().default(false), default: z.unknown().optional() })).default([]),
        }),
      )
      .default([]),
    snapshot: Snapshot,
    changes: z.array(z.string()).nullable().default(null),
    step: z.object({ n: z.number(), total: z.number(), text: z.string(), unmet: z.array(z.string()).nullable().default(null) }),
    vision: z.boolean().default(false),
    /** PC 파일을 읽을 수 있던 차례면 읽을 수 있는 폴더와 첨부한 파일 */
    files: z.object({ roots: z.array(z.string()), attached: z.array(z.string()) }).optional(),
  }),
  /** 정답 동작. 여럿이면 그중 하나면 맞다 */
  expect: z.union([ExpectAction, z.array(ExpectAction).min(1)]),
});
export type EvalCase = z.infer<typeof EvalCase>;

/** 파일 하나의 내용(케이스 하나, 케이스 배열, 또는 한 줄에 하나인 JSONL)을 케이스들로. 틀린 케이스는 이유와 함께 돌려준다 */
export function parseCases(text: string, file = ''): { cases: EvalCase[]; errors: string[] } {
  const cases: EvalCase[] = [];
  const errors: string[] = [];
  let raw: unknown[];
  try {
    const v = JSON.parse(text) as unknown;
    raw = Array.isArray(v) ? v : [v];
  } catch {
    raw = [];
    text.split(/\r?\n/).forEach((line, i) => {
      if (!line.trim()) return;
      try {
        raw.push(JSON.parse(line));
      } catch (e) {
        errors.push(`${file}:${i + 1}: JSON이 아닙니다 (${(e as Error).message})`);
      }
    });
  }
  for (const [i, item] of raw.entries()) {
    const r = EvalCase.safeParse(item);
    if (r.success) cases.push(r.data);
    else errors.push(`${file}#${i + 1}${(item as { id?: string })?.id ? ` (${(item as { id: string }).id})` : ''}: ${z.prettifyError(r.error)}`);
  }
  return { cases, errors };
}

const snapOf = (c: EvalCase) => c.turn.snapshot as unknown as PageSnapshot;
const expectsOf = (c: EvalCase): ExpectAction[] => (Array.isArray(c.expect) ? c.expect : [c.expect]);

/** 케이스를 지금의 프롬프트로 그릴 차례 입력 */
export function caseTurn(c: EvalCase): TurnInput {
  const t = c.turn;
  return {
    skill: t.skill as unknown as Skill,
    body: t.body,
    inputs: t.inputs,
    history: t.history as TurnInput['history'],
    datasets: t.datasets,
    office: t.office,
    tools: t.tools as ExternalTool[],
    skills: t.skills as unknown as Skill[],
    page: renderSnapshot(snapOf(c)),
    changes: t.changes,
    step: t.step,
    vision: t.vision,
    ...(t.files ? { files: t.files } : {}),
  };
}

/** 케이스의 차례에 실행이 보낼 동작 스키마 (loop.ts decide와 같은 규칙) */
export function caseSchema(c: EvalCase): JsonSchemaSpec {
  const t = c.turn;
  return actionSchema({
    snap: snapOf(c),
    office: t.office !== undefined,
    external: t.tools.filter((x) => x.permission !== 'deny').map((x) => x.name),
    skills: t.skills.map((s) => s.id),
    scripts: t.skill.scripts.map((s) => s.name),
    vision: t.vision,
    files: !!t.files,
    extra: toolsNamedIn(t.step.text),
  });
}

export function caseMessages(c: EvalCase): ChatMessage[] {
  return buildTurnMessages(caseTurn(c));
}

const norm = (v: unknown) => String(v).trim().replace(/\s+/g, ' ').toLowerCase();
const short = (v: unknown, max = 160) => {
  const s = JSON.stringify(v);
  return s.length <= max ? s : `${s.slice(0, max)}…`;
};

/** 기대값 want와 받은 값 got을 비교한다. 맞으면 null, 아니면 어디가 다른지 */
export function matchValue(want: unknown, got: unknown, snap?: PageSnapshot, path = 'args'): string | null {
  if (want === undefined) return null;
  if (want && typeof want === 'object' && !Array.isArray(want)) {
    const w = want as Record<string, unknown>;
    if ('$any' in w) return got === undefined ? `${path}: 값이 없음` : null;
    if ('$absent' in w) return got === undefined ? null : `${path}: 값이 없어야 함, 받음 ${short(got)}`;
    if ('$contains' in w) return got !== undefined && norm(got).includes(norm(w.$contains)) ? null : `${path}: "${w.$contains}"를 포함해야 함, 받음 ${short(got)}`;
    if ('$regex' in w) return got !== undefined && new RegExp(String(w.$regex), 'i').test(String(got)) ? null : `${path}: /${w.$regex}/ 와 맞지 않음, 받음 ${short(got)}`;
    if ('$oneOf' in w && Array.isArray(w.$oneOf)) {
      return w.$oneOf.some((x) => matchValue(x, got, snap, path) === null) ? null : `${path}: ${short(w.$oneOf)} 중 하나여야 함, 받음 ${short(got)}`;
    }
    if ('$el' in w) {
      const spec = w.$el as { name?: string; role?: string };
      const el = snap?.items.find((i): i is ElementItem => i.kind === 'el' && i.ref === Number(got));
      if (!el) return `${path}: 화면에 ${short(got)}번 요소가 없음`;
      if (spec.name !== undefined && norm(el.name) !== norm(spec.name)) return `${path}: "${spec.name}" 요소여야 함, 받음 [${el.ref}] ${el.role} "${el.name}"`;
      if (spec.role !== undefined && el.role !== spec.role) return `${path}: ${spec.role}여야 함, 받음 [${el.ref}] ${el.role} "${el.name}"`;
      return null;
    }
    if (!got || typeof got !== 'object' || Array.isArray(got)) return `${path}: 객체여야 함, 받음 ${short(got)}`;
    for (const [k, v] of Object.entries(w)) {
      const r = matchValue(v, (got as Record<string, unknown>)[k], snap, `${path}.${k}`);
      if (r) return r;
    }
    return null;
  }
  if (Array.isArray(want)) {
    if (!Array.isArray(got)) return `${path}: 배열이어야 함, 받음 ${short(got)}`;
    if (got.length !== want.length) return `${path}: ${want.length}개여야 함, 받음 ${got.length}개`;
    for (let i = 0; i < want.length; i++) {
      const r = matchValue(want[i], got[i], snap, `${path}[${i}]`);
      if (r) return r;
    }
    return null;
  }
  if (want === null) return got === null || got === undefined ? null : `${path}: 없어야 함, 받음 ${short(got)}`;
  return got !== undefined && norm(want) === norm(got) ? null : `${path}: ${short(want)}여야 함, 받음 ${short(got)}`;
}

export interface ActionGrade {
  /** 도구가 맞음 */
  tool: boolean;
  /** 도구와 인자가 모두 맞음 */
  exact: boolean;
  /** 틀렸으면 가장 가까운 정답과 다른 점 */
  reason?: string;
}

/** 받은 동작을 케이스의 정답(들)과 비교한다 */
export function gradeAction(c: EvalCase, action: Pick<Action, 'tool' | 'args'>): ActionGrade {
  const snap = snapOf(c);
  let best: ActionGrade = { tool: false, exact: false, reason: `도구 ${expectsOf(c).map((e) => e.tool).join(' 또는 ')}여야 함, 받음 ${action.tool}` };
  for (const e of expectsOf(c)) {
    if (e.tool.toLowerCase() !== action.tool.toLowerCase()) continue;
    const diff = matchValue(e.args, action.args, snap);
    if (!diff) return { tool: true, exact: true };
    if (!best.tool) best = { tool: true, exact: false, reason: diff };
  }
  return best;
}

export interface CaseResult {
  id: string;
  tags: string[];
  /** 첫 답이 형식에 맞았는지 */
  firstValid: boolean;
  /** 다시 묻기까지 해서 형식에 맞는 답을 얻었는지 */
  valid: boolean;
  tool: boolean;
  exact: boolean;
  /** 모델을 부른 횟수 */
  calls: number;
  ms: number;
  got?: { tool: string; args: unknown };
  /** 형식이 틀렸던 마지막 답의 앞부분 */
  raw?: string;
  reason?: string;
  /** 모델 호출 자체가 실패함 (네트워크, API 오류) */
  error?: string;
}

export interface EvalReport {
  label: string;
  total: number;
  firstValid: number;
  valid: number;
  tool: number;
  exact: number;
  errors: number;
  avgMs: number;
  avgCalls: number;
  results: CaseResult[];
  /** 서버가 json_schema를 거절해 다른 방식으로 보낸 경우 그 이유 (OpenAiCompatClient.schemaRejected) */
  note?: string;
}

/** 케이스 하나를 모델에 묻고 채점한다. 형식이 틀리면 실행과 같은 말로 다시 묻는다 */
export async function evalCase(c: EvalCase, llm: LlmPort, opts: { retries?: number; signal?: AbortSignal } = {}): Promise<CaseResult> {
  const retries = opts.retries ?? MAX_FORMAT_RETRIES;
  const snap = snapOf(c);
  const schema = caseSchema(c);
  const external = c.turn.tools.filter((x) => x.permission !== 'deny').map((x) => x.name);
  let messages = caseMessages(c);
  const base = { id: c.id, tags: c.tags, firstValid: false, valid: false, tool: false, exact: false };
  const started = Date.now();
  let calls = 0;
  let raw = '';
  let error = '';
  for (let attempt = 0; attempt <= retries; attempt++) {
    let text: string;
    try {
      calls++;
      text = await llm.complete(messages, opts.signal, { schema });
    } catch (e) {
      return { ...base, calls, ms: Date.now() - started, error: (e as Error).message };
    }
    const parsed = parseAction(text, snap, external, { vision: c.turn.vision });
    if (parsed.ok) {
      const g = gradeAction(c, parsed.action);
      return {
        ...base,
        firstValid: attempt === 0,
        valid: true,
        tool: g.tool,
        exact: g.exact,
        calls,
        ms: Date.now() - started,
        got: { tool: parsed.action.tool, args: parsed.action.args },
        ...(g.reason ? { reason: g.reason } : {}),
      };
    }
    raw = text.slice(0, 300);
    error = parsed.error;
    messages = [...messages, { role: 'assistant', content: text }, { role: 'user', content: retryPrompt(parsed.error) }];
  }
  return { ...base, calls, ms: Date.now() - started, raw, reason: `형식 오류: ${error.slice(0, 200)}` };
}

/** 케이스들을 차례로 평가한다 (모델 서버에 한 번에 하나씩만 보낸다) */
export async function runToolEval(
  cases: EvalCase[],
  llm: LlmPort,
  opts: { label?: string; retries?: number; signal?: AbortSignal; onResult?: (r: CaseResult, i: number) => void } = {},
): Promise<EvalReport> {
  const results: CaseResult[] = [];
  for (const [i, c] of cases.entries()) {
    if (opts.signal?.aborted) break;
    const r = await evalCase(c, llm, opts);
    results.push(r);
    opts.onResult?.(r, i);
  }
  return summarize(opts.label ?? 'eval', results);
}

export function summarize(label: string, results: CaseResult[]): EvalReport {
  const count = (f: (r: CaseResult) => boolean) => results.filter(f).length;
  const answered = results.filter((r) => !r.error);
  return {
    label,
    total: results.length,
    firstValid: count((r) => r.firstValid),
    valid: count((r) => r.valid),
    tool: count((r) => r.tool),
    exact: count((r) => r.exact),
    errors: count((r) => !!r.error),
    avgMs: answered.length ? Math.round(answered.reduce((s, r) => s + r.ms, 0) / answered.length) : 0,
    avgCalls: answered.length ? Math.round((answered.reduce((s, r) => s + r.calls, 0) / answered.length) * 100) / 100 : 0,
    results,
  };
}

const pct = (n: number, total: number) => (total === 0 ? '-' : `${n}/${total} (${Math.round((n / total) * 100)}%)`);

/** 보고서 하나 또는 여럿(방식별)을 표로. 여럿이면 나란히 비교한다 */
export function formatReports(reports: EvalReport[], opts: { failures?: number } = {}): string {
  if (reports.length === 0) return '평가한 것이 없습니다';
  const rows: [string, (r: EvalReport) => string][] = [
    ['케이스', (r) => String(r.total)],
    ['형식 통과 (첫 답)', (r) => pct(r.firstValid, r.total)],
    ['형식 통과 (다시 묻기 포함)', (r) => pct(r.valid, r.total)],
    ['도구 정답', (r) => pct(r.tool, r.total)],
    ['동작 정답 (도구+인자)', (r) => pct(r.exact, r.total)],
    ['평균 호출 수', (r) => String(r.avgCalls)],
    ['평균 시간', (r) => `${(r.avgMs / 1000).toFixed(1)}초`],
    ['호출 오류', (r) => String(r.errors)],
  ];
  // 터미널에서 한글은 두 칸을 차지한다
  const cells = (s: string) => [...s].reduce((n, ch) => n + (/[ᄀ-ᇿ㄰-㆏가-힣一-鿿]/.test(ch) ? 2 : 1), 0);
  const width = Math.max(...rows.map(([k]) => cells(k))) + 2;
  const col = Math.max(18, ...reports.map((r) => cells(r.label) + 2));
  const pad = (s: string, n: number) => s + ' '.repeat(Math.max(0, n - cells(s)));
  const lines = [pad('', width) + reports.map((r) => pad(r.label, col)).join('')];
  for (const [k, f] of rows) lines.push(pad(k, width) + reports.map((r) => pad(f(r), col)).join(''));
  for (const r of reports) if (r.note) lines.push('', `[${r.label}] ${r.note}`);
  const max = opts.failures ?? 15;
  for (const r of reports) {
    const wrong = r.results.filter((x) => !x.exact);
    if (wrong.length === 0) continue;
    lines.push('', `[${r.label}] 틀린 케이스 ${wrong.length}개${wrong.length > max ? ` (앞의 ${max}개)` : ''}`);
    for (const x of wrong.slice(0, max)) {
      const got = x.error ? `호출 오류: ${x.error.slice(0, 120)}` : x.got ? `${x.got.tool} ${short(x.got.args, 120)}` : `형식 오류${x.raw ? `: ${short(x.raw, 120)}` : ''}`;
      lines.push(`  - ${x.id}: ${x.reason ?? ''}`, `      받음 ${got}`);
    }
  }
  return lines.join('\n');
}

/** 실행 중 모델이 정한 차례를 평가 케이스로 (정답 자리에는 모델이 고른 동작, reviewed: false) */
export function captureCase(turn: TurnInput, snap: PageSnapshot, action: Action, at = new Date()): EvalCase {
  const stamp = at.toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
  const n = turn.history.length + 1;
  const { dialogs: _d, ...snapshot } = snap;
  return EvalCase.parse({
    id: `${stamp}-${turn.skill.id}-${n}`,
    reviewed: false,
    source: 'capture',
    tags: [turn.skill.id],
    turn: {
      skill: {
        id: turn.skill.id,
        name: turn.skill.name,
        version: turn.skill.version,
        domains: turn.skill.domains,
        scripts: (turn.skill.scripts ?? []).map((s) => ({ name: s.name, description: s.description })),
      },
      body: turn.body,
      inputs: turn.inputs,
      history: JSON.parse(JSON.stringify(turn.history)),
      datasets: turn.datasets,
      ...(turn.office !== undefined ? { office: turn.office } : {}),
      tools: (turn.tools ?? []).map((t) => ({ name: t.name, description: t.description, schema: t.schema, readOnly: t.readOnly, permission: t.permission })),
      skills: (turn.skills ?? []).map((s) => ({
        id: s.id,
        name: s.name,
        description: s.description,
        inputs: s.inputs.map((i) => ({ name: i.name, required: i.required, ...(i.default !== undefined ? { default: i.default } : {}) })),
      })),
      snapshot: JSON.parse(JSON.stringify(snapshot)),
      changes: turn.changes,
      step: turn.step,
      vision: turn.vision === true,
      ...(turn.files ? { files: { roots: [...turn.files.roots], attached: [...turn.files.attached] } } : {}),
    },
    expect: { tool: action.tool, args: JSON.parse(JSON.stringify(action.args)) },
  });
}

/** 사람이 케이스를 검토할 때 보여 줄 글: 단계, 화면(앞부분), 최근 동작, 정답 자리의 동작 */
export function describeCase(c: EvalCase, opts: { pageLines?: number } = {}): string {
  const snap = snapOf(c);
  const page = renderSnapshot(snap).split('\n');
  const max = opts.pageLines ?? 40;
  const el = (ref: unknown) => {
    const e = snap.items.find((i): i is ElementItem => i.kind === 'el' && i.ref === Number(ref));
    return e ? ` → [${e.ref}] ${e.role} "${e.name}"${e.row ? ` row="${e.row}"` : ''}` : '';
  };
  const actions = expectsOf(c).map((e) => {
    const refs = ['ref', 'next_ref', 'add_ref'].filter((k) => e.args[k] !== undefined).map((k) => `${k}${el(e.args[k])}`);
    return `  ${e.tool} ${short(e.args, 300)}${refs.length ? `\n    ${refs.join('\n    ')}` : ''}`;
  });
  return [
    `케이스 ${c.id}${c.reviewed ? '' : ' (검토 전)'}`,
    `스킬 ${c.turn.skill.name} (${c.turn.skill.id}) · 입력 ${short(c.turn.inputs, 200)}`,
    `지금 할 단계 ${c.turn.step.n}/${c.turn.step.total}: ${c.turn.step.text}`,
    ...(c.turn.step.unmet?.length ? [`아직 충족되지 않은 것: ${c.turn.step.unmet.join(' / ')}`] : []),
    '',
    '최근 동작',
    ...(c.turn.history.length ? c.turn.history.slice(-3).map((h) => `  #${h.n} ${h.tool} ${short(h.args, 120)} → ${h.ok ? '성공' : '실패'}: ${h.result.slice(0, 100)}`) : ['  (없음)']),
    '',
    `화면${page.length > max ? ` (앞의 ${max}줄 / ${page.length}줄)` : ''}`,
    ...page.slice(0, max).map((l) => `  ${l}`),
    '',
    Array.isArray(c.expect) ? '정답 (이 중 하나)' : '정답 자리의 동작',
    ...actions,
  ].join('\n');
}
