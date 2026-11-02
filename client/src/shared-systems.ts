import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseSystem } from '../../src/core';

/**
 * 공용 시스템 사전(사내 서버의 시스템 MCP, templates/dogent-systems)을 받아 로컬 사전으로 쓴다.
 *
 *   ~/.dogent/systems-cache/systems/<id>/SYSTEM.md   받은 시스템 사전 (systems.ts가 '공용'으로 읽는다)
 *   ~/.dogent/systems-cache/meta.json                 받은 주소, 판 번호, 때, 받지 않은 항목
 *
 * 서버의 GET /systems.json 을 부른다. 판 번호를 ETag로 보내 바뀌지 않았으면 304로 끝낸다.
 * 서버에 닿지 않으면 마지막으로 받아 둔 것을 그대로 쓴다 (서버가 없어도 Dogent는 돈다).
 * team-cache와 따로 두는 것은 팀 스킬을 받을 때 그 폴더를 통째로 바꾸기 때문이다.
 */
export interface SharedMeta {
  url: string;
  /** 서버가 알려 준 판 번호 */
  version: string;
  at: string;
  count: number;
  /** 형식이 맞지 않아 받지 않은 항목 */
  errors: string[];
  /** 마지막 확인에서 서버 판이 그대로였는지 (받지 않고 끝냈는지) */
  unchanged?: boolean;
}

const MAX_BODY = 5_000_000;
const MAX_FILE = 200_000;

export const sharedCacheDir = (home: string) => join(home, 'systems-cache');

export function sharedMeta(home: string): SharedMeta | null {
  const file = join(sharedCacheDir(home), 'meta.json');
  try {
    return existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as SharedMeta) : null;
  } catch {
    return null;
  }
}

/**
 * 설정한 주소에서 받을 주소를 만든다. `dogent mcp add`에 쓰는 주소(…/mcp)나 서버 주소만 적어도 된다.
 *   http://서버:8787 · http://서버:8787/mcp · http://서버:8787/systems.json  →  http://서버:8787/systems.json
 */
export function systemsEndpoint(url: string): string {
  const u = new URL(url.trim());
  const path = u.pathname.replace(/\/+$/, '');
  u.pathname = path.endsWith('/systems.json') ? path : `${path.replace(/\/mcp$/, '')}/systems.json`;
  u.search = '';
  u.hash = '';
  return u.toString();
}

/** 받는다. 서버에 닿지 못하거나 응답이 이상하면 던지고, 받아 둔 것은 건드리지 않는다. */
export async function syncShared(home: string, url: string, opts: { token?: string; timeoutMs?: number } = {}): Promise<SharedMeta> {
  const endpoint = systemsEndpoint(url);
  const last = sharedMeta(home);
  const headers: Record<string, string> = {};
  if (opts.token) headers.authorization = /\s/.test(opts.token) ? opts.token : `Bearer ${opts.token}`;
  // 같은 주소에서 받은 것이 있으면 판 번호로 물어 본다
  if (last && last.url === url && existsSync(join(sharedCacheDir(home), 'systems'))) headers['if-none-match'] = `"${last.version}"`;

  const res = await fetch(endpoint, { headers, signal: AbortSignal.timeout(opts.timeoutMs ?? 10_000) });
  if (res.status === 304 && last) {
    const meta: SharedMeta = { ...last, url, at: new Date().toISOString(), unchanged: true };
    writeFileSync(join(sharedCacheDir(home), 'meta.json'), JSON.stringify(meta, null, 2));
    return meta;
  }
  if (!res.ok) throw new Error(res.status === 401 ? 'HTTP 401 (토큰이 필요하거나 틀렸습니다: dogent config systemsToken <토큰>)' : `HTTP ${res.status}`);
  const text = await res.text();
  if (text.length > MAX_BODY) throw new Error('응답이 너무 큽니다');
  let body: { version?: unknown; systems?: unknown };
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error('JSON이 아닙니다 (주소가 시스템 사전 서버인지 확인하세요)');
  }
  if (typeof body.version !== 'string' || !Array.isArray(body.systems)) throw new Error('시스템 사전 서버의 응답 형식이 아닙니다 (주소가 시스템 사전 서버인지 확인하세요)');

  const errors: string[] = [];
  const good: { id: string; source: string }[] = [];
  for (const item of body.systems as { id?: unknown; source?: unknown }[]) {
    const label = String(item?.id ?? '?');
    try {
      if (typeof item?.source !== 'string' || item.source.length > MAX_FILE) throw new Error('내용이 없거나 너무 큽니다');
      const system = parseSystem(item.source);
      if (system.id !== item.id) throw new Error(`id가 다릅니다 (${String(item.id)} ≠ ${system.id})`);
      good.push({ id: system.id, source: item.source });
    } catch (e) {
      errors.push(`${label}: ${(e as Error).message}`);
    }
  }

  // 다 만든 뒤에 바꿔 넣는다 (중간에 끊겨도 전에 받은 것이 남게)
  const dir = sharedCacheDir(home);
  const tmp = `${dir}.tmp`;
  rmSync(tmp, { recursive: true, force: true });
  for (const s of good) {
    mkdirSync(join(tmp, 'systems', s.id), { recursive: true });
    writeFileSync(join(tmp, 'systems', s.id, 'SYSTEM.md'), s.source);
  }
  mkdirSync(join(tmp, 'systems'), { recursive: true });
  const meta: SharedMeta = { url, version: body.version, at: new Date().toISOString(), count: good.length, errors };
  writeFileSync(join(tmp, 'meta.json'), JSON.stringify(meta, null, 2));
  rmSync(dir, { recursive: true, force: true });
  renameSync(tmp, dir);
  return meta;
}

/** 마지막으로 받은 지 maxAgeMs가 지났거나 주소가 바뀌었으면 받아야 한다 */
export function sharedStale(home: string, url: string, maxAgeMs: number, now = Date.now()): boolean {
  const meta = sharedMeta(home);
  return !meta || meta.url !== url || now - Date.parse(meta.at) > maxAgeMs;
}
