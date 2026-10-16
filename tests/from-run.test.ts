import { describe, expect, it } from 'vitest';
import { generateWip } from '../mock-site/data.mjs';
import { buildFreeSkill, draftSkill, lintSkill, parseSkill, renameParam, runSkill, stepsFromRun, type AuthorStep, type HistoryEntry, type RunEvent } from '../src/core';
import { JsdomBrowser, memoryFiles, mockLlm } from './helpers';

const PAGE = 'http://localhost:4173/wip.html';
const ui = { ask: async () => '', approve: async () => false };
const meta = { id: 'wip-count', name: '재공 건수', description: '라인을 골라 재공 건수를 알려 준다', owner: '생산관리' };

const entry = (tool: string, args: Record<string, unknown>, targets?: HistoryEntry['targets'], ok = true): HistoryEntry => ({
  n: 0,
  step: 1,
  tool,
  args,
  thought: '',
  ok,
  result: '',
  by: 'model',
  ...(targets ? { targets } : {}),
});
const el = (role: string, name: string, extra: object = {}) => ({ ref: { role, name, dup: false, ...extra } });

/** 자유 요청을 모의 모델로 실행하고 기록을 돌려준다. */
async function freeRun(request: string) {
  const events: RunEvent[] = [];
  const result = await runSkill(buildFreeSkill(PAGE, false), { request }, {
    llm: mockLlm,
    browser: await JsdomBrowser.open('/wip.html'),
    ui,
    files: memoryFiles(),
    onEvent: (e) => events.push(e),
  });
  const entries = events.flatMap((e) => (e.type === 'action' ? [e.entry] : []));
  return { result, entries };
}

describe('실행 기록에 요소 이름을 남긴다', () => {
  it('번호 대신 쓸 역할·이름과 고르기 칸의 보기를 적는다', async () => {
    const { entries } = await freeRun('8라인을 선택하고 조회해서 총 몇 건인지 알려줘');
    const select = entries.find((e) => e.tool === 'select')!;
    expect(select.targets?.ref).toMatchObject({ role: 'combobox', name: '라인', dup: false });
    expect(select.targets?.ref.options).toContain('8라인');
    expect(entries.find((e) => e.tool === 'click')!.targets?.ref).toMatchObject({ role: 'button', name: '조회' });
  });
});

describe('자유 요청 → 스킬', () => {
  it('성공한 동작만 단계로 옮기고, 요청에 나온 값은 매개변수로, 요청은 마지막 목표 단계로 둔다', () => {
    const r = stepsFromRun({
      request: 'DR5 7라인에서 검색해서 정리해줘',
      tabUrl: PAGE,
      entries: [
        entry('select', { ref: 3, value: '7라인' }, el('combobox', '라인', { options: ['6라인', '7라인'] })),
        entry('type', { ref: 5, text: 'DR' }, el('textbox', '제품코드')),
        entry('type', { ref: 5, text: 'DR5' }, el('textbox', '제품코드')),
        entry('click', { ref: 9 }, el('button', '없는 버튼'), false),
        entry('click', { ref: 7 }, el('button', '조회')),
        entry('read_text', {}),
        entry('finish', { summary: '…' }),
      ],
    });
    expect(r.start).toEqual({ url: PAGE });
    expect(r.steps.map((s) => s.kind)).toEqual(['select', 'type', 'click', 'goal']);
    expect(r.steps[0]).toMatchObject({ value: '7라인', variable: true, param: { name: 'line' } });
    expect(r.steps[1]).toMatchObject({ value: 'DR5', variable: true, param: { name: 'product' } });
    expect(r.steps[3]).toEqual({ kind: 'goal', text: '화면의 결과를 확인해 다음 요청에 답한다: {product} {line}에서 검색해서 정리해줘' });
    expect(r.meta.description).toBe('DR5 7라인에서 검색해서 정리해줘');
    expect(r.notes.join('\n')).toMatch(/"7라인", "DR5".*매개변수로 제안/);
  });

  it('요청에 없는 값은 고정값으로 두고, 이름 없는 요소는 빼고 알린다', () => {
    const r = stepsFromRun({
      request: '재공 확인해줘',
      tabUrl: PAGE,
      entries: [entry('navigate', { url: 'http://localhost:4173/portal.html' }), entry('select', { ref: 3, value: '7라인' }, el('combobox', '라인')), entry('click', { ref: 4 })],
    });
    expect(r.start.url).toBe('http://localhost:4173/portal.html');
    expect(r.steps[0]).toMatchObject({ kind: 'select', variable: false, options: ['7라인'] });
    expect(r.steps[0]).not.toHaveProperty('param');
    expect(r.notes.join('\n')).toMatch(/click 동작 하나는 가리킨 요소의 이름을 알 수 없어/);
  });

  it('표를 읽고 정리했으면 표 정리 단계 하나로 합친다', () => {
    const r = stepsFromRun({
      request: '재공을 공정별로 정리해줘',
      tabUrl: PAGE,
      entries: [
        entry('extract_table', { ref: 3, dataset: 'wip', next_ref: 8 }, { ref: { role: 'table', name: '재공 목록', dup: false }, next_ref: { role: 'button', name: '다음', dup: false } }),
        entry('summarize', { instruction: '공정별 건수', source: 'wip' }),
      ],
    });
    expect(r.steps[0]).toEqual({ kind: 'summarize', instruction: '공정별 건수', source: { table: '재공 목록', next: '다음' } });
    expect(r.steps).toHaveLength(2);
  });

  it('매개변수 이름을 바꾸거나 빼면 목표 단계의 자리표시자가 따라 바뀐다', () => {
    const steps: AuthorStep[] = [{ kind: 'goal', text: '{line} 재공을 {line} 기준으로 답한다' }, { kind: 'summarize', instruction: '{line} 정리', source: 'page' }];
    expect(renameParam(steps, 'line', 'fab_line').map((s) => (s.kind === 'goal' ? s.text : s.kind === 'summarize' ? s.instruction : ''))).toEqual([
      '{fab_line} 재공을 {fab_line} 기준으로 답한다',
      '{fab_line} 정리',
    ]);
    expect(renameParam(steps, 'line', { value: '7라인' })[0]).toEqual({ kind: 'goal', text: '7라인 재공을 7라인 기준으로 답한다' });
    // 규칙에 맞지 않는 이름(입력 중)이면 그대로 둔다.
    expect(renameParam(steps, 'line', '라인')).toBe(steps);
  });

  it('잘 된 자유 요청을 저장한 스킬을 다른 라인으로 실행하면 그 라인의 결과로 답한다', async () => {
    const { result, entries } = await freeRun('8라인을 선택하고 조회해서 총 몇 건인지 알려줘');
    expect(result.status, result.message).toBe('done');
    const r = stepsFromRun({ request: '8라인을 선택하고 조회해서 총 몇 건인지 알려줘', tabUrl: PAGE, entries });
    const { source } = draftSkill(meta, r.start, r.steps);
    const report = lintSkill(source);
    expect(report.grade, JSON.stringify(report.findings)).not.toBe('F');
    const skill = parseSkill(source);
    expect(skill.inputs.map((i) => i.name)).toEqual(['line']);

    const again = await runSkill(skill, { line: '7라인' }, { llm: mockLlm, browser: await JsdomBrowser.open('/wip.html'), ui, files: memoryFiles(), direct: true });
    expect(again.status, again.message).toBe('done');
    expect(again.message).toBe(`조회 결과는 총 ${generateWip('7라인').length}건입니다.`);
  });
});
