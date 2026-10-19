import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { syncSkills } from '../../src/core';

/**
 * 팀 스킬 저장소를 주소(index.json)로 받는다. git을 설치하거나 clone하지 않아도 된다 (확장의 "공유 스킬 저장소"와 같은 목록).
 *
 *   ~/.dogent/team-cache/<id>/SKILL.md, policy.yaml   받은 스킬 (loadSkills가 팀 스킬로 읽는다)
 *   ~/.dogent/team-cache/meta.json                    받은 주소, 때, 받지 못한 스킬
 *
 * 목록에 적힌 파일만, 해시가 맞고 품질 검사 오류가 없는 것만 받는다 (src/core/shared.ts).
 * 닿지 않으면 마지막으로 받아 둔 것을 그대로 쓴다.
 */
export interface TeamMeta {
  url: string;
  at: string;
  count: number;
  errors: string[];
}

export const teamCacheDir = (home: string) => join(home, 'team-cache');

export function teamMeta(home: string): TeamMeta | null {
  const file = join(teamCacheDir(home), 'meta.json');
  try {
    return existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as TeamMeta) : null;
  } catch {
    return null;
  }
}

/**
 * 받아 온다. token을 주면 Authorization 헤더로 보낸다 (사내 GitHub의 비공개 저장소 raw 주소 등).
 * 목록을 읽지 못하면 던지고, 받아 둔 것은 건드리지 않는다.
 */
export async function syncTeam(home: string, url: string, opts: { token?: string; timeoutMs?: number } = {}): Promise<TeamMeta> {
  const headers: Record<string, string> = opts.token ? { authorization: /\s/.test(opts.token) ? opts.token : `token ${opts.token}` } : {};
  const result = await syncSkills(url, {
    fetchText: async (u) => {
      const res = await fetch(u, { headers, signal: AbortSignal.timeout(opts.timeoutMs ?? 10_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.text();
    },
    sha256: async (text) => createHash('sha256').update(text, 'utf8').digest('hex'),
  });
  // 다 받은 뒤에 바꿔 넣는다 (중간에 끊겨도 전에 받은 것이 남게)
  const dir = teamCacheDir(home);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  for (const s of result.skills) {
    mkdirSync(join(dir, s.id), { recursive: true });
    writeFileSync(join(dir, s.id, 'SKILL.md'), s.source);
    if (s.policy) writeFileSync(join(dir, s.id, 'policy.yaml'), s.policy);
  }
  const meta: TeamMeta = { url, at: new Date().toISOString(), count: result.skills.length, errors: result.errors };
  writeFileSync(join(dir, 'meta.json'), JSON.stringify(meta, null, 2));
  return meta;
}

/** 마지막으로 받은 지 maxAgeMs가 지났거나 주소가 바뀌었으면 받아야 한다. */
export function teamStale(home: string, url: string, maxAgeMs: number, now = Date.now()): boolean {
  const meta = teamMeta(home);
  return !meta || meta.url !== url || now - Date.parse(meta.at) > maxAgeMs;
}
