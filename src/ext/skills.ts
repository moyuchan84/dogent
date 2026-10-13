import { parseSkill, type Skill } from '../core/skill';

// 스킬은 확장에 번들한다. skills/<id>/SKILL.md (와 선택적으로 policy.yaml)를 추가하면 다음 빌드에 포함된다.
const sources = import.meta.glob('/skills/*/SKILL.md', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;
const policies = import.meta.glob('/skills/*/policy.yaml', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;

export function loadBundledSkills(): { skills: Skill[]; errors: string[] } {
  const skills: Skill[] = [];
  const errors: string[] = [];
  for (const [path, source] of Object.entries(sources)) {
    try {
      skills.push(parseSkill(source, policies[path.replace(/SKILL\.md$/, 'policy.yaml')]));
    } catch (e) {
      errors.push(`${path}: ${(e as Error).message}`);
    }
  }
  return { skills, errors };
}
