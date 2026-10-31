import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { generateWip } from '../mock-site/data.mjs';
import { lintSkill, parseSkill, planRequest, resolveInputs, runSkill, type ChatMessage, type LlmPort } from '../src/core';
import { JsdomBrowser, memoryFiles, mockLlm, scriptedLlm, wipSkill } from './helpers';

const ui = { ask: async () => '', approve: async () => false };
const searchSkill = () => parseSkill(readFileSync(join(import.meta.dirname, '../samples/skills/wip-search/SKILL.md'), 'utf8'));

/** 모의 모델을 감싸 주고받은 메시지를 남긴다. */
function recording(inner: LlmPort = mockLlm) {
  const calls: ChatMessage[][] = [];
  return { calls, complete: (m: ChatMessage[], s?: AbortSignal) => (calls.push(m), inner.complete(m, s)) };
}

describe('유연한 스킬: 매개변수', () => {
  it('요청 해석에 입력의 설명과 기본값을 함께 준다', async () => {
    const llm = recording();
    await planRequest('DR5 검색해서 정리해줘', [searchSkill(), wipSkill()], llm);
    const catalog = llm.calls[0][1].content;
    expect(catalog).toContain('keyword (검색어, string, 필수): 제품코드 검색창에 넣을 값');
    expect(catalog).toContain('line (라인, string, 기본값 7라인)');
  });

  it('"○○ 검색해서 정리해줘"에서 스킬과 검색어를 고르고, 없는 값은 기본값으로 채운다', async () => {
    const skill = searchSkill();
    const plan = await planRequest('DR5 검색해서 수량이 많은 공정 위주로 정리해줘', [searchSkill(), wipSkill()], mockLlm);
    expect(plan).toMatchObject({ skill_id: 'wip-search', inputs: { keyword: 'DR5', focus: '수량이 많은 공정' } });
    const { values, errors } = resolveInputs(skill, plan.inputs);
    expect(errors).toEqual([]);
    expect(values).toEqual({ keyword: 'DR5', line: '7라인', focus: '수량이 많은 공정' });
  });
});

describe('유연한 스킬: 정리(summarize)', () => {
  it('검색하고 끝 페이지까지 읽어 집계한 뒤, 정리만 모델에 맡긴다', async () => {
    const llm = recording();
    const browser = await JsdomBrowser.open('/wip.html');
    const result = await runSkill(
      searchSkill(),
      { keyword: 'DR5', line: '7라인', focus: '수량이 많은 공정' },
      { llm, browser, ui, files: memoryFiles(), direct: true },
    );
    expect(result.status, result.message).toBe('done');
    const want = generateWip('7라인').filter((r) => r[1].includes('DR5'));
    expect(result.message).toContain(`'DR5' 검색 결과 ${want.length}건 (7라인).`);
    // 모델은 정리할 때 한 번만 불렸고, 받은 자료는 공정별 집계뿐이다 (원본 행은 보내지 않았다).
    expect(llm.calls).toHaveLength(1);
    const sent = llm.calls[0][1].content;
    expect(sent).toContain("'수량이 많은 공정'을(를) 중심으로");
    expect(sent).toContain('공정\tLot수\t수량합계\t최장정체');
    expect(sent).not.toContain(want[0][0]);
    expect(result.outputs.report).toMatch(/^기준: /);
    expect(result.message).toContain(result.outputs.report);
  });

  it('데이터셋을 정리할 때는 열 이름과 행을 표 형태로 보낸다', async () => {
    const llm = recording();
    const skill = parseSkill(`---
id: t
name: 시험
description: 시험
version: 0.1.0
owner: 시험
risk: R1
domains: [localhost:4173]
---

## 단계

1. navigate로 이동한다. \`{"url": "http://localhost:4173/wip.html"}\`
   - 검사: text("재공 현황 조회")
2. select로 고른다. \`{"ref": "라인", "value": "8라인"}\`
   - 검사: value("라인") == "8라인"
3. click으로 조회한다. \`{"ref": "조회"}\`
   - 검사: did("click") and text("총")
4. extract_table로 읽는다. \`{"ref": "재공 목록", "dataset": "wip", "next_ref": "다음"}\`
   - 검사: dataset("wip")
5. summarize로 정리한다. \`{"instruction": "요약", "source": "wip", "name": "s"}\`
   - 검사: did("summarize")
6. finish로 보고한다. \`{"summary": "{out.s}"}\`
`);
    const r = await runSkill(skill, {}, { llm, browser: await JsdomBrowser.open('/wip.html'), ui, files: memoryFiles(), direct: true });
    expect(r.status, r.message).toBe('done');
    const sent = llm.calls[0][1].content;
    expect(sent).toContain('데이터셋 "wip" (173행)');
    expect(sent).toContain('Lot ID\t제품\t공정\t수량\t상태\t정체시간');
    expect(sent.split('\n').filter((l) => /^P8-/.test(l))).toHaveLength(173);
  });
});

describe('유연한 스킬: 목표 단계', () => {
  const goalSkill = `---
id: goal
name: 목표 단계 시험
description: 목표만 적은 단계를 모델이 수행한다
version: 0.1.0
owner: 시험
risk: R1
domains: [localhost:4173]
---

## 단계

1. navigate로 재공 화면으로 간다. \`{"url": "http://localhost:4173/wip.html"}\`
   - 검사: text("재공 현황 조회")
2. 8라인을 골라 조회한 뒤, 결과 표의 모든 페이지를 데이터셋 wip에 담는다.
   - 검사: dataset("wip")
3. 결과를 공정별로 정리해 보고한다.

## 예외

- 결과가 없으면 abort한다.
`;

  it('품질 검사는 목표 단계를 감점하지 않고 안내만 한다', () => {
    const r = lintSkill(goalSkill);
    expect(r.findings.filter((f) => f.level !== 'info')).toEqual([]);
    expect(r.grade).toBe('A');
    expect(r.findings.map((f) => `${f.rule}:${f.step}`)).toEqual(['I01:2', 'I01:3']);
  });

  it('목표 단계는 모델이 화면을 보고 동작을 골라 수행하고, 마지막 목표 단계는 정리해 보고한다', async () => {
    const llm = scriptedLlm([
      { thought: '라인 선택', tool: 'select', args: { ref: '라인', value: '8라인' } },
      { thought: '조회', tool: 'click', args: { ref: '조회' } },
      { thought: '모든 페이지 읽기', tool: 'extract_table', args: { ref: '재공 목록', dataset: 'wip', next_ref: '다음' } },
      { thought: '정리', tool: 'summarize', args: { instruction: '공정별 정리', source: 'wip', name: 'report' } },
      '- PHOTO 40건\n- ETCH 30건',
      { thought: '보고', tool: 'finish', args: { summary: '8라인 {rows.wip}건.\n{out.report}' } },
    ]);
    const r = await runSkill(parseSkill(goalSkill), {}, { llm, browser: await JsdomBrowser.open('/wip.html'), ui, files: memoryFiles(), direct: true });
    expect(r.status, r.message).toBe('done');
    expect(r.message).toBe('8라인 173건.\n- PHOTO 40건\n- ETCH 30건');
    expect(r.datasets.find((d) => d.name === 'wip')?.rowCount).toBe(173);
  });

  it('summarize의 데이터셋은 앞 단계에서 만들어야 하고, 결과 이름은 뒤 단계에서 쓸 수 있다', () => {
    const base = (steps: string) =>
      lintSkill(`---\nid: t\nname: t\ndescription: t\nversion: 0.1.0\nowner: t\nrisk: R1\ndomains: [localhost:4173]\n---\n\n## 단계\n\n${steps}\n\n## 예외\n\n- 없음\n`);
    const missing = base('1. summarize로 정리한다. `{"instruction": "x", "source": "nope", "name": "a"}`\n   - 검사: did("summarize")\n2. finish로 보고한다. `{"summary": "{out.a}"}`');
    expect(missing.findings.map((f) => f.rule)).toContain('E05');
    const fine = base('1. summarize로 화면 글을 정리한다. `{"instruction": "x", "source": "page", "name": "a"}`\n   - 검사: did("summarize")\n2. finish로 보고한다. `{"summary": "{out.a}"}`');
    expect(fine.findings).toEqual([]);
  });
});

describe('화면 글 읽기', () => {
  it('read_text로 화면의 글을 읽어 모델이 볼 수 있다', async () => {
    const llm = scriptedLlm([
      { thought: '글 읽기', tool: 'read_text', args: {} },
      { thought: '보고', tool: 'finish', args: { summary: '읽음' } },
    ]);
    const skill = parseSkill(`---
id: r
name: 읽기
description: 읽기
version: 0.1.0
owner: t
risk: R1
domains: [localhost:4173]
---

## 단계

1. 화면의 글을 읽고 보고한다.
`);
    const events: string[] = [];
    const r = await runSkill(skill, {}, {
      llm,
      browser: await JsdomBrowser.open('/wip.html'),
      ui,
      files: memoryFiles(),
      onEvent: (e) => e.type === 'action' && events.push(e.entry.result),
    });
    expect(r.status, r.message).toBe('done');
    expect(events[0]).toContain('재공 현황 조회');
    expect(events[0]).toContain('제품코드');
  });
});
