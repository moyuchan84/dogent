import { parseSkill, type Skill } from '../core/skill';

// Phase 1은 스킬을 확장에 번들한다. skills/<id>/SKILL.md 를 추가하면 다음 빌드에 포함된다.
const sources = import.meta.glob('/skills/*/SKILL.md', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;

export function loadBundledSkills(): { skills: Skill[]; errors: string[] } {
  const skills: Skill[] = [];
  const errors: string[] = [];
  for (const [path, source] of Object.entries(sources)) {
    try {
      skills.push(parseSkill(source));
    } catch (e) {
      errors.push(`${path}: ${(e as Error).message}`);
    }
  }
  return { skills, errors };
}
