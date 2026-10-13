import { describe, expect, it } from 'vitest';
import { buildFreeSkill, runSkill, type ApprovalRequest, type RunEvent } from '../src/core';
import { JsdomBrowser, memoryFiles, mockLlm, scriptedLlm } from './helpers';

const PAGE = 'http://localhost:4173/wip.html';

function approver(answer: boolean) {
  const requests: ApprovalRequest[] = [];
  return {
    requests,
    ask: async () => '',
    approve: async (r: ApprovalRequest) => {
      requests.push(r);
      return answer;
    },
  };
}

const step = (tool: string, args: object = {}) => ({ tool, args });

describe('자유 요청 스킬', () => {
  it('현재 사이트만 허용 도메인으로 하고, 쓰기 허용 여부가 위험 등급이 된다', () => {
    const readOnly = buildFreeSkill('https://mes.fab.internal:8443/wip?x=1', false);
    expect(readOnly.domains).toEqual(['mes.fab.internal:8443']);
    expect(readOnly.risk).toBe('R1');
    expect(readOnly.steps).toHaveLength(1);
    expect(buildFreeSkill(PAGE, true).risk).toBe('R3');
  });

  it('웹 페이지가 아닌 탭에서는 만들 수 없다', () => {
    expect(() => buildFreeSkill('chrome://extensions/', false)).toThrow('조작할 수 없는 페이지');
    expect(() => buildFreeSkill('', false)).toThrow('조작할 수 없는 페이지');
  });
});

describe('자유 요청 실행 (모의 화면 + 모의 모델)', () => {
  it('스킬 없이 화면을 조작하고 결과를 보고한다', async () => {
    const browser = await JsdomBrowser.open('/wip.html');
    const result = await runSkill(
      buildFreeSkill(PAGE, false),
      { request: '8라인을 선택하고 조회해서 총 몇 건인지 알려줘' },
      { llm: mockLlm, browser, ui: approver(true), files: memoryFiles() },
    );
    expect(result.status, result.message).toBe('done');
    expect(result.message).toBe('조회 결과는 총 173건입니다.');
    expect((browser.document.getElementById('line') as HTMLSelectElement).value).toBe('8라인');
  });

  it('쓰기를 허용하지 않으면 저장 계열 버튼을 누를 수 없다', async () => {
    const browser = await JsdomBrowser.open('/wip.html');
    const ui = approver(true);
    const events: RunEvent[] = [];
    await runSkill(
      buildFreeSkill(PAGE, false),
      { request: '지금 조건을 저장해줘' },
      { llm: mockLlm, browser, ui, files: memoryFiles(), onEvent: (e) => events.push(e) },
    );
    expect(events.filter((e) => e.type === 'blocked').length).toBeGreaterThan(0);
    expect(ui.requests).toEqual([]);
    expect(browser.document.getElementById('msg')!.textContent).toBe('');
  });

  it('쓰기를 허용해도 승인을 받아야 누르고, 한 번만 누른다', async () => {
    const browser = await JsdomBrowser.open('/wip.html');
    const ui = approver(true);
    const events: RunEvent[] = [];
    const result = await runSkill(
      buildFreeSkill(PAGE, true),
      { request: '지금 조건을 저장해줘' },
      {
        llm: scriptedLlm([
          step('click', { ref: '조건 저장' }),
          step('click', { ref: '조건 저장' }),
          step('finish', { summary: '저장했습니다' }),
        ]),
        browser,
        ui,
        files: memoryFiles(),
        onEvent: (e) => events.push(e),
      },
    );
    const actions = events.flatMap((e) => (e.type === 'action' ? [e.entry] : []));
    expect(ui.requests).toHaveLength(1);
    expect(ui.requests[0].button).toBe('조건 저장');
    expect(actions.map((a) => a.ok)).toEqual([true, false, true]);
    expect(actions[1].result).toContain('이미 "조건 저장"을(를) 눌렀습니다');
    expect(browser.document.getElementById('msg')!.textContent).toBe('조회 조건을 저장했습니다.');
    expect(result.status).toBe('done');
  });

  it('승인하지 않으면 누르지 않는다', async () => {
    const browser = await JsdomBrowser.open('/wip.html');
    const result = await runSkill(
      buildFreeSkill(PAGE, true),
      { request: '지금 조건을 저장해줘' },
      { llm: mockLlm, browser, ui: approver(false), files: memoryFiles() },
    );
    expect(result.status).toBe('aborted');
    expect(browser.document.getElementById('msg')!.textContent).toBe('');
  });

  it('열려 있는 사이트 밖으로는 이동하지 않는다', async () => {
    const browser = await JsdomBrowser.open('/wip.html');
    const events: RunEvent[] = [];
    await runSkill(
      buildFreeSkill(PAGE, true),
      { request: '외부 사이트 열어줘' },
      {
        llm: scriptedLlm([step('navigate', { url: 'https://example.com/' }), step('abort', { reason: '끝' })]),
        browser,
        ui: approver(true),
        files: memoryFiles(),
        onEvent: (e) => events.push(e),
      },
    );
    expect(events.filter((e) => e.type === 'blocked')).toHaveLength(1);
    expect(browser.dom.window.location.href).toBe(PAGE);
  });
});
