import { describe, expect, it } from 'vitest';
import { generateWip } from '../mock-site/data.mjs';
import { planRequest, resolveInputs, runSkill, type RunEvent } from '../src/core';
import { JsdomBrowser, memoryFiles, mockLlm, readWorkbook, scriptedLlm, wipSkill } from './helpers';

const ui = { ask: async () => '', approve: async () => false };
const num = (s: string) => Number(s.replace(/,/g, ''));

/** 모의 사이트의 원본 데이터에서 기대 결과를 따로 계산한다 (에이전트의 가공 엔진을 쓰지 않는다). */
function expected(line: string, step: string | undefined, holdHours: number) {
  const rows = generateWip(line, step);
  const hold = rows.filter((r) => Number(r[5]) >= holdHours || r[4] === 'HOLD');
  const byStep = new Map<string, { lots: number; qty: number }>();
  for (const r of rows) {
    const g = byStep.get(r[2]) ?? { lots: 0, qty: 0 };
    g.lots++;
    g.qty += num(r[3]);
    byStep.set(r[2], g);
  }
  return { rows, hold, byStep };
}

describe('재공 확인 스킬 (모의 사이트 + 모의 모델)', () => {
  it('여러 페이지를 끝까지 추출해 엑셀 세 시트를 만든다', async () => {
    const skill = wipSkill();
    const browser = new JsdomBrowser();
    const files = memoryFiles();
    const result = await runSkill(skill, { line: '7라인', hold_hours: 24 }, { llm: mockLlm, browser, ui, files });

    expect(result.status, result.message).toBe('done');
    expect(result.files).toEqual(['재공확인_7라인.xlsx']);

    const want = expected('7라인', undefined, 24);
    expect(want.rows).toHaveLength(128);
    const book = await readWorkbook(files.saved.get('재공확인_7라인.xlsx')!);
    expect(Object.keys(book)).toEqual(['원본', '정체Lot', '공정별집계']);

    // 원본: 화면 순서 그대로, 값은 숫자로 변환
    expect(book['원본'][0]).toEqual(['Lot ID', '제품', '공정', '수량', '상태', '정체시간']);
    expect(book['원본'].slice(1)).toEqual(want.rows.map((r) => [r[0], r[1], r[2], num(r[3]), r[4], Number(r[5])]));

    // 정체Lot: 같은 Lot 집합, 정체시간 내림차순
    const holdRows = book['정체Lot'].slice(1);
    expect(holdRows.map((r) => r[0]).sort()).toEqual(want.hold.map((r) => r[0]).sort());
    expect(want.hold.length).toBeGreaterThan(0);
    const hours = holdRows.map((r) => r[5] as number);
    expect(hours).toEqual([...hours].sort((a, b) => b - a));

    // 공정별집계
    expect(book['공정별집계'][0]).toEqual(['공정', 'Lot수', '수량합계']);
    const agg = book['공정별집계'].slice(1);
    expect(agg).toHaveLength(want.byStep.size);
    for (const [name, lots, qty] of agg) {
      expect({ lots, qty }).toEqual(want.byStep.get(name as string));
    }
    expect(result.message).toContain('총 재공 128 Lot');
  }, 30_000);

  it('공정 조건을 걸면 그 공정만 나온다', async () => {
    const browser = await JsdomBrowser.open('/wip.html');
    const files = memoryFiles();
    const result = await runSkill(
      wipSkill(),
      { line: '8라인', step: 'PHOTO', hold_hours: 30 },
      { llm: mockLlm, browser, ui, files },
    );
    expect(result.status, result.message).toBe('done');
    const want = expected('8라인', 'PHOTO', 30);
    const book = await readWorkbook(files.saved.get('재공확인_8라인.xlsx')!);
    expect(book['원본'].slice(1).map((r) => r[0])).toEqual(want.rows.map((r) => r[0]));
    expect(book['원본'].slice(1).every((r) => r[2] === 'PHOTO')).toBe(true);
    expect(book['정체Lot']).toHaveLength(want.hold.length + 1);
  }, 30_000);

  it('없는 라인이면 저장하지 않고 중단한다', async () => {
    const files = memoryFiles();
    const result = await runSkill(
      wipSkill(),
      { line: '9라인', hold_hours: 24 },
      { llm: mockLlm, browser: new JsdomBrowser(), ui, files },
    );
    expect(result.status).toBe('aborted');
    expect(result.message).toContain('9라인');
    expect(files.saved.size).toBe(0);
  });

  it('로그인 화면이면 모델을 부르지 않고 중단한다', async () => {
    const llm = scriptedLlm([{ step: 1, tool: 'finish', args: { summary: 'x' } }]);
    const result = await runSkill(
      wipSkill(),
      { line: '7라인', hold_hours: 24 },
      { llm, browser: await JsdomBrowser.open('/login.html'), ui, files: memoryFiles() },
    );
    expect(result.status).toBe('aborted');
    expect(result.message).toContain('로그인');
    expect(llm.calls).toBe(0);
  });
});

describe('루프 통제', () => {
  it('저장 계열 버튼은 모델이 눌러도 실행되지 않는다', async () => {
    const browser = await JsdomBrowser.open('/wip.html');
    const snap = await browser.snapshot();
    const save = snap.items.find((i) => i.kind === 'el' && i.name === '조건 저장');
    expect(save).toBeDefined();
    const ref = (save as { ref: number }).ref;
    const events: RunEvent[] = [];
    const result = await runSkill(
      wipSkill(),
      { line: '7라인', hold_hours: 24 },
      {
        llm: scriptedLlm([{ step: 3, thought: '저장', tool: 'click', args: { ref } }]),
        browser,
        ui,
        files: memoryFiles(),
        onEvent: (e) => events.push(e),
      },
    );
    expect(result.status).toBe('aborted');
    expect(events.filter((e) => e.type === 'blocked')).toHaveLength(3);
    expect(browser.document.getElementById('msg')!.textContent).toBe('');
  });

  it('허용 도메인 밖으로 이동하지 않는다', async () => {
    const browser = new JsdomBrowser();
    const result = await runSkill(
      wipSkill(),
      { line: '7라인', hold_hours: 24 },
      {
        llm: scriptedLlm([{ step: 1, tool: 'navigate', args: { url: 'https://evil.example/collect' } }]),
        browser,
        ui,
        files: memoryFiles(),
      },
    );
    expect(result.status).toBe('aborted');
    expect(browser.dom.window.location.href).toBe('https://start.example/');
  });

  it('형식이 틀린 응답은 다시 요청하고, 계속 틀리면 오류로 끝낸다', async () => {
    const events: RunEvent[] = [];
    const ok = await runSkill(
      wipSkill(),
      { line: '7라인', hold_hours: 24 },
      {
        llm: scriptedLlm(['죄송하지만 잘 모르겠습니다', { tool: 'abort', args: { reason: '끝' } }]),
        browser: new JsdomBrowser(),
        ui,
        files: memoryFiles(),
        onEvent: (e) => events.push(e),
      },
    );
    expect(ok.status).toBe('aborted');
    expect(events.filter((e) => e.type === 'llm_retry')).toHaveLength(1);

    const bad = await runSkill(
      wipSkill(),
      { line: '7라인', hold_hours: 24 },
      { llm: scriptedLlm(['{"tool":"fly"}']), browser: new JsdomBrowser(), ui, files: memoryFiles() },
    );
    expect(bad.status).toBe('error');
  });

  it('중지 신호를 받으면 멈춘다', async () => {
    const abort = new AbortController();
    const llm = scriptedLlm([{ step: 1, tool: 'wait_for', args: { text: '없는 글자', timeout_sec: 0.1 } }]);
    const result = await runSkill(
      wipSkill(),
      { line: '7라인', hold_hours: 24 },
      {
        llm,
        browser: await JsdomBrowser.open('/wip.html'),
        ui,
        files: memoryFiles(),
        signal: abort.signal,
        onEvent: (e) => e.type === 'action' && abort.abort(),
      },
    );
    expect(result.status).toBe('stopped');
    expect(llm.calls).toBe(1);
  });

});

describe('자연어 요청 해석', () => {
  it('요청에서 스킬과 입력값을 뽑고, 폼 검증을 통과한다', async () => {
    const skills = [wipSkill()];
    const plan = await planRequest('8라인 PHOTO 공정 재공 확인해줘', skills, mockLlm);
    expect(plan).toMatchObject({ skill_id: 'wip-check', inputs: { line: '8라인', step: 'PHOTO' } });
    expect(resolveInputs(skills[0], plan.inputs)).toEqual({
      values: { line: '8라인', step: 'PHOTO', hold_hours: 24 },
      errors: [],
    });
  });

  it('맞는 스킬이 없거나 모델이 없는 스킬을 고르면 null', async () => {
    expect((await planRequest('점심 메뉴 추천', [wipSkill()], mockLlm)).skill_id).toBeNull();
    const liar = scriptedLlm([{ skill_id: 'delete-all', inputs: {} }]);
    expect((await planRequest('아무거나', [wipSkill()], liar)).skill_id).toBeNull();
  });
});

describe('단계 진행', () => {
  it('중간 단계의 finish는 완료로 받아들이지 않는다', async () => {
    const result = await runSkill(
      wipSkill(),
      { line: '7라인', hold_hours: 24 },
      {
        llm: scriptedLlm([{ tool: 'finish', args: { summary: '다음 단계로 진행합니다' } }]),
        browser: await JsdomBrowser.open('/wip.html'),
        ui,
        files: memoryFiles(),
      },
    );
    expect(result.status).toBe('aborted');
    expect(result.lastStep).toBe(2); // 1단계(화면 열기)는 검사가 이미 충족돼 자동으로 넘어간다
  });

  it('같은 페이지를 다시 추출하면 데이터셋에 붙이지 않는다', async () => {
    const browser = await JsdomBrowser.open('/wip.html');
    const events: RunEvent[] = [];
    const step = (tool: string, args: object = {}) => ({ tool, args });
    await runSkill(
      wipSkill(),
      { line: '7라인', hold_hours: 24 },
      {
        llm: scriptedLlm([
          step('select', { ref: '라인', value: '7라인' }),
          step('click', { ref: '조회' }),
          step('extract_table', { ref: '재공 목록', dataset: 'wip', append: true }),
          step('extract_table', { ref: '재공 목록', dataset: 'wip', append: true }),
          step('abort', { reason: '끝' }),
        ]),
        browser,
        ui,
        files: memoryFiles(),
        onEvent: (e) => events.push(e),
      },
    );
    const results = events.flatMap((e) => (e.type === 'action' ? [e.entry] : []));
    expect(results.map((r) => r.ok)).toEqual([true, true, true, false, true]);
    expect(results[2].result).toContain('누적 50행');
    expect(results[3].result).toContain('내용이 같아');
  });
});
