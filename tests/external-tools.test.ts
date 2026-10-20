import { describe, expect, it } from 'vitest';
import {
  buildFreeSkill,
  buildTurnMessages,
  describeTools,
  noBrowser,
  parseAction,
  qualify,
  runSkill,
  tableFromText,
  type ExternalTool,
  type RunEvent,
  type ToolPort,
} from '../src/core';
import { memoryFiles, scriptedLlm } from './helpers';

const step = (tool: string, args: object = {}) => ({ tool, args });

const LOTS = [
  { lot: 'L1', qty: 10, hold: false },
  { lot: 'L2', qty: 20, hold: true },
];

/** MCP 서버 대신 도구 세 개를 둔 통로. 부른 기록을 남긴다. */
function fakeTools(over: Partial<Record<string, ExternalTool['permission']>> = {}) {
  const calls: string[] = [];
  const tools: ExternalTool[] = [
    { name: 'mes.lot_list', description: '재공 Lot 목록', readOnly: true, permission: over.lot_list ?? 'allow', schema: { properties: { line: { type: 'string' } }, required: ['line'] } },
    { name: 'mes.lot_hold', description: 'Lot을 홀드한다', readOnly: false, permission: over.lot_hold ?? 'ask', schema: { properties: { lot: { type: 'string' } }, required: ['lot'] } },
    { name: 'mes.secret', description: '쓰면 안 되는 도구', readOnly: true, permission: 'deny' },
  ];
  const port: ToolPort = {
    list: () => tools,
    call: async (name, args) => {
      calls.push(`${name} ${JSON.stringify(args)}`);
      if (name === 'mes.lot_list') return { text: JSON.stringify(LOTS), isError: false };
      if (name === 'mes.lot_hold') return { text: args.lot === 'bad' ? '없는 Lot' : `${args.lot} 홀드함`, isError: args.lot === 'bad' };
      return { text: '', isError: false };
    },
  };
  return { port, calls };
}

const ui = (answer: boolean, asked: string[] = []) => ({
  ask: async () => '',
  approve: async () => false,
  confirm: async (m: string) => (asked.push(m), answer),
});

function run(llm: ReturnType<typeof scriptedLlm>, tools: ToolPort, o: { answer?: boolean; dryRun?: boolean; asked?: string[] } = {}) {
  const events: RunEvent[] = [];
  return runSkill(
    buildFreeSkill(null, false, undefined, false, true),
    { request: 'Lot 확인' },
    { llm, browser: noBrowser(), tools, ui: ui(o.answer ?? true, o.asked), files: memoryFiles(), onEvent: (e) => events.push(e), dryRun: o.dryRun },
  ).then((result) => ({ result, events }));
}

describe('외부 도구 (MCP) 호출', () => {
  it('읽기 도구 결과 표를 데이터셋에 담아 가공하고 묻지 않고 부른다', async () => {
    const { port, calls } = fakeTools();
    const asked: string[] = [];
    const llm = scriptedLlm([
      step('call_tool', { name: 'mes.lot_list', args: { line: 'P1' }, dataset: 'lots' }),
      step('transform', { source: 'lots', target: 'held', steps: [{ op: 'filter', match: 'all', where: [{ col: 'hold', cmp: '==', value: 'true' }] }] }),
      step('finish', { summary: '전체 {rows.lots}건' }),
    ]);
    const { result } = await run(llm, port, { asked });
    expect(result.status, result.message).toBe('done');
    expect(result.message).toBe('전체 2건');
    expect(calls).toEqual(['mes.lot_list {"line":"P1"}']);
    expect(asked).toEqual([]);
  });

  it('도구 이름을 tool에 바로 적어도 call_tool로 받는다', () => {
    const r = parseAction('{"thought":"t","tool":"MES.lot_list","args":{"line":"P1"}}', undefined, ['mes.lot_list']);
    expect(r.ok && r.action.tool).toBe('call_tool');
    expect(r.ok && r.action.tool === 'call_tool' && r.action.args).toEqual({ name: 'mes.lot_list', args: { line: 'P1' } });
    expect(parseAction('{"tool":"mes.nope","args":{}}', undefined, ['mes.lot_list']).ok).toBe(false);
  });

  it('바꾸는 도구는 사용자에게 묻고, 거절하면 부르지 않는다', async () => {
    const { port, calls } = fakeTools();
    const asked: string[] = [];
    const llm = scriptedLlm([step('call_tool', { name: 'mes.lot_hold', args: { lot: 'L2' } }), step('abort', { reason: '거절됨' })]);
    const { result, events } = await run(llm, port, { answer: false, asked });
    expect(calls).toEqual([]);
    expect(asked).toHaveLength(1);
    expect(asked[0]).toContain('mes.lot_hold');
    expect(events.find((e) => e.type === 'action')).toMatchObject({ entry: { ok: false } });
    expect(result.status).toBe('aborted');
  });

  it('허락하면 부르고, 도구 오류는 실패로 돌려준다', async () => {
    const { port, calls } = fakeTools();
    const llm = scriptedLlm([
      step('call_tool', { name: 'mes.lot_hold', args: { lot: 'bad' } }),
      step('call_tool', { name: 'mes.lot_hold', args: { lot: 'L2' } }),
      step('finish', { summary: '끝' }),
    ]);
    const { result, events } = await run(llm, port);
    expect(result.status, result.message).toBe('done');
    expect(calls).toHaveLength(2);
    const actions = events.flatMap((e) => (e.type === 'action' ? [e.entry] : []));
    expect(actions[0].ok).toBe(false);
    expect(actions[0].result).toContain('도구 오류');
    expect(actions[1].ok).toBe(true);
  });

  it('금지한 도구는 모델에 보이지 않고 불러도 막힌다', async () => {
    const { port, calls } = fakeTools();
    expect(describeTools(port.list())).not.toContain('mes.secret');
    const llm = scriptedLlm([step('call_tool', { name: 'mes.secret', args: {} }), step('abort', { reason: '못 씀' })]);
    const { events } = await run(llm, port);
    const first = events.flatMap((e) => (e.type === 'action' ? [e.entry] : []))[0];
    expect(first.ok).toBe(false);
    expect(first.result).toContain('금지');
    expect(calls).toEqual([]);
  });

  it('시험 실행은 바꾸는 도구 앞에서 멈추고 읽기 도구는 그대로 부른다', async () => {
    const { port, calls } = fakeTools({ lot_hold: 'allow' });
    const llm = scriptedLlm([step('call_tool', { name: 'mes.lot_list', args: { line: 'P1' } }), step('call_tool', { name: 'mes.lot_hold', args: { lot: 'L2' } })]);
    const { result } = await run(llm, port, { dryRun: true });
    expect(result.status).toBe('dryrun');
    expect(calls).toEqual(['mes.lot_list {"line":"P1"}']);
  });

  it('도구가 없는 실행에서 call_tool은 실패한다', async () => {
    const llm = scriptedLlm([step('call_tool', { name: 'mes.lot_list' }), step('abort', { reason: '없음' })]);
    const events: RunEvent[] = [];
    const result = await runSkill(buildFreeSkill(null, false), { request: 'x' }, { llm, browser: noBrowser(), ui: ui(true), files: memoryFiles(), onEvent: (e) => events.push(e) });
    expect(result.status).toBe('aborted');
    expect(events.flatMap((e) => (e.type === 'action' ? [e.entry] : []))[0].result).toContain('없습니다');
  });
});

describe('프롬프트와 표 변환', () => {
  it('도구가 있으면 시스템 프롬프트에 도구 목록과 필수 인자 표시가 들어간다', () => {
    const { port } = fakeTools();
    const msgs = buildTurnMessages({
      skill: buildFreeSkill(null, false, undefined, false, true),
      body: '',
      inputs: {},
      history: [],
      datasets: '(없음)',
      tools: port.list(),
      page: '',
      changes: null,
      step: { n: 1, total: 1, text: 'x', unmet: null },
    });
    const system = msgs[0].content;
    expect(system).toContain('외부 도구');
    expect(system).toContain('- mes.lot_list {"line*"}');
    expect(system).toContain('바꾸는 도구, 부르기 전에 사용자에게 묻습니다');
    expect(system).not.toContain('mes.secret');
  });

  it('도구가 없으면 외부 도구 안내가 없다', () => {
    const msgs = buildTurnMessages({
      skill: buildFreeSkill(null, false),
      body: '',
      inputs: {},
      history: [],
      datasets: '',
      page: '',
      changes: null,
      step: { n: 1, total: 1, text: 'x', unmet: null },
    });
    expect(msgs[0].content).not.toContain('외부 도구');
  });

  it('JSON 객체 배열과 {rows:[…]}를 표로 바꾸고 그 밖은 null', () => {
    expect(tableFromText('[{"a":1,"b":"x"},{"a":2,"c":null}]')).toEqual({
      columns: ['a', 'b', 'c'],
      rows: [
        [1, 'x', ''],
        [2, '', ''],
      ],
    });
    expect(tableFromText('{"total":1,"rows":[{"a":1}]}')?.columns).toEqual(['a']);
    expect(tableFromText('그냥 글')).toBeNull();
    expect(tableFromText('[1,2]')).toBeNull();
    expect(tableFromText('[]')).toBeNull();
  });

  it('이름에 쓸 수 없는 글자는 _로 바꾼다', () => {
    expect(qualify('사내 MES', 'lot.list')).toBe('___MES.lot_list');
  });
});
