import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadSkills } from '../client/src/skills';

const read = (p: string) => readFileSync(join(import.meta.dirname, '..', p), 'utf8');
const bundled = { 'wip-check/SKILL.md': read('samples/skills/wip-check/SKILL.md'), 'wip-search/SKILL.md': read('samples/skills/wip-search/SKILL.md') };

function put(dir: string, id: string, name: string) {
  mkdirSync(join(dir, id), { recursive: true });
  writeFileSync(join(dir, id, 'SKILL.md'), read('samples/skills/wip-check/SKILL.md').replace('id: wip-check', `id: ${id}`).replace(/^name: .*$/m, `name: ${name}`));
}

describe('클라이언트 스킬 폴더 (개인 > 팀 > 기본)', () => {
  it('같은 id는 개인, 팀, 기본 순서로 앞의 것을 쓰고, 팀 저장소는 skills/ 아래를 읽는다', () => {
    const root = mkdtempSync(join(tmpdir(), 'dogent-skills-'));
    const personal = join(root, 'personal');
    const team = join(root, 'team');
    put(personal, 'wip-check', '개인 재공 확인');
    put(join(team, 'skills'), 'wip-check', '팀 재공 확인');
    put(join(team, 'skills'), 'team-only', '팀 스킬');
    mkdirSync(join(personal, 'broken'), { recursive: true });
    writeFileSync(join(personal, 'broken', 'SKILL.md'), '---\nid: broken\n---\n');

    const { skills, errors } = loadSkills({ personal, team }, bundled);
    const by = Object.fromEntries(skills.map((e) => [e.skill.id, `${e.source}:${e.skill.name}`]));
    expect(by).toEqual({
      'wip-check': '개인:개인 재공 확인',
      'team-only': '팀:팀 스킬',
      'wip-search': '기본:재공 검색 정리',
    });
    expect(errors.join('\n')).toMatch(/개인 스킬 .*broken/);
  });

  it('폴더가 없으면 기본 스킬만 쓴다', () => {
    const { skills, errors } = loadSkills({ personal: join(tmpdir(), 'dogent-none-xyz') }, bundled);
    expect(skills.map((e) => e.source)).toEqual(['기본', '기본']);
    expect(errors).toEqual([]);
  });
});
