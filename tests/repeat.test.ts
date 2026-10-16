import { describe, expect, it } from 'vitest';
import { buildFreeSkill, draftSkill, parseSkill, runSkill, type AuthorStep } from '../src/core';
import { JsdomBrowser, memoryFiles, mockLlm, scriptedLlm } from './helpers';

const ui = { ask: async () => '', approve: async () => false };
const step = (tool: string, args: object = {}) => ({ thought: '', tool, args });
const rows = (b: JsdomBrowser) => b.document.querySelectorAll('#adjGrid tbody tr').length;

describe('같은 동작 되풀이', () => {
  it('녹화한 스킬에서 같은 버튼을 이어 누른 단계들은 끝까지 실행한다', async () => {
    const add: AuthorStep = { kind: 'click', role: 'button', name: '행 추가', dup: false };
    const { source } = draftSkill(
      { id: 'add-rows', name: '행 세 개 추가', description: '조정 화면에 빈 행 세 개를 더한다', owner: '생산관리' },
      { url: 'http://localhost:4173/adjust.html', heading: '재공 수량 조정' },
      [add, add, add],
    );
    const browser = await JsdomBrowser.open('/adjust.html');
    const before = rows(browser);
    const r = await runSkill(parseSkill(source), {}, { llm: mockLlm, browser, ui, files: memoryFiles(), direct: true });
    expect(r.status, r.message).toBe('done');
    expect(rows(browser)).toBe(before + 3);
  });

  it('모델이 같은 버튼을 여러 번 눌러도 화면이 바뀌고 있으면 막힌 것으로 보지 않는다', async () => {
    const browser = await JsdomBrowser.open('/adjust.html');
    const before = rows(browser);
    const llm = scriptedLlm([...Array(4).fill(step('click', { ref: '행 추가' })), step('finish', { summary: '행 네 개를 더했습니다' })]);
    const r = await runSkill(buildFreeSkill('http://localhost:4173/adjust.html', false), { request: '행을 네 개 추가해줘' }, { llm, browser, ui, files: memoryFiles() });
    expect(r.status, r.message).toBe('done');
    expect(rows(browser)).toBe(before + 4);
  });

  it('같은 동작을 세 번 했는데 화면이 그대로면 막힌 것으로 보고 멈춘다', async () => {
    const browser = await JsdomBrowser.open('/wip.html');
    const llm = scriptedLlm([...Array(6).fill(step('type', { ref: '제품코드', text: 'DR5' })), step('finish', { summary: 'x' })]);
    const r = await runSkill(buildFreeSkill('http://localhost:4173/wip.html', false), { request: '제품코드에 DR5 넣어줘' }, { llm, browser, ui, files: memoryFiles() });
    expect(r.status).toBe('aborted');
    expect(r.message).toMatch(/같은 동작\(type\)을 3번 했지만 화면이 바뀌지 않아 중단했습니다/);
    // 처음 한 번은 값이 바뀌었고, 그 뒤 세 번은 아무것도 바꾸지 못했다.
    expect(r.actions).toBe(4);
  });
});
