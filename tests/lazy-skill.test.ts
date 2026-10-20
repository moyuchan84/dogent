import { describe, expect, it } from 'vitest';
import { TWO_STAGE_MIN, outlineSteps, parseSkill, planRequest, runSkill, type ChatMessage, type RunEvent } from '../src/core';
import { JsdomBrowser, memoryFiles, mockLlm, wipSkill } from './helpers';

const ui = { ask: async () => '', approve: async () => false };

const BODY = `## 단계

1. navigate {"url": "http://localhost/wip.html"}
   - 확인: 화면에 "재공" 글자가 있다
2. 라인을 고르고 조회한다
   - select {"ref": 1, "value": "{line}"}
3. 결과를 보고한다

## 예외

- 화면이 없으면 abort로 알린다.

## 결과

조회 결과.
`;

describe('단계 개요 (outlineSteps)', () => {
  it('각 단계의 첫 줄만 남기고 지금 단계를 표시한다', () => {
    const out = outlineSteps(BODY, 2);
    expect(out).toContain('1. navigate {"url": "http://localhost/wip.html"}');
    expect(out).toContain('2. 라인을 고르고 조회한다  ← 지금 할 단계');
    expect(out).not.toContain('select {"ref": 1');
    expect(out).not.toContain('확인: 화면에');
  });

  it('단계 절 밖(예외, 결과)은 그대로 둔다', () => {
    const out = outlineSteps(BODY, 1);
    expect(out).toContain('## 예외\n\n- 화면이 없으면 abort로 알린다.');
    expect(out).toContain('## 결과\n\n조회 결과.');
  });

  it('긴 첫 줄은 자른다', () => {
    const out = outlineSteps(`## 단계\n\n1. ${'가'.repeat(200)}\n`, 1);
    expect(out.split('\n').find((l) => l.startsWith('1.'))!.length).toBeLessThan(100);
  });

  it('단계 절이 없으면 원문 그대로', () => {
    expect(outlineSteps('본문만', 1)).toBe('본문만');
  });
});

describe('실행 중 프롬프트', () => {
  it('차례마다 모델에 보낸 글자 수를 llm_usage로 남긴다', async () => {
    const events: RunEvent[] = [];
    const browser = await JsdomBrowser.open('/wip.html');
    const sent: ChatMessage[][] = [];
    await runSkill(wipSkill(), { line: '8라인' }, {
      llm: { complete: (m, s) => (sent.push(m), mockLlm.complete(m, s)) },
      browser,
      ui,
      files: memoryFiles(),
      onEvent: (e) => events.push(e),
    });
    const usage = events.filter((e): e is Extract<RunEvent, { type: 'llm_usage' }> => e.type === 'llm_usage');
    expect(usage.length).toBe(sent.length);
    expect(usage[0].systemChars).toBeGreaterThan(1000);
    expect(usage[0].userChars).toBeGreaterThan(0);
  });

  it('다른 단계의 인자는 보내지 않고 지금 단계는 전문으로 보낸다', async () => {
    const skill = parseSkill(`---
id: t
name: 시험
description: 시험
version: 0.1.0
owner: 시험
risk: R1
domains: ["localhost"]
---

${BODY}`);
    const sent: ChatMessage[][] = [];
    const browser = await JsdomBrowser.open('/wip.html');
    await runSkill(skill, {}, {
      llm: { complete: async (m) => (sent.push(m), '{"thought":"끝","tool":"abort","args":{"reason":"시험"}}') },
      browser,
      ui,
      files: memoryFiles(),
      direct: false,
    });
    const first = sent[0][1].content;
    expect(first).toContain('## 지금 할 단계 (1/3)');
    expect(first).toContain('2. 라인을 고르고 조회한다');
    expect(first).not.toContain('select {"ref": 1');
  });
});

describe('계획 2단계', () => {
  const many = (n: number) =>
    Array.from({ length: n }, (_, i) =>
      parseSkill(`---
id: s${i}
name: 스킬${i}
description: 설명${i}
version: 0.1.0
owner: 시험
risk: R1
domains: ["localhost"]
inputs:
  - name: key${i}
    label: 키${i}
    type: string
    description: 값 설명${i}
---

## 단계

1. 한다
`),
    );

  it('후보가 많으면 먼저 이름·설명만 보내 고르고, 고른 스킬의 입력만 보내 값을 뽑는다', async () => {
    const calls: string[] = [];
    const replies = ['{"skill_id":"s3","reason":"맞음"}', '{"skill_id":"s3","inputs":{"key3":"abc"},"reason":"값"}'];
    const llm = { complete: async (m: ChatMessage[]) => (calls.push(m.map((x) => x.content).join('\n')), replies[calls.length - 1]) };
    const plan = await planRequest('스킬3 해줘', many(TWO_STAGE_MIN + 2), llm);
    expect(plan).toMatchObject({ skill_id: 's3', inputs: { key3: 'abc' } });
    expect(calls).toHaveLength(2);
    expect(calls[0]).toContain('s0: 스킬0 — 설명0');
    expect(calls[0]).not.toContain('값 설명');
    expect(calls[1]).toContain('값 설명3');
    expect(calls[1]).not.toContain('스킬4');
  });

  it('1단계에서 없는 스킬을 고르거나 null이면 2단계 없이 null', async () => {
    for (const reply of ['{"skill_id":"zzz"}', '{"skill_id":null,"reason":"없음"}']) {
      let n = 0;
      const plan = await planRequest('아무거나', many(TWO_STAGE_MIN + 1), { complete: async () => (n++, reply) });
      expect(plan.skill_id).toBeNull();
      expect(n).toBe(1);
    }
  });

  it('후보가 적으면 지금처럼 한 번만 부른다', async () => {
    let n = 0;
    await planRequest('x', many(TWO_STAGE_MIN), { complete: async () => (n++, '{"skill_id":null}') });
    expect(n).toBe(1);
  });
});
