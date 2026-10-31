import { parseSkill, type Skill } from '../core/skill';

// 스킬은 확장에 번들한다. skills/<id>/SKILL.md (와 선택적으로 policy.yaml)를 추가하면 다음 빌드에 포함된다.
// 목업 사이트 전용 예시(samples/skills)는 빌드 환경 파일에 WXT_SAMPLE_SKILLS=true 일 때만 넣는다.
const sources = import.meta.glob('/skills/*/SKILL.md', { query: '?raw', import: 'default', eager: true }) as Record<string, string>;
const policies = import.meta.glob('/skills/*/policy.yaml', { query: '?raw', import: 'default', eager: true }) as Record<string, string>;
// 빌드할 때 값이 정해지는 비교라 꺼져 있으면 예시 파일이 번들에서 빠진다
const withSamples = import.meta.env.WXT_SAMPLE_SKILLS === 'true';
const sampleSources = withSamples ? (import.meta.glob('/samples/skills/*/SKILL.md', { query: '?raw', import: 'default', eager: true }) as Record<string, string>) : {};
const samplePolicies = withSamples ? (import.meta.glob('/samples/skills/*/policy.yaml', { query: '?raw', import: 'default', eager: true }) as Record<string, string>) : {};

export function loadBundledSkills(): { skills: Skill[]; errors: string[] } {
  const skills: Skill[] = [];
  const errors: string[] = [];
  const all = { ...sources, ...sampleSources };
  const pol = { ...policies, ...samplePolicies };
  for (const [path, source] of Object.entries(all)) {
    try {
      skills.push(parseSkill(source, pol[path.replace(/SKILL\.md$/, 'policy.yaml')]));
    } catch (e) {
      errors.push(`${path}: ${(e as Error).message}`);
    }
  }
  return { skills, errors };
}
