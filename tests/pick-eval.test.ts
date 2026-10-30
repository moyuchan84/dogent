import { describe, expect, it } from 'vitest';
import { formatPickSummary, parsePickCases, runPickEval, summarizePick, type ChatMessage, type LlmPort } from '../src/core';
import { DEFAULT_PICK_CASES, DISTRACTOR_SKILLS } from '../tools/pick-cases';
import { fwSkill, holdSkill, mockLlm, wipSkill } from './helpers';

/** 스킬 고르기 질문만 받는 모델. 색인만 받았는지(입력 설명이 없는지)를 남긴다 */
function fixed(answer: (user: string) => object): LlmPort & { prompts: string[] } {
  const prompts: string[] = [];
  return {
    prompts,
    complete: async (m: ChatMessage[]) => (prompts.push(m[1].content), JSON.stringify(answer(m[1].content))),
  };
}

describe('스킬 고르기 시험', () => {
  it('방식마다 맞힘·입력값·글자 수를 잰다', async () => {
    const llm = fixed(() => ({ skill_id: 'wip-check', inputs: { line: '7라인' }, reason: '' }));
    const trials = await runPickEval({
      cases: [
        { request: '7라인 재공 확인해줘', expect: 'wip-check', inputs: { line: '7라인' } },
        { request: '3라인 재공', expect: 'wip-check', inputs: { line: '3라인' } },
        { request: '점심 메뉴', expect: null },
      ],
      skills: [wipSkill(), fwSkill()],
      llm,
    });
    expect(trials).toHaveLength(9);
    const index = trials.filter((t) => t.strategy === 'index');
    expect(index.map((t) => t.calls)).toEqual([2, 2, 2]);
    expect(index[1]).toMatchObject({ skillOk: true, inputsOk: false, wrongInputs: { line: ['3라인', '7라인'] } });
    expect(index[2]).toMatchObject({ skillOk: false, got: 'wip-check' });
    const row = summarizePick(trials).find((r) => r.strategy === 'index')!;
    expect(row).toMatchObject({ n: 3, none: 0, inputs: 0.5, errors: 0, calls: 2 });
    expect(row.skill).toBeCloseTo(2 / 3);
    expect(formatPickSummary(summarizePick(trials))[1]).toContain('기본 2개');
  });

  it('index 방식은 고를 때 입력 설명을 보이지 않는다', async () => {
    const llm = fixed(() => ({ skill_id: null, reason: '없음' }));
    await runPickEval({ cases: [{ request: '점심 메뉴', expect: null }], skills: [fwSkill()], llm, strategies: ['index', 'one-shot'] });
    expect(llm.prompts[0]).not.toContain('입력:');
    expect(llm.prompts[1]).toContain('입력:');
  });

  it('방해 스킬을 섞은 목록에서는 with_distractors를 정답으로 본다', async () => {
    const llm = fixed((u) => ({ skill_id: u.includes('hold-register') ? 'hold-register' : null, inputs: {}, reason: '' }));
    const trials = await runPickEval({
      cases: [{ request: 'LOT1 홀드 걸어줘', expect: null, with_distractors: 'hold-register' }],
      skills: [holdSkill()],
      llm,
      strategies: ['index'],
      distractors: DISTRACTOR_SKILLS,
    });
    expect(trials.map((t) => [t.distractors, t.catalog, t.skillOk])).toEqual([
      [false, 1, true],
      [true, 1 + DISTRACTOR_SKILLS.length, true],
    ]);
  });

  it('모델 답을 읽지 못하면 오류로 세고 다음 문항으로 간다', async () => {
    const llm: LlmPort = { complete: async () => '모르겠습니다' };
    const trials = await runPickEval({ cases: DEFAULT_PICK_CASES.slice(0, 2), skills: [wipSkill()], llm, strategies: ['current'] });
    expect(trials.every((t) => t.error && !t.skillOk)).toBe(true);
    expect(summarizePick(trials)[0].errors).toBe(1);
  });

  it('기본 문항은 모의 모델로 돌아간다', async () => {
    const trials = await runPickEval({ cases: DEFAULT_PICK_CASES, skills: [wipSkill(), fwSkill(), holdSkill()], llm: mockLlm, strategies: ['current'] });
    expect(trials.filter((t) => t.request === '7라인 재공 확인해줘')[0]).toMatchObject({ skillOk: true, inputsOk: true });
  });

  it('문항 파일 형식을 검사한다', () => {
    expect(parsePickCases('[{"request":"a","expect":null}]')).toEqual([{ request: 'a', expect: null }]);
    expect(() => parsePickCases('[{"request":"a"}]')).toThrow('1번 문항');
    expect(() => parsePickCases('{}')).toThrow('JSON 배열');
  });
});
