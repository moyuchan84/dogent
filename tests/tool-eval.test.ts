import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  actionSchema,
  caseSchema,
  captureCase,
  describeCase,
  evalCase,
  formatReports,
  gradeAction,
  matchValue,
  OpenAiCompatClient,
  parseAction,
  parseCases,
  runSkill,
  runToolEval,
  schemaTools,
  toolsNamedIn,
  type EvalCase,
  type LlmPort,
  type LlmSettings,
  type PageSnapshot,
} from '../src/core';
import { ollamaFormat } from '../tools/ollama-proxy.mjs';
import { JsdomBrowser, memoryFiles, mockLlm, scriptedLlm, wipSkill } from './helpers';

const DIR = join(import.meta.dirname, '..', 'evals', 'tool-calls');

function loadAll(): EvalCase[] {
  const all: EvalCase[] = [];
  for (const f of readdirSync(DIR).filter((n) => n.endsWith('.json'))) {
    const { cases, errors } = parseCases(readFileSync(join(DIR, f), 'utf8'), f);
    expect(errors).toEqual([]);
    all.push(...cases);
  }
  return all;
}

/**
 * 시험용 JSON 스키마 검사기. action-schema.ts가 내는 범위(type, enum, const, properties, required,
 * additionalProperties, anyOf, items, 길이·개수·최소값)만 본다. 맞으면 null, 아니면 어디가 틀렸는지.
 */
function validate(schema: any, v: unknown, path = '$'): string | null {
  if (schema.anyOf) {
    const errs = schema.anyOf.map((s: unknown) => validate(s, v, path));
    return errs.some((e: string | null) => e === null) ? null : `${path}: anyOf 어느 것에도 맞지 않음 (${errs.filter(Boolean).slice(0, 3).join(' | ')})`;
  }
  if ('const' in schema && v !== schema.const) return `${path}: ${JSON.stringify(schema.const)}여야 함`;
  if (schema.enum && !schema.enum.includes(v)) return `${path}: ${JSON.stringify(v)}는 enum에 없음`;
  const t = schema.type;
  if (t === 'object') {
    if (!v || typeof v !== 'object' || Array.isArray(v)) return `${path}: 객체가 아님`;
    for (const k of schema.required ?? []) if (!(k in (v as object))) return `${path}.${k}: 없음`;
    for (const [k, val] of Object.entries(v as object)) {
      const sub = schema.properties?.[k];
      if (sub) {
        const e = validate(sub, val, `${path}.${k}`);
        if (e) return e;
      } else if (schema.additionalProperties === false) return `${path}.${k}: 스키마에 없는 칸`;
    }
    return null;
  }
  if (t === 'array') {
    if (!Array.isArray(v)) return `${path}: 배열이 아님`;
    if (schema.minItems !== undefined && v.length < schema.minItems) return `${path}: 너무 적음`;
    if (schema.maxItems !== undefined && v.length > schema.maxItems) return `${path}: 너무 많음`;
    for (const [i, x] of v.entries()) {
      const e = schema.items ? validate(schema.items, x, `${path}[${i}]`) : null;
      if (e) return e;
    }
    return null;
  }
  if (t === 'string') {
    if (typeof v !== 'string') return `${path}: 글이 아님`;
    if (schema.minLength !== undefined && v.length < schema.minLength) return `${path}: 너무 짧음`;
    if (schema.maxLength !== undefined && v.length > schema.maxLength) return `${path}: 너무 김`;
    return null;
  }
  if (t === 'integer' || t === 'number') {
    if (typeof v !== 'number' || (t === 'integer' && !Number.isInteger(v))) return `${path}: 수가 아님`;
    if (schema.minimum !== undefined && v < schema.minimum) return `${path}: 너무 작음`;
    if (schema.maximum !== undefined && v > schema.maximum) return `${path}: 너무 큼`;
    return null;
  }
  if (t === 'boolean') return typeof v === 'boolean' ? null : `${path}: 참거짓이 아님`;
  return null;
}

/** 정답(맞추개 포함)을 모델이 낼 법한 실제 답으로 바꾼다. 도구가 꼭 받아야 하는 칸이 정답에 없으면 채운다 */
function concrete(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(concrete);
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    if ('$contains' in o) return `결과: ${o.$contains}`;
    if ('$oneOf' in o) return concrete((o.$oneOf as unknown[])[0]);
    if ('$any' in o) return '아무 값';
    // 정규식에서 맞는 글 하나를 만든다 (^ $를 떼고 \. \\ 같은 이스케이프를 푼다). 케이스의 정규식은 이 범위로만 쓴다
    if ('$regex' in o) return String(o.$regex).replace(/^\^|\$$/g, '').replace(/\\(.)/g, '$1');
    return Object.fromEntries(Object.entries(o).map(([k, x]) => [k, concrete(x)]));
  }
  return v;
}
const REQUIRED_FILL: Record<string, Record<string, unknown>> = {
  download_table: { dataset: 'data' },
  ask_user: { question: '어느 라인인가요?' },
  abort: { reason: '이 화면에서는 할 수 없습니다' },
  finish: { summary: '끝' },
};
function oracleAnswer(c: EvalCase) {
  const e = Array.isArray(c.expect) ? c.expect[0] : c.expect;
  return { thought: '정답', tool: e.tool, args: { ...REQUIRED_FILL[e.tool], ...(concrete(e.args) as object) } };
}

const settings: LlmSettings = { baseUrl: 'http://x/v1', apiKey: 'k', model: 'gemma', jsonMode: false, timeoutScale: 1, skillDirect: true, pathCache: true, skillsUrl: '' };
const reply = (content: string) => new Response(JSON.stringify({ choices: [{ message: { content } }] }));

describe('동작 스키마 (제약 디코딩)', () => {
  const snap: PageSnapshot = {
    url: 'http://localhost:4173/wip.html',
    title: '재공',
    hasPassword: false,
    items: [
      { kind: 'el', ref: 1, role: 'combobox', name: '라인' },
      { kind: 'el', ref: 4, role: 'button', name: '조회' },
      { kind: 'el', ref: 10, role: 'table', name: '재공 목록' },
    ],
  };

  it('안내하지 않은 도구는 넣지 않는다 (오피스·외부 도구·스킬·스크립트·그림)', () => {
    const plain = schemaTools({ snap });
    expect(plain).toContain('click');
    expect(plain).toContain('extract_table');
    for (const t of ['excel_read', 'call_tool', 'run_skill', 'run_script', 'look']) expect(plain).not.toContain(t);
    const all = schemaTools({ snap, office: true, external: ['mes.lot_list'], skills: ['wip-check'], scripts: ['calc'], vision: true });
    for (const t of ['excel_read', 'ppt_save', 'call_tool', 'run_skill', 'run_script', 'look']) expect(all).toContain(t);
  });

  it('표가 없는 화면에서는 표 도구를 빼되, 단계 글에 이름이 있으면 넣는다', () => {
    const noTable = { ...snap, items: snap.items.filter((i) => i.kind !== 'el' || i.role !== 'table') };
    expect(schemaTools({ snap: noTable })).not.toContain('extract_table');
    expect(toolsNamedIn('extract_table로 재공 목록을 추출한다. run_skill로 부른다')).toEqual(['extract_table', 'run_skill']);
    const named = actionSchema({ snap: noTable, extra: ['extract_table'] }).schema as any;
    const v = named.anyOf.find((x: any) => x.properties.tool.const === 'extract_table');
    // 표가 아직 없으면 화면의 아무 요소나 받는다 (빈 enum이면 어떤 답도 못 낸다)
    expect(v.properties.args.properties.ref.enum).toEqual([1, 4]);
  });

  it('ref는 지금 화면의 번호만, 표 도구의 ref는 표만 받는다', () => {
    const s = actionSchema({ snap }).schema as any;
    const of = (tool: string) => s.anyOf.find((x: any) => x.properties.tool.const === tool).properties.args;
    expect(of('click').properties.ref).toEqual({ type: 'integer', enum: [1, 4, 10] });
    expect(of('extract_table').properties.ref.enum).toEqual([10]);
    expect(of('extract_table').properties.next_ref.enum).toEqual([1, 4, 10]);
    expect(validate(s, { thought: 'x', tool: 'click', args: { ref: 4 } })).toBeNull();
    expect(validate(s, { thought: 'x', tool: 'click', args: { ref: 99 } })).not.toBeNull();
    expect(validate(s, { thought: 'x', tool: 'clik', args: { ref: 4 } })).not.toBeNull();
    expect(validate(s, { thought: 'x', tool: 'click', args: { ref: 4, foo: 1 } })).not.toBeNull();
  });

  it('외부 도구 이름과 스킬 id는 목록 중 하나만 받는다', () => {
    const s = actionSchema({ snap, external: ['mes.lot_list'], skills: ['wip-check'] }).schema as any;
    expect(validate(s, { thought: '', tool: 'call_tool', args: { name: 'mes.lot_list', args: { line: 'P1' } } })).toBeNull();
    expect(validate(s, { thought: '', tool: 'call_tool', args: { name: 'mes.other' } })).not.toBeNull();
    expect(validate(s, { thought: '', tool: 'run_skill', args: { id: 'nope' } })).not.toBeNull();
  });

  it('문법 엔진이 다르게 읽는 키(format, pattern, oneOf, $schema)를 남기지 않는다', () => {
    const text = JSON.stringify(actionSchema({ snap, office: true, external: ['a.b'], skills: ['s'], scripts: ['c'], vision: true }).schema);
    for (const k of ['"format"', '"pattern"', '"oneOf"', '"$schema"', '"propertyNames"', '"exclusiveMinimum"', '"default"']) expect(text).not.toContain(k);
  });
});

describe('평가 케이스 (evals/tool-calls)', () => {
  const cases = loadAll();

  it('케이스가 있고 id가 겹치지 않는다', () => {
    expect(cases.length).toBeGreaterThanOrEqual(50);
    expect(new Set(cases.map((c) => c.id)).size).toBe(cases.length);
  });

  it('정답 동작은 그 화면에서 실행이 받아들이는 동작이고, 그 차례의 스키마에도 맞는다', () => {
    for (const c of cases) {
      const answer = oracleAnswer(c);
      const parsed = parseAction(JSON.stringify(answer), c.turn.snapshot as unknown as PageSnapshot, c.turn.tools.map((t) => t.name));
      expect(parsed.ok, `${c.id}: ${!parsed.ok && parsed.error}`).toBe(true);
      // 스키마는 parseAction이 기본값을 채우기 전의 모델 답을 본다
      expect(validate(caseSchema(c).schema, answer), c.id).toBeNull();
      if (parsed.ok) expect(gradeAction(c, parsed.action), c.id).toEqual({ tool: true, exact: true });
    }
  });

  it('정답만 내는 모델이면 모두 맞고, 실행과 같은 프롬프트를 받는다', async () => {
    for (const c of cases) {
      const oracle: LlmPort = {
        async complete(messages, _signal, opts) {
          expect(messages[0].content).toContain('당신은 사내 웹 시스템을 조작하는 업무 에이전트입니다');
          const user = messages.at(-1)!.content;
          expect(user).toContain(`## 지금 할 단계 (${c.turn.step.n}/${c.turn.step.total})\n${c.turn.step.n}. ${c.turn.step.text}`);
          expect(user).toContain(`입력값: ${JSON.stringify(c.turn.inputs)}`);
          expect(opts?.schema?.name).toBe('dogent_action');
          return JSON.stringify(oracleAnswer(c));
        },
      };
      const r = await evalCase(c, oracle);
      expect(r.exact, `${c.id}: ${r.reason}`).toBe(true);
      expect(r.firstValid).toBe(true);
    }
  });
});

describe('채점', () => {
  const snap: PageSnapshot = { url: 'http://a/', title: '', hasPassword: false, items: [{ kind: 'el', ref: 3, role: 'button', name: '조회' }] };

  it('맞추개: $contains, $regex, $oneOf, $any, $absent, $el', () => {
    expect(matchValue({ $contains: '173' }, '총 173건입니다')).toBeNull();
    expect(matchValue({ $contains: '173' }, '총 17건')).toMatch(/포함해야/);
    expect(matchValue({ $regex: '^P7-\\d+$' }, 'P7-00031')).toBeNull();
    expect(matchValue({ $oneOf: [6, 7] }, 7)).toBeNull();
    expect(matchValue({ $oneOf: [6, 7] }, 8)).toMatch(/중 하나/);
    expect(matchValue({ $any: true }, undefined)).toMatch(/값이 없음/);
    expect(matchValue({ $absent: true }, 1)).toMatch(/없어야/);
    expect(matchValue({ $el: { name: '조회', role: 'button' } }, 3, snap)).toBeNull();
    expect(matchValue({ $el: { name: '저장' } }, 3, snap)).toMatch(/"저장" 요소여야/);
  });

  it('글은 앞뒤 공백·대소문자를 가리지 않고, 수는 글로 와도 같게 본다. 적지 않은 칸은 보지 않는다', () => {
    expect(matchValue({ text: 'DR5', ref: 3 }, { text: ' dr5 ', ref: '3', row: 'x' })).toBeNull();
    expect(matchValue({ sheets: [{ name: '원본' }] }, { sheets: [{ name: '원본', dataset: 'wip' }, { name: 'x' }] })).toMatch(/1개여야/);
  });

  it('정답이 여럿이면 하나만 맞아도 된다. 도구는 맞고 인자가 틀리면 도구 정답으로 센다', () => {
    const c = { expect: [{ tool: 'abort', args: {} }, { tool: 'click', args: { ref: 3 } }], turn: { snapshot: snap } } as unknown as EvalCase;
    expect(gradeAction(c, { tool: 'click', args: { ref: 3 } } as any)).toEqual({ tool: true, exact: true });
    expect(gradeAction(c, { tool: 'click', args: { ref: 4 } } as any)).toMatchObject({ tool: true, exact: false });
    expect(gradeAction(c, { tool: 'finish', args: {} } as any)).toMatchObject({ tool: false, reason: expect.stringMatching(/abort 또는 click/) });
  });

  it('형식이 틀리면 실행과 같은 말로 다시 묻고, 첫 답 형식 통과와 나눠 센다', async () => {
    const c = loadAll().find((x) => x.id === 'wip7-02')!;
    const llm = scriptedLlm(['라인을 고르겠습니다', { thought: '라인', tool: 'select', args: { ref: 1, value: '7라인' } }]);
    const r = await evalCase(c, llm);
    expect(r).toMatchObject({ firstValid: false, valid: true, exact: true, calls: 2 });
    const bad = await evalCase(c, scriptedLlm(['x', 'y', 'z']));
    expect(bad).toMatchObject({ valid: false, exact: false, calls: 3 });
    expect(bad.reason).toMatch(/형식 오류/);
  });

  it('모델 호출이 실패하면 오류로 남기고 다음 케이스로 간다', async () => {
    const cs = loadAll().slice(0, 2);
    const report = await runToolEval(cs, { complete: async () => Promise.reject(new Error('모델 API 오류 401: no')) }, { label: 'json' });
    expect(report).toMatchObject({ total: 2, errors: 2, exact: 0 });
    const text = formatReports([report, { ...report, label: 'schema' }]);
    expect(text).toMatch(/json\s+schema/);
    expect(text).toMatch(/호출 오류: 모델 API 오류 401/);
  });
});

describe('실행에서 케이스 모으기', () => {
  it('모델이 정한 차례를 케이스로 남기고, 그 케이스를 다시 평가할 수 있다', async () => {
    const got: EvalCase[] = [];
    const result = await runSkill(wipSkill(), { line: '7라인', hold_hours: 24 }, {
      llm: mockLlm,
      browser: new JsdomBrowser(),
      ui: { ask: async () => '', approve: async () => false },
      files: memoryFiles(),
      direct: false,
      onTurn: (turn, snap, action) => got.push(captureCase(turn, snap, action, new Date('2026-11-16T05:06:07Z'))),
    });
    expect(result.status, result.message).toBe('done');
    expect(got.length).toBeGreaterThan(5);
    const select = got.find((c) => (c.expect as { tool: string }).tool === 'select')!;
    expect(select.id).toMatch(/^20261116-050607-wip-check-\d+$/);
    expect(select).toMatchObject({ reviewed: false, source: 'capture' });
    // 저장한 뒤 실행이 계속돼도 케이스의 기록은 그때 것 그대로다
    expect(select.turn.history.length).toBeLessThan(result.actions);
    expect(describeCase(select)).toMatch(/select \{"ref":1,"value":"7라인"\}[\s\S]*ref → \[1\] combobox "라인"/);
    const again = parseCases(JSON.stringify(got));
    expect(again.errors).toEqual([]);
    const report = await runToolEval(again.cases, mockLlm);
    expect(report.exact).toBe(got.length);
  });
});

describe('모델 클라이언트의 json_schema', () => {
  const schema = { name: 'dogent_action', schema: { type: 'object' } };

  it('jsonSchema가 켜져 있고 스키마가 있으면 response_format json_schema를 보낸다', async () => {
    const bodies: any[] = [];
    const fetchImpl = (async (_u: string, init: RequestInit) => (bodies.push(JSON.parse(init.body as string)), reply('{}'))) as typeof fetch;
    const client = new OpenAiCompatClient({ ...settings, jsonMode: true, jsonSchema: true }, fetchImpl);
    await client.complete([{ role: 'user', content: 'x' }], undefined, { schema });
    await client.complete([{ role: 'user', content: 'x' }]);
    expect(bodies[0].response_format).toEqual({ type: 'json_schema', json_schema: schema });
    // 스키마 없이 부르면(요약, 스킬 다듬기 등) 예전처럼 jsonMode를 따른다
    expect(bodies[1].response_format).toEqual({ type: 'json_object' });
    // 꺼져 있으면 스키마를 줘도 보내지 않는다
    const off = new OpenAiCompatClient({ ...settings }, fetchImpl);
    await off.complete([{ role: 'user', content: 'x' }], undefined, { schema });
    expect(bodies[2].response_format).toBeUndefined();
  });

  it('서버가 json_schema를 거절하면 그 클라이언트에서는 끄고 예전 방식으로 다시 보낸다', async () => {
    const bodies: any[] = [];
    const fetchImpl = (async (_u: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string);
      bodies.push(body);
      return body.response_format?.type === 'json_schema' ? new Response('response_format type json_schema is not supported', { status: 400 }) : reply('{"tool":"finish"}');
    }) as typeof fetch;
    const client = new OpenAiCompatClient({ ...settings, jsonMode: true, jsonSchema: true }, fetchImpl);
    expect(await client.complete([{ role: 'user', content: 'x' }], undefined, { schema })).toBe('{"tool":"finish"}');
    expect(client.schemaRejected).toMatch(/not supported/);
    await client.complete([{ role: 'user', content: 'x' }], undefined, { schema });
    expect(bodies.map((b) => b.response_format.type)).toEqual(['json_schema', 'json_object', 'json_object']);
  });

  it('스키마와 상관없는 400은 그대로 오류로 올린다', async () => {
    const fetchImpl = (async () => new Response('invalid ticket', { status: 400 })) as unknown as typeof fetch;
    const client = new OpenAiCompatClient({ ...settings, jsonSchema: true }, fetchImpl);
    await expect(client.complete([{ role: 'user', content: 'x' }], undefined, { schema })).rejects.toThrow('400');
    expect(client.schemaRejected).toBeNull();
  });

  it('Ollama 중계는 json_schema를 Ollama의 format으로 넘긴다', () => {
    expect(ollamaFormat({ type: 'json_schema', json_schema: schema })).toEqual({ format: { type: 'object' } });
    expect(ollamaFormat({ type: 'json_object' })).toEqual({ format: 'json' });
    expect(ollamaFormat(undefined)).toEqual({});
  });
});
