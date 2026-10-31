import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseMarkdown, parseSkill, resolveInputs, runSkill, type Skill } from '../src/core';
import { JsdomBrowser, memoryFiles, readWorkbook, scriptedLlm } from './helpers';

const skill = (id: string): Skill => parseSkill(readFileSync(join(import.meta.dirname, '../skills', id, 'SKILL.md'), 'utf8'));
const ui = { ask: async () => '', approve: async () => false };

describe('기본 스킬 (어느 사이트에서나)', () => {
  it('화면 요약: 화면 글을 읽고 모델이 정리한 요약을 그대로 보고한다', async () => {
    const browser = await JsdomBrowser.open('/wip.html');
    const s = skill('page-summary');
    const llm = scriptedLlm(['재공 현황 조회 화면입니다.']);
    const result = await runSkill(s, resolveInputs(s, {}).values, { llm, browser, ui, files: memoryFiles(), direct: true });
    expect(result.status, result.message).toBe('done');
    expect(result.message).toBe('재공 현황 조회 화면입니다.');
  });

  it('화면 표를 엑셀로: 모델이 고른 표를 끝 페이지까지 담아 엑셀로 저장한다', async () => {
    const browser = await JsdomBrowser.open('/wip.html');
    // 조회해야 표에 행이 나온다
    const snap0 = await browser.snapshot();
    const line = snap0.items.find((i) => i.kind === 'el' && i.name === '라인') as { ref: number };
    await browser.select(line.ref, '8라인');
    const query =snap0.items.find((i) => i.kind === 'el' && i.role === 'button' && i.name === '조회') as { ref: number };
    await browser.click(query.ref);
    const snap = await browser.snapshot();
    const grid = snap.items.find((i) => i.kind === 'el' && i.name === '재공 목록') as { ref: number };
    const next = snap.items.find((i) => i.kind === 'el' && i.role === 'button' && i.name === '다음') as { ref: number } | undefined;
    const s = skill('table-to-excel');
    const llm = scriptedLlm([{ thought: '재공 목록 표', tool: 'extract_table', args: { ref: grid.ref, dataset: 'table', ...(next ? { next_ref: next.ref } : {}) } }]);
    const files = memoryFiles();
    const result = await runSkill(s, resolveInputs(s, { filename: '재공' }).values, { llm, browser, ui, files, direct: true });
    expect(result.status, result.message).toBe('done');
    expect(result.message).toMatch(/^표 \*\*\d+행\*\*을 재공\.xlsx로 저장했습니다\.\n\n\| Lot ID \|/);
    // 보고에 표 앞부분이 마크다운 표로 들어간다
    const table = parseMarkdown(result.message).find((b) => b.type === 'table');
    expect(table?.type === 'table' && table.rows.length).toBe(20);
    expect(result.message).toMatch(/전체 \d+행 중 앞의 20행$/);
    const wb = await readWorkbook(files.saved.get('재공.xlsx')!);
    expect(wb['표'].length).toBeGreaterThan(1);
  });

  it('기본 스킬은 어느 사이트의 화면이든 자기 사이트로 본다', () => {
    for (const id of ['page-summary', 'table-to-excel', 'site-search', 'form-fill']) expect(skill(id).domains, id).toEqual(['*']);
  });
});
