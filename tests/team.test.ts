import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadSkills } from '../client/src/skills';
import { syncTeam, teamCacheDir, teamMeta, teamStale } from '../client/src/team';

const ROOT = join(import.meta.dirname, '..');
const sha = (t: string) => createHash('sha256').update(t.replace(/\r\n/g, '\n'), 'utf8').digest('hex');
const wip = readFileSync(join(ROOT, 'skills/wip-check/SKILL.md'), 'utf8');
const hold = readFileSync(join(ROOT, 'skills/hold-release/SKILL.md'), 'utf8');

/** 팀 저장소처럼 index.json과 스킬 파일을 내놓는 서버. 토큰을 요구한다 */
const files: Record<string, string> = {
  '/team/index.json': JSON.stringify({
    skills: [
      { id: 'wip-check', path: 'wip-check/SKILL.md', sha256: sha(wip) },
      { id: 'hold-release', path: 'hold-release/SKILL.md', sha256: '0'.repeat(64) }, // 해시가 다름 → 받지 않음
    ],
  }),
  '/team/wip-check/SKILL.md': wip,
  '/team/hold-release/SKILL.md': hold,
};
let server: Server;
let base = '';
const seen: (string | undefined)[] = [];

beforeAll(async () => {
  server = createServer((req, res) => {
    seen.push(req.headers.authorization);
    if (req.headers.authorization !== 'token abc') return void res.writeHead(401).end();
    const body = files[req.url ?? ''];
    if (body === undefined) return void res.writeHead(404).end();
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' }).end(body);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(() => server.close());

describe('팀 스킬 저장소를 주소로 받기', () => {
  it('목록의 스킬을 받아 두고, 해시가 다른 스킬은 받지 않는다. 받아 둔 스킬은 팀 스킬로 읽힌다', async () => {
    const home = mkdtempSync(join(tmpdir(), 'dogent-team-'));
    const meta = await syncTeam(home, `${base}/team/index.json`, { token: 'abc' });
    expect(meta.count).toBe(1);
    expect(meta.errors.join()).toContain('hold-release: hold-release/SKILL.md의 내용이 목록의 해시와 다릅니다');
    expect(seen.at(-1)).toBe('token abc');

    const { skills } = loadSkills({ personal: join(home, 'skills'), teamCache: teamCacheDir(home) }, {});
    expect(skills.map((s) => [s.skill.id, s.source])).toEqual([['wip-check', '팀']]);
    expect(teamStale(home, `${base}/team/index.json`, 60_000)).toBe(false);
    expect(teamStale(home, `${base}/other/index.json`, 60_000)).toBe(true); // 주소가 바뀜
    expect(teamStale(home, `${base}/team/index.json`, 60_000, Date.now() + 120_000)).toBe(true); // 오래됨
  });

  it('목록에 닿지 못하면 던지고, 받아 둔 것은 그대로 둔다', async () => {
    const home = mkdtempSync(join(tmpdir(), 'dogent-team-'));
    await syncTeam(home, `${base}/team/index.json`, { token: 'abc' });
    await expect(syncTeam(home, `${base}/team/index.json`, { token: 'wrong' })).rejects.toThrow('HTTP 401');
    expect(teamMeta(home)?.count).toBe(1);
    expect(loadSkills({ personal: join(home, 'skills'), teamCache: teamCacheDir(home) }, {}).skills).toHaveLength(1);
  });
});
