import { z } from 'zod';
import { extractJson } from './actions';
import type { Skill } from './skill';
import type { LlmPort } from './types';

export const PLANNER_SYSTEM_PROMPT = `당신은 스킬 선택기입니다. 사용자의 요청에 맞는 스킬 하나를 고르고, 요청에서 읽을 수 있는 입력값을 뽑습니다.

JSON 객체 하나로만 답합니다.
{"skill_id": "<스킬 id 또는 null>", "inputs": {"<입력 이름>": <값>}, "reason": "<한 문장>"}

- 맞는 스킬이 없으면 skill_id를 null로 둡니다.
- 요청에 없는 입력값은 넣지 않습니다. 추측하지 않습니다.
- 입력값은 사용자가 쓴 표현을 단위까지 그대로 씁니다. 예: "7라인 재공"이면 "7라인" (숫자 7만 쓰지 않습니다).
- 입력의 설명을 보고 요청의 어느 부분이 그 값인지 고릅니다. 예: 설명이 "검색창에 넣을 값"이면 "P8-DR5 검색해서 정리해줘"에서 "P8-DR5".
- 선택값(enum)은 보기 중 하나를 그대로 씁니다.`;

const Plan = z.object({
  skill_id: z.string().nullable(),
  inputs: z.record(z.string(), z.union([z.string(), z.number()])).default({}),
  reason: z.string().default(''),
});
export type Plan = z.infer<typeof Plan>;

/** 자연어 요청을 스킬과 입력값으로 바꾼다. 실행은 하지 않는다. */
export async function planRequest(
  request: string,
  skills: Skill[],
  llm: LlmPort,
  signal?: AbortSignal,
): Promise<Plan> {
  const catalog = skills
    .map((s) => {
      const inputs = s.inputs
        .filter((i) => i.type !== 'file')
        .map((i) => {
          const notes = [
            i.type,
            ...(i.required ? ['필수'] : []),
            ...(i.default !== undefined ? [`기본값 ${i.default}`] : []),
            ...(i.type === 'enum' && i.values ? [`보기: ${i.values.join(' | ')}`] : []),
          ].join(', ');
          return `    - ${i.name} (${i.label ?? i.name}, ${notes})${i.description ? `: ${i.description}` : ''}`;
        })
        .join('\n');
      return `- ${s.id}: ${s.name} — ${s.description}\n  입력:\n${inputs || '    (없음)'}`;
    })
    .join('\n');
  const text = await llm.complete(
    [
      { role: 'system', content: PLANNER_SYSTEM_PROMPT },
      { role: 'user', content: `## 스킬 목록\n${catalog}\n\n## 사용자 요청\n${request}` },
    ],
    signal,
  );
  const json = extractJson(text);
  if (!json) throw new Error('모델이 스킬 선택 결과를 JSON으로 주지 않았습니다');
  const plan = Plan.parse(JSON.parse(json));
  if (plan.skill_id && !skills.some((s) => s.id === plan.skill_id)) {
    return { ...plan, skill_id: null, reason: `모델이 없는 스킬(${plan.skill_id})을 골랐습니다` };
  }
  return plan;
}
