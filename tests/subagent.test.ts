import { describe, expect, it } from 'vitest';
import {
  DatasetStore,
  buildFreeSkill,
  coversDomains,
  lintSkill,
  parseSkill,
  prepareChild,
  runSkill,
  type ChatMessage,
  type LlmPort,
  type RunEvent,
  type Skill,
  type SkillCatalogPort,
} from '../src/core';
import { JsdomBrowser, fwSkill, memoryFiles, mockLlm, wipSkill } from './helpers';

const ui = { ask: async () => '', approve: async () => false };
const PAGE = 'http://localhost:4173/wip.html';

const catalog = (...skills: Skill[]): SkillCatalogPort => ({ list: () => skills, get: (id) => skills.find((s) => s.id === id) });

const call = (id: string, inputs: Record<string, unknown>) => ({ thought: '스킬로 맡김', tool: 'run_skill', args: { id, inputs } });
const finish = (summary: string) => ({ thought: '보고', tool: 'finish', args: { summary } });
const giveUp = { thought: '포기', tool: 'abort', args: { reason: '안 됨' } };

/**
 * 부모(자유 요청)는 준비한 답을 차례로 내고, 자식 스킬(wip-check)의 차례는 모의 모델이 맡는다.
 * 부모에게 간 메시지는 parent에 남는다.
 */
function router(parentReplies: object[]) {
  const parent: ChatMessage[][] = [];
  let i = 0;
  const llm: LlmPort = {
    complete: async (messages) => {
      if (messages[1]?.content.includes('## 스킬: 재공 확인')) return mockLlm.complete(messages);
      parent.push(messages);
      return JSON.stringify(parentReplies[Math.min(i++, parentReplies.length - 1)]);
    },
  };
  return { llm, parent };
}

describe('run_skill: 자유 요청이 다른 스킬을 따로 실행한다', () => {
  it('자식의 동작은 부모 기록에 섞이지 않고, 결과 요약과 데이터셋·파일만 돌아온다', async () => {
    const { llm, parent } = router([call('wip-check', { line: '8라인', hold_hours: 24 }), finish('재공 확인을 마쳤습니다. {rows.wip}행')]);
    const events: RunEvent[] = [];
    const files = memoryFiles();
    const browser = await JsdomBrowser.open('/wip.html');
    const result = await runSkill(
      buildFreeSkill(PAGE, false),
      { request: '8라인 재공을 확인해줘' },
      { llm, browser, ui, files, skills: catalog(wipSkill()), onEvent: (e) => events.push(e) },
    );

    expect(result.status, result.message).toBe('done');
    expect(result.files).toEqual(['재공확인_8라인.xlsx']);
    expect(files.saved.has('재공확인_8라인.xlsx')).toBe(true);
    expect(result.datasets.map((d) => d.name).sort()).toEqual(['by_step', 'hold', 'wip']);
    expect(result.message).toMatch(/^재공 확인을 마쳤습니다\. \d+행$/);

    // 부모의 동작은 run_skill, finish 둘뿐
    const tools = events.flatMap((e) => (e.type === 'action' ? [e.entry.tool] : []));
    expect(tools).toEqual(['run_skill', 'finish']);
    expect(events.filter((e) => e.type === 'sub_start')).toHaveLength(1);
    expect(events.filter((e) => e.type === 'sub_action').length).toBeGreaterThan(5);
    expect(events.filter((e) => e.type === 'end')).toHaveLength(1);

    // 부모 모델의 첫 차례에 부를 수 있는 스킬이 안내되고, 둘째 차례에는 자식의 화면 조작 없이 요약만 보인다
    expect(parent[0][0].content).toContain('run_skill {"id", "inputs"}');
    expect(parent[0][0].content).toContain('- wip-check: 재공 확인');
    const second = parent[1][1].content;
    expect(second).toContain('run_skill');
    expect(second).toContain('wip(');
    expect(second).not.toContain('extract_table');
  }, 30_000);

  it('저장·상신(R3) 스킬은 저장·상신이 허용되지 않은 실행에서 부를 수 없다', async () => {
    const { llm, parent } = router([call('firewall-request', {}), giveUp]);
    const result = await runSkill(
      buildFreeSkill(PAGE, false),
      { request: '방화벽 신청' },
      { llm, browser: await JsdomBrowser.open('/wip.html'), ui, files: memoryFiles(), skills: catalog(fwSkill()) },
    );
    expect(result.status).toBe('aborted');
    // 허용되지 않은 스킬은 모델에게 안내하지도 않는다
    expect(parent[0][0].content).not.toContain('- firewall-request');
    expect(parent[1][1].content).toContain('저장·상신 스킬(R3)');
  });

  it('부모의 허용 도메인 밖 스킬은 부를 수 없다', async () => {
    const { llm, parent } = router([call('wip-check', { line: '7라인' }), giveUp]);
    await runSkill(
      buildFreeSkill('https://other.example/page', false),
      { request: 'x' },
      { llm, browser: await JsdomBrowser.open('/wip.html'), ui, files: memoryFiles(), skills: catalog(wipSkill()) },
    );
    expect(parent[0][0].content).not.toContain('- wip-check');
    expect(parent[1][1].content).toContain('허용 도메인');
  });

  it('없는 스킬 이름이나 모자란 입력은 자식을 시작하지 않고 이유를 돌려준다', async () => {
    const { llm, parent } = router([call('nope', {}), call('wip-check', {}), giveUp]);
    const events: RunEvent[] = [];
    await runSkill(
      buildFreeSkill(PAGE, false),
      { request: 'x' },
      { llm, browser: await JsdomBrowser.open('/wip.html'), ui, files: memoryFiles(), skills: catalog(wipSkill()), onEvent: (e) => events.push(e) },
    );
    expect(parent[1][1].content).toContain('스킬 "nope"이(가) 없습니다. 부를 수 있는 스킬: wip-check');
    expect(parent[2][1].content).toContain('wip-check의 입력값 오류');
    expect(events.some((e) => e.type === 'sub_start')).toBe(false);
  });

  it('skills 통로가 없으면 쓸 수 없다', async () => {
    const { llm, parent } = router([call('wip-check', { line: '7라인' }), giveUp]);
    await runSkill(buildFreeSkill(PAGE, false), { request: 'x' }, { llm, browser: await JsdomBrowser.open('/wip.html'), ui, files: memoryFiles() });
    expect(parent[0][0].content).not.toContain('run_skill {"id"');
    expect(parent[1][1].content).toContain('이 실행에서는 다른 스킬을 부를 수 없습니다');
  });

  it('자식이 만든 데이터셋의 이름이 부모 것과 겹치면 부모 것을 지키고 바꿔 담는다', async () => {
    const { llm } = router([call('wip-check', { line: '8라인' }), finish('끝')]);
    const datasets = new DatasetStore();
    datasets.set('wip', ['원래'], [['값']]);
    const result = await runSkill(
      buildFreeSkill(PAGE, false),
      { request: 'x' },
      { llm, browser: await JsdomBrowser.open('/wip.html'), ui, files: memoryFiles(), skills: catalog(wipSkill()), datasets },
    );
    expect(result.status, result.message).toBe('done');
    expect(datasets.get('wip').columns).toEqual(['원래']);
    expect(datasets.get('wip_2').columns).toContain('Lot ID');
  }, 30_000);

  it('자식이 쓴 동작 수는 부모의 남은 동작 수를 넘을 수 없다', async () => {
    const { llm } = router([call('wip-check', { line: '8라인' }), finish('끝')]);
    const free = buildFreeSkill(PAGE, false);
    const tight = { ...free, limits: { ...free.limits, max_steps: 6 } };
    const result = await runSkill(
      tight,
      { request: 'x' },
      { llm, browser: await JsdomBrowser.open('/wip.html'), ui, files: memoryFiles(), skills: catalog(wipSkill()) },
    );
    // wip-check는 6동작 안에 끝나지 못해 중단되고, 그 실패가 부모에게 전해진다
    expect(result.status).not.toBe('done');
  }, 30_000);
});

describe('스킬 단계에서 직접 부르기', () => {
  const composite = () =>
    parseSkill(`---
id: composite
name: 재공 점검
description: 재공 확인을 부르고 보고한다
version: 0.1.0
owner: 시험
risk: R1
domains:
  - localhost:4173
inputs:
  - name: line
    label: 라인
    type: string
    required: true
---

## 단계

1. run_skill로 재공 확인 스킬을 부른다. args는 다음을 그대로 쓴다.
   \`{"id": "wip-check", "inputs": {"line": "{line}", "hold_hours": 24}}\`
   - 검사: dataset("hold")
2. finish로 보고한다. args는 다음을 그대로 쓴다.
   \`{"summary": "정체 Lot {rows.hold}건"}\`
`);

  it('모델 없이 스킬이 스킬을 부른다', async () => {
    let parentCalls = 0;
    const llm: LlmPort = {
      complete: async (m) => {
        if (m[1]?.content.includes('## 스킬: 재공 확인')) return mockLlm.complete(m);
        parentCalls++;
        throw new Error('부모는 모델을 부르면 안 됩니다');
      },
    };
    const result = await runSkill(
      composite(),
      { line: '8라인' },
      { llm, browser: await JsdomBrowser.open('/wip.html'), ui, files: memoryFiles(), skills: catalog(wipSkill()), direct: true },
    );
    expect(result.status, result.message).toBe('done');
    expect(result.message).toMatch(/^정체 Lot \d+건$/);
    expect(parentCalls).toBe(0);
  }, 30_000);

  it('lint가 run_skill 단계를 받아들이고, 그 뒤 데이터셋 사용을 막지 않는다', () => {
    const src = `---
id: c2
name: 시험
description: 시험
version: 0.1.0
owner: 시험
risk: R1
domains: ["localhost:4173"]
---

## 단계

1. run_skill로 부른다. args는 다음을 그대로 쓴다.
   \`{"id": "wip-check", "inputs": {"line": "7라인"}}\`
2. transform으로 가른다. args는 다음을 그대로 쓴다.
   \`{"source": "hold", "target": "top", "steps": [{"op": "limit", "n": 3}]}\`
3. finish로 보고한다. args는 다음을 그대로 쓴다.
   \`{"summary": "끝"}\`
`;
    const report = lintSkill(src);
    expect(report.findings.filter((f) => f.level === 'error'), JSON.stringify(report.findings)).toEqual([]);
  });
});

describe('prepareChild: 자식은 부모보다 넓어질 수 없다', () => {
  const ctx = (over: object = {}) => ({ parent: buildFreeSkill(PAGE, false), depth: 0, catalog: catalog(wipSkill()), stepsLeft: 20, msLeft: 100_000, ...over });
  const reason = (r: { ok: boolean }) => (r as unknown as { reason: string }).reason;

  it('자식 안에서는 다시 부를 수 없다', () => {
    const r = prepareChild({ id: 'wip-check', inputs: { line: '7라인' } }, ctx({ depth: 1 }));
    expect(r.ok).toBe(false);
    expect(reason(r)).toContain('또 다른 스킬을 부를 수 없습니다');
  });

  it('자기 자신은 부를 수 없다', () => {
    const r = prepareChild({ id: 'wip-check', inputs: { line: '7라인' } }, ctx({ parent: wipSkill() }));
    expect(reason(r)).toContain('자기 자신');
  });

  it('동작 수와 시간은 부모의 남은 값을 넘지 않게 줄인다', () => {
    const r = prepareChild({ id: 'wip-check', inputs: { line: '7라인' } }, ctx({ stepsLeft: 5, msLeft: 7_500 }));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.skill.limits).toMatchObject({ max_steps: 5, timeout_sec: 7 });
  });

  it('남은 동작이나 시간이 없으면 시작하지 않는다', () => {
    expect(prepareChild({ id: 'wip-check', inputs: { line: '7라인' } }, ctx({ stepsLeft: 0 })).ok).toBe(false);
    expect(prepareChild({ id: 'wip-check', inputs: { line: '7라인' } }, ctx({ msLeft: 0 })).ok).toBe(false);
  });

  it('도메인 포함 판정', () => {
    expect(coversDomains(['localhost:4173'], ['localhost:4173'])).toBe(true);
    expect(coversDomains(['localhost'], ['localhost:4173'])).toBe(true);
    expect(coversDomains(['localhost:4173'], ['localhost:9999'])).toBe(false);
    expect(coversDomains(['*.fab.internal'], ['mes.fab.internal:8443', '*.a.fab.internal'])).toBe(true);
    expect(coversDomains(['mes.fab.internal'], ['*.fab.internal'])).toBe(false);
    expect(coversDomains(['a.com'], ['a.com', 'b.com'])).toBe(false);
  });
});
