import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sharedCacheDir, sharedMeta, sharedStale, syncShared, systemsEndpoint } from '../client/src/shared-systems';
import { loadSystems } from '../client/src/systems';

const ROOT = join(import.meta.dirname, '..');
const sys = (id: string, extra = '') =>
  `---\nid: ${id}\nname: ${id.toUpperCase()}\ndescription: ${id} 시스템 설명 문장입니다\naliases: [${id}-별칭]\nurl: https://${id}.example.net/\nowner: 담당팀\nstatus: verified\n${extra}---\n\n- 주의사항\n`;

/** 시스템 사전 서버처럼 GET /systems.json을 내놓는다 (토큰, ETag) */
let server: Server;
let base = '';
let version = 'v1';
let systems: { id: string; source: string }[] = [];
const seen: { auth?: string; inm?: string }[] = [];

beforeAll(async () => {
  server = createServer((req, res) => {
    seen.push({ auth: req.headers.authorization, inm: req.headers['if-none-match'] as string | undefined });
    if (req.url !== '/systems.json') return void res.writeHead(404).end();
    if (req.headers.authorization !== 'Bearer tok') return void res.writeHead(401).end();
    if (req.headers['if-none-match'] === `"${version}"`) return void res.writeHead(304, { etag: `"${version}"` }).end();
    res.writeHead(200, { 'content-type': 'application/json', etag: `"${version}"` }).end(JSON.stringify({ version, count: systems.length, systems }));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(() => server.close());

describe('공용 시스템 사전 받기 (syncShared)', () => {
  it('주소는 서버 주소, mcp 주소, 전체 주소 어느 것이든 /systems.json 이 된다', () => {
    expect(systemsEndpoint('http://s:8787')).toBe('http://s:8787/systems.json');
    expect(systemsEndpoint('http://s:8787/')).toBe('http://s:8787/systems.json');
    expect(systemsEndpoint('http://s:8787/mcp')).toBe('http://s:8787/systems.json');
    expect(systemsEndpoint('http://s:8787/dict/mcp?x=1')).toBe('http://s:8787/dict/systems.json');
    expect(systemsEndpoint('http://s:8787/systems.json')).toBe('http://s:8787/systems.json');
  });

  it('받아 두고, 판이 같으면 304로 끝내고, 바뀌면 다시 받는다. 형식이 틀린 항목은 받지 않는다', async () => {
    const home = mkdtempSync(join(tmpdir(), 'dogent-shared-'));
    version = 'v1';
    systems = [{ id: 'gsams', source: sys('gsams') }, { id: 'bad', source: '---\nid: bad\n---\n' }, { id: 'mes', source: sys('other') }];
    const m1 = await syncShared(home, base, { token: 'tok' });
    expect(m1.count).toBe(1);
    expect(m1.version).toBe('v1');
    expect(m1.errors.map((e) => e.split(':')[0])).toEqual(['bad', 'mes']); // 형식 오류, id가 다름
    expect(seen.at(-1)).toEqual({ auth: 'Bearer tok', inm: undefined });
    expect(readFileSync(join(sharedCacheDir(home), 'systems/gsams/SYSTEM.md'), 'utf8')).toContain('GSAMS');

    const m2 = await syncShared(home, base, { token: 'tok' });
    expect(m2.unchanged).toBe(true);
    expect(m2.count).toBe(1);
    expect(seen.at(-1)?.inm).toBe('"v1"');
    expect(existsSyncGsams(home)).toBe(true);

    version = 'v2';
    systems = [{ id: 'gsams', source: sys('gsams') }, { id: 'mes', source: sys('mes') }];
    const m3 = await syncShared(home, base, { token: 'tok' });
    expect(m3.unchanged).toBeUndefined();
    expect(m3.count).toBe(2);
    expect(sharedMeta(home)?.version).toBe('v2');
  });

  it('토큰이 틀리거나 서버가 응답하지 않으면 던지고, 받아 둔 것은 그대로 둔다', async () => {
    const home = mkdtempSync(join(tmpdir(), 'dogent-shared-'));
    version = 'v1';
    systems = [{ id: 'gsams', source: sys('gsams') }];
    await syncShared(home, base, { token: 'tok' });
    await expect(syncShared(home, base, { token: 'wrong' })).rejects.toThrow('HTTP 401');
    await expect(syncShared(home, 'http://127.0.0.1:1', { token: 'tok', timeoutMs: 1500 })).rejects.toThrow();
    expect(sharedMeta(home)?.count).toBe(1);
    expect(existsSyncGsams(home)).toBe(true);
    // 서버 주소가 아닌 곳(JSON이 아님)이면 형식 오류
    const other = createServer((_q, r) => void r.writeHead(200).end('<html>로그인</html>'));
    await new Promise<void>((r) => other.listen(0, '127.0.0.1', r));
    try {
      const url = `http://127.0.0.1:${(other.address() as { port: number }).port}`;
      await expect(syncShared(home, url)).rejects.toThrow('JSON이 아닙니다');
    } finally {
      other.close();
    }
    expect(sharedMeta(home)?.count).toBe(1);
  });

  it('받은 지 오래됐거나 주소가 바뀌었으면 다시 받아야 한다', async () => {
    const home = mkdtempSync(join(tmpdir(), 'dogent-shared-'));
    expect(sharedStale(home, base, 60_000)).toBe(true); // 받은 적 없음
    version = 'v1';
    systems = [{ id: 'gsams', source: sys('gsams') }];
    await syncShared(home, base, { token: 'tok' });
    expect(sharedStale(home, base, 60_000)).toBe(false);
    expect(sharedStale(home, `${base}/other`, 60_000)).toBe(true);
    expect(sharedStale(home, base, 60_000, Date.now() + 120_000)).toBe(true);
  });
});

describe('로컬 사전과 합치기', () => {
  it('같은 id는 개인 > 공용 > 팀 > 기본 순서로 앞의 것을 쓴다', async () => {
    const home = mkdtempSync(join(tmpdir(), 'dogent-shared-'));
    version = 'v1';
    systems = [{ id: 'gsams', source: sys('gsams', 'login: 공용 사전의 로그인\n') }, { id: 'only-shared', source: sys('only-shared') }];
    await syncShared(home, base, { token: 'tok' });

    const mk = (dir: string, id: string, login: string) => {
      const d = join(dir, 'systems', id);
      mkdirSync(d, { recursive: true });
      writeFileSync(join(d, 'SYSTEM.md'), sys(id, `login: ${login}\n`));
    };
    const team = join(home, 'team');
    const personal = join(home, 'skills');
    mk(team, 'gsams', '팀');
    mk(team, 'team-only', '팀');
    mk(personal, 'only-shared', '개인');

    const r = loadSystems({ personal, team, shared: sharedCacheDir(home) }, {});
    const by = Object.fromEntries(r.systems.map((e) => [e.system.id, [e.source, e.system.login]]));
    expect(by['gsams']).toEqual(['공용', '공용 사전의 로그인']);
    expect(by['only-shared']).toEqual(['개인', '개인']);
    expect(by['team-only']).toEqual(['팀', '팀']);
    expect(r.errors).toEqual([]);
  });
});

function existsSyncGsams(home: string) {
  return existsSync(join(sharedCacheDir(home), 'systems/gsams/SYSTEM.md'));
}

/** 실제 서버(묶인 systems-mcp.mjs)를 띄워 클라이언트가 받아 가는지 */
describe('실제 시스템 사전 서버와 연결', () => {
  let proc: ChildProcess;
  let url = '';

  beforeAll(async () => {
    const port = 20000 + Math.floor(Math.random() * 20000);
    url = `http://127.0.0.1:${port}`;
    proc = spawn(process.execPath, [join(ROOT, 'templates/dogent-systems/tools/systems-mcp.mjs'), '--root', join(ROOT, 'templates/dogent-systems'), '--port', String(port)], {
      env: { ...process.env, SYSTEMS_MCP_TOKEN: 'real-token' },
      stdio: 'ignore',
      windowsHide: true,
    });
    for (let i = 0; i < 60; i++) {
      try {
        if ((await fetch(`${url}/health`)).ok) return;
      } catch {
        // 아직 안 떴다
      }
      await new Promise((r) => setTimeout(r, 250));
    }
    throw new Error('시스템 사전 서버가 뜨지 않았습니다');
  }, 120_000);
  afterAll(() => proc?.kill());

  it('토큰이 없으면 거절하고, 있으면 사전을 받아 두고, 다음에는 바뀐 것 없음으로 끝난다', async () => {
    const home = mkdtempSync(join(tmpdir(), 'dogent-shared-real-'));
    await expect(syncShared(home, `${url}/mcp`)).rejects.toThrow('HTTP 401');
    const m1 = await syncShared(home, `${url}/mcp`, { token: 'real-token' });
    expect(m1.count).toBeGreaterThanOrEqual(1);
    expect(m1.errors).toEqual([]);
    const loaded = loadSystems({ personal: join(home, 'skills'), shared: sharedCacheDir(home) }, {});
    expect(loaded.systems.map((e) => [e.system.id, e.source])).toContainEqual(['gsams', '공용']);
    const m2 = await syncShared(home, `${url}/mcp`, { token: 'real-token' });
    expect(m2.unchanged).toBe(true);
    expect(m2.version).toBe(m1.version);
  });
});
