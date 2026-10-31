import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * 스킬 목록에서 무엇을 보이고 쓸지 (~/.dogent/skill-prefs.json). 앱의 "스킬 관리"와 terminal의 skills on/off가 쓴다.
 *
 * - off: 끈 스킬. 목록에 보이지 않고, 말로 한 요청을 스킬로 고를 때 후보에서 빠진다 (run <ID>로 직접 부르면 돈다)
 * - pinned: 왼쪽 목록 위에 고정한 스킬
 * - samples: 목업 사이트용 예시 스킬(localhost만 다루는 것)을 보일지. 정하지 않았으면 빌드에 예시를 넣었을 때만 보인다
 */
export interface SkillPrefs {
  off: string[];
  pinned: string[];
  samples?: boolean;
}

const fileOf = (home: string) => join(home, 'skill-prefs.json');

export function loadSkillPrefs(home: string): SkillPrefs {
  try {
    const raw = existsSync(fileOf(home)) ? (JSON.parse(readFileSync(fileOf(home), 'utf8')) as Partial<SkillPrefs>) : {};
    const ids = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
    return { off: ids(raw.off), pinned: ids(raw.pinned), ...(typeof raw.samples === 'boolean' ? { samples: raw.samples } : {}) };
  } catch {
    return { off: [], pinned: [] };
  }
}

export function saveSkillPrefs(home: string, prefs: SkillPrefs): void {
  mkdirSync(home, { recursive: true });
  writeFileSync(fileOf(home), `${JSON.stringify(prefs, null, 2)}\n`);
}

export type SkillPrefPatch = { id: string; off?: boolean; pinned?: boolean } | { samples: boolean };

/** 한 가지를 바꿔 저장하고 바뀐 설정을 돌려준다 */
export function patchSkillPrefs(home: string, patch: SkillPrefPatch): SkillPrefs {
  const prefs = loadSkillPrefs(home);
  if ('samples' in patch) prefs.samples = patch.samples;
  else {
    const flip = (list: string[], on: boolean | undefined) => (on === undefined ? list : on ? [...new Set([...list, patch.id])] : list.filter((x) => x !== patch.id));
    prefs.off = flip(prefs.off, patch.off);
    prefs.pinned = flip(prefs.pinned, patch.pinned);
  }
  saveSkillPrefs(home, prefs);
  return prefs;
}
