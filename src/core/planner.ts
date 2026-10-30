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

/** 후보가 이보다 많으면 스킬 고르기와 값 뽑기를 나눠 묻는다 (입력 설명이 긴 프롬프트를 피하려고). */
export const TWO_STAGE_MIN = 8;

export const PICK_SYSTEM_PROMPT = `당신은 스킬 선택기입니다. 사용자의 요청에 맞는 스킬 하나를 목록에서 고릅니다.

JSON 객체 하나로만 답합니다.
{"skill_id": "<스킬 id 또는 null>", "reason": "<한 문장>"}

- 맞는 스킬이 없으면 skill_id를 null로 둡니다.
- 목록에 없는 id를 지어내지 않습니다.`;

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
  /** 요청에 나온 사내 시스템의 설명 (systems.ts describeSystem). 용어와 별칭을 이해하는 데 쓴다 */
  systemInfo?: string,
): Promise<Plan> {
  if (skills.length <= TWO_STAGE_MIN) return planOneShot(request, skills, llm, signal, systemInfo);
  // 1단계: 이름과 설명 한 줄씩만 보고 고른다. 2단계: 고른 스킬의 입력만 보고 값을 뽑는다.
  const choice = await pickSkill(request, skills, llm, signal, systemInfo);
  const one = skills.find((s) => s.id === choice.skill_id);
  if (!one) {
    return { skill_id: null, inputs: {}, reason: choice.skill_id ? `모델이 없는 스킬(${choice.skill_id})을 골랐습니다` : choice.reason };
  }
  return planOneShot(request, [one], llm, signal, systemInfo);
}

/** 스킬 색인(id: 이름 — 설명 한 줄씩)만 보여 주고 하나를 고르게 한다. 입력값은 뽑지 않는다. */
export async function pickSkill(
  request: string,
  skills: Skill[],
  llm: LlmPort,
  signal?: AbortSignal,
  systemInfo?: string,
): Promise<Pick<Plan, 'skill_id' | 'reason'>> {
  const index = skills.map((s) => `- ${s.id}: ${s.name} — ${s.description}`).join('\n');
  const note = systemInfo ? `## 사내 시스템 설명 (참고)\n${systemInfo}\n\n` : '';
  const picked = await llm.complete(
    [
      { role: 'system', content: PICK_SYSTEM_PROMPT },
      { role: 'user', content: `${note}## 스킬 목록\n${index}\n\n## 사용자 요청\n${request}` },
    ],
    signal,
  );
  const pickedJson = extractJson(picked);
  if (!pickedJson) throw new Error('모델이 스킬 선택 결과를 JSON으로 주지 않았습니다');
  return Plan.pick({ skill_id: true, reason: true }).parse(JSON.parse(pickedJson));
}

/** 후보 전부의 입력 설명까지 한 프롬프트에 넣고, 스킬 고르기와 값 뽑기를 한 번에 묻는다. */
export async function planOneShot(
  request: string,
  skills: Skill[],
  llm: LlmPort,
  signal?: AbortSignal,
  systemInfo?: string,
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
      { role: 'user', content: `${systemInfo ? `## 사내 시스템 설명 (참고)\n${systemInfo}\n\n` : ''}## 스킬 목록\n${catalog}\n\n## 사용자 요청\n${request}` },
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
