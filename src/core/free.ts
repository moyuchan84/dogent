import { parseSkill, type Skill } from './skill';

export const FREE_SKILL_ID = 'free';

/**
 * 스킬 없이 현재 화면을 자유롭게 조작하는 요청용 스킬을 만든다.
 *
 * 절차가 정해진 스킬과 달리 단계가 하나뿐이고 검사 식이 없어서, 무엇을 누를지와 언제 끝낼지를
 * 모두 모델이 판단한다. 대신 통제는 그대로 적용된다.
 * - 지금 열려 있는 사이트 밖으로는 나가지 않는다.
 * - allowWrite가 꺼져 있으면 저장·상신 계열 버튼을 누를 수 없다.
 * - 켜져 있어도 누르기 전에 사용자 승인을 받고, 한 번의 실행에서 한 번만 누른다.
 */
export function buildFreeSkill(pageUrl: string, allowWrite: boolean, systemInfo?: string): Skill {
  let host: string;
  try {
    const url = new URL(pageUrl);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error();
    host = url.host;
  } catch {
    throw new Error('현재 탭은 조작할 수 없는 페이지입니다. 업무 화면이 열린 탭에서 실행해 주세요');
  }
  return parseSkill(`---
id: ${FREE_SKILL_ID}
name: 자유 요청
description: 스킬 없이 현재 화면에서 요청한 일을 수행한다
version: 0.1.0
owner: 사용자
risk: ${allowWrite ? 'R3' : 'R1'}
domains:
  - ${JSON.stringify(host)}
inputs:
  - name: request
    label: 요청
    type: text
    required: true
submit_steps: [1]
limits:
  max_steps: 25
  timeout_sec: 300
---

## 단계

1. 현재 화면에서 다음 요청을 수행한다: {request}
   - 화면을 보고 필요한 동작을 한 번에 하나씩 한다. 이미 되어 있는 일은 다시 하지 않는다.
   - 요청한 일을 모두 했으면 finish로 끝낸다. summary에는 무엇을 했는지와, 요청이 물어본 내용에 대해 화면에 보이는 답을 적는다.
   - 화면에 이미 답이 보이는 질문이면 아무것도 조작하지 않고 finish로 답한다.

## 예외

- 요청이 모호해서 무엇을 할지 정할 수 없으면 ask_user로 묻는다.
- 요청한 일을 이 화면에서 할 수 없으면 abort로 이유를 알린다.
- 요청에 없는 저장, 삭제, 상신은 하지 않는다.

## 결과

한 일과, 요청이 물어본 내용에 대한 답.
${systemInfo ? `
## 시스템 정보

사내 시스템 사전의 설명입니다. 화면을 찾고 용어를 이해하는 데만 쓰고, 요청에 없는 일은 하지 않습니다.

${systemInfo}
` : ''}`);
}
