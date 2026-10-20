import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseSystem, type System } from '../../src/core';

/**
 * 시스템 사전을 스킬과 같은 세 군데서 읽는다. 같은 id면 개인 > 팀 > 기본.
 * 각 스킬 폴더 아래의 systems/<id>/SYSTEM.md가 한 시스템이다 (docs/05-skill-spec.md).
 */
export type SystemSource = '개인' | '팀' | '기본';

export interface SystemEntry {
  system: System;
  source: SystemSource;
  path?: string;
}

const ORDER: SystemSource[] = ['개인', '팀', '기본'];

/** 스킬 폴더(또는 팀 저장소 폴더)에서 systems/<id>/SYSTEM.md를 모두 읽는다 */
function readFolder(dir: string): { path: string; source: string }[] {
  const root = join(existsSync(join(dir, 'skills')) ? join(dir, 'skills') : dir, 'systems');
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(join(root, d.name, 'SYSTEM.md')))
    .map((d) => ({ path: join(root, d.name, 'SYSTEM.md'), source: readFileSync(join(root, d.name, 'SYSTEM.md'), 'utf8') }));
}

export function loadSystems(
  dirs: { personal: string; team?: string; teamCache?: string },
  bundled: Record<string, string> = {},
): { systems: SystemEntry[]; errors: string[] } {
  const errors: string[] = [];
  const found: SystemEntry[] = [];
  const add = (source: SystemSource, files: { path: string; source: string }[]) => {
    for (const f of files) {
      try {
        found.push({ system: parseSystem(f.source), source, ...(f.path ? { path: f.path } : {}) });
      } catch (e) {
        errors.push(`${source} 시스템 ${f.path || '(기본)'}: ${(e as Error).message}`);
      }
    }
  };
  add('개인', readFolder(dirs.personal));
  if (dirs.team) add('팀', readFolder(dirs.team));
  if (dirs.teamCache) add('팀', readFolder(dirs.teamCache));
  add(
    '기본',
    Object.entries(bundled)
      .filter(([p]) => p.endsWith('SYSTEM.md'))
      .map(([, source]) => ({ path: '', source })),
  );
  const byId = new Map<string, SystemEntry>();
  for (const e of [...found].sort((a, b) => ORDER.indexOf(a.source) - ORDER.indexOf(b.source))) {
    if (!byId.has(e.system.id)) byId.set(e.system.id, e);
  }
  return { systems: [...byId.values()], errors };
}
