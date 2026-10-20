import { shortlistSkills, docOfSkill } from './catalog';
import { resolveInputs, type Skill, type SkillInputs } from './skill';
import type { RunResult, SkillCatalogPort } from './types';

/** 부모 기록에 남기는 자식 결과의 최대 글자 수 */
export const CHILD_RESULT_MAX = 1500;
/** 모델에게 보여 주는 부를 수 있는 스킬의 최대 개수 */
export const CHILD_LIST_MAX = 8;

/** 자식은 부모가 허용한 호스트 안에서만 움직인다. child 패턴 하나가 parent 패턴들에 들어가는지 본다. */
function patternCovered(child: string, parent: string[]): boolean {
  const hostname = child.split(':')[0];
  return parent.some((p) => {
    if (p === child) return true;
    if (p.startsWith('*.')) return hostname.endsWith(p.slice(1));
    // 포트 없이 적은 부모 패턴은 그 호스트의 모든 포트를 뜻한다 (policy.hostAllowed와 같다)
    return !p.includes(':') && !child.startsWith('*.') && hostname === p;
  });
}

export const coversDomains = (parent: string[], child: string[]) => child.every((c) => patternCovered(c, parent));

/** 부모가 run_skill로 부를 수 있는 스킬인가. 아니면 이유를 돌려준다. */
export function whyNotCallable(parent: Skill, child: Skill): string | null {
  if (child.id === parent.id) return '자기 자신은 부를 수 없습니다';
  if (child.inputs.some((i) => i.type === 'file')) return '파일을 입력으로 받는 스킬은 부를 수 없습니다';
  if (child.risk === 'R3' && parent.risk !== 'R3') {
    return `${child.id}는 저장·상신 스킬(R3)인데 이 실행은 저장·상신이 허용되지 않았습니다 (--allow-write)`;
  }
  if (!coversDomains(parent.domains, child.domains)) {
    return `${child.id}의 도메인(${child.domains.join(', ')})이 이 실행의 허용 도메인(${parent.domains.join(', ')}) 밖입니다`;
  }
  return null;
}

export interface ChildContext {
  parent: Skill;
  depth: number;
  catalog?: SkillCatalogPort;
  /** 부모가 쓸 수 있는 남은 동작 수와 시간 */
  stepsLeft: number;
  msLeft: number;
}

export type Prepared = { ok: true; skill: Skill; inputs: SkillInputs } | { ok: false; reason: string };

/**
 * run_skill을 실행하기 전에 자식이 부모보다 넓어지지 않는지 본다 (docs/13 3절의 안전 규칙).
 * 통과하면 입력값을 검증하고 부모의 남은 예산을 넘지 않도록 줄인 스킬을 돌려준다.
 */
export function prepareChild(args: { id: string; inputs: Record<string, unknown> }, ctx: ChildContext): Prepared {
  if (ctx.depth >= 1) return { ok: false, reason: '다른 스킬이 부른 스킬 안에서는 또 다른 스킬을 부를 수 없습니다' };
  if (!ctx.catalog) return { ok: false, reason: '이 실행에서는 다른 스킬을 부를 수 없습니다' };
  const child = ctx.catalog.get(args.id);
  if (!child) {
    const known = callable(ctx.parent, ctx.catalog).map((s) => s.id).join(', ') || '(없음)';
    return { ok: false, reason: `스킬 "${args.id}"이(가) 없습니다. 부를 수 있는 스킬: ${known}` };
  }
  const why = whyNotCallable(ctx.parent, child);
  if (why) return { ok: false, reason: why };
  if (ctx.stepsLeft <= 0) return { ok: false, reason: '남은 동작 수가 없어 다른 스킬을 부를 수 없습니다' };
  if (ctx.msLeft <= 0) return { ok: false, reason: '남은 시간이 없어 다른 스킬을 부를 수 없습니다' };
  const { values, errors } = resolveInputs(child, args.inputs);
  if (errors.length > 0) return { ok: false, reason: `${child.id}의 입력값 오류: ${errors.join(' / ')}` };
  const limits = {
    ...child.limits,
    max_steps: Math.min(child.limits.max_steps, ctx.stepsLeft),
    timeout_sec: Math.max(1, Math.min(child.limits.timeout_sec, Math.floor(ctx.msLeft / 1000))),
  };
  return { ok: true, skill: { ...child, limits }, inputs: values };
}

/** 이 부모가 부를 수 있는 스킬들 */
export const callable = (parent: Skill, catalog: SkillCatalogPort): Skill[] =>
  catalog.list().filter((s) => whyNotCallable(parent, s) === null);

/** 모델에게 보여 줄 스킬: 부를 수 있는 것 중 요청과 말이 맞는 것 위주로 CHILD_LIST_MAX개 */
export function listForPrompt(parent: Skill, catalog: SkillCatalogPort, request: string): Skill[] {
  return shortlistSkills(callable(parent, catalog), docOfSkill, request, { limit: CHILD_LIST_MAX });
}

/** 시스템 프롬프트에 덧붙이는 하위 스킬 안내. 부를 수 있는 스킬이 없으면 빈 글. */
export function subagentPrompt(skills: Skill[]): string {
  if (skills.length === 0) return '';
  const lines = skills.map((s) => {
    const args = s.inputs.map((i) => `"${i.name}${i.required && i.default === undefined ? '*' : ''}"`).join(', ');
    return `- ${s.id}: ${s.name} — ${s.description} {${args}}`;
  });
  return `

다른 스킬 부르기
- run_skill {"id", "inputs"}: 이미 만들어진 스킬 하나를 따로 실행하고 결과 요약만 받습니다. 그 스킬이 만든 데이터셋은 이 실행의 데이터셋에 담깁니다. 스킬이 하는 일은 직접 화면을 조작하지 말고 이 도구로 맡깁니다.
- id는 아래 목록의 것만, inputs의 이름은 {} 안의 것만 씁니다. * 는 필수입니다. 값은 요청에 쓰인 표현 그대로 씁니다.
- 한 번에 하나씩 부르고, 결과를 본 뒤 다음 일을 합니다.

${lines.join('\n')}`;
}

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max)}…` : text);

/** 자식 실행 결과를 부모 기록에 남길 짧은 글로 만든다. 화면 조작 내용은 담지 않는다. */
export function summarizeChild(child: Skill, result: RunResult, renamed: string[] = []): string {
  const parts = [`${child.name}(${child.id}) ${result.status}: ${result.message}`];
  const datasets = result.datasets.map((d) => `${d.name}(${d.rowCount}행)`);
  if (datasets.length > 0) parts.push(`데이터셋: ${datasets.join(', ')}`);
  if (renamed.length > 0) parts.push(`이름이 겹쳐 바꿈: ${renamed.join(', ')}`);
  if (result.files.length > 0) parts.push(`저장한 파일: ${result.files.join(', ')}`);
  const outputs = Object.entries(result.outputs);
  if (outputs.length > 0) parts.push(`기록: ${outputs.map(([k, v]) => `${k}=${clip(v, 200)}`).join(' / ')}`);
  return clip(parts.join('\n'), CHILD_RESULT_MAX);
}
