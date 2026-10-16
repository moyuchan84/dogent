import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseSkill, type Skill } from '../../src/core';

/**
 * 스킬을 세 군데서 읽는다 (docs/09 D8). 같은 id면 개인 > 팀 > 기본 순서로 앞의 것을 쓴다.
 * - 개인: ~/.dogent/skills/<id>/SKILL.md  (자유 요청을 저장한 것, 받은 것)
 * - 팀:   사내 GitHub Enterprise의 dogent-skills 저장소를 받아 둔 폴더 (skills/<id>/SKILL.md)
 * - 기본: 클라이언트에 넣은 것
 */
export type SkillSource = '개인' | '팀' | '기본';

export interface SkillEntry {
  skill: Skill;
  source: SkillSource;
  /** 파일에서 읽었으면 그 경로 */
  path?: string;
}

const ORDER: SkillSource[] = ['개인', '팀', '기본'];

/** 폴더 아래의 <id>/SKILL.md를 모두 읽는다. 팀 저장소처럼 skills/ 아래에 있으면 그쪽을 본다. */
function readFolder(dir: string): { path: string; source: string; policy?: string }[] {
  if (!existsSync(dir)) return [];
  const root = existsSync(join(dir, 'skills')) ? join(dir, 'skills') : dir;
  return readdirSync(root, { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(join(root, d.name, 'SKILL.md')))
    .map((d) => {
      const path = join(root, d.name, 'SKILL.md');
      const policyFile = join(root, d.name, 'policy.yaml');
      return { path, source: readFileSync(path, 'utf8'), ...(existsSync(policyFile) ? { policy: readFileSync(policyFile, 'utf8') } : {}) };
    });
}

export function loadSkills(dirs: { personal: string; team?: string }, bundled: Record<string, string> = {}): { skills: SkillEntry[]; errors: string[] } {
  const errors: string[] = [];
  const found: SkillEntry[] = [];
  const add = (source: SkillSource, files: { path: string; source: string; policy?: string }[], shown: (p: string) => string) => {
    for (const f of files) {
      try {
        found.push({ skill: parseSkill(f.source, f.policy), source, path: f.path });
      } catch (e) {
        errors.push(`${source} 스킬 ${shown(f.path)}: ${(e as Error).message}`);
      }
    }
  };
  add('개인', readFolder(dirs.personal), (p) => p);
  if (dirs.team) add('팀', readFolder(dirs.team), (p) => p);
  const builtIn = Object.entries(bundled)
    .filter(([p]) => p.endsWith('SKILL.md'))
    .map(([p, source]) => ({ path: p, source, policy: bundled[p.replace(/SKILL\.md$/, 'policy.yaml')] }));
  add(
    '기본',
    builtIn.map((b) => ({ ...b, path: '' })),
    () => '(기본)',
  );

  // 같은 id는 앞의 출처만 남긴다.
  const byId = new Map<string, SkillEntry>();
  for (const e of [...found].sort((a, b) => ORDER.indexOf(a.source) - ORDER.indexOf(b.source))) {
    if (!byId.has(e.skill.id)) byId.set(e.skill.id, e);
  }
  return { skills: [...byId.values()].map((e) => (e.path ? e : { skill: e.skill, source: e.source })), errors };
}
