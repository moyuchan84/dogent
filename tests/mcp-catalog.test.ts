import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { catalogUrlFor, parseCatalog, describeCatalogServer } from '../src/core';
import { fetchCatalog, missingEnv, specOf } from '../client/src/mcp-catalog';
import { McpHub } from '../client/src/mcp-hub';

const ROOT = join(import.meta.dirname, '..');
const SKILLS = join(ROOT, 'templates/dogent-skills');
const SERVER = join(ROOT, 'templates/dogent-mcp/server.mjs');

const good = (o: object = {}) => ({
  id: 'mes-lots',
  name: 'MES',
  description: '조회',
  owner: '제조IT팀',
  requires_env: ['MES_TOKEN'],
  spec: { url: 'https://mes.example.corp/mcp', headers: { Authorization: 'Bearer ${MES_TOKEN}' } },
  ...o,
});

const cleanup: (() => void)[] = [];
afterEach(() => cleanup.splice(0).forEach((f) => f()));
const temp = () => {
  const d = mkdtempSync(join(tmpdir(), 'dogent-cat-'));
  cleanup.push(() => rmSync(d, { recursive: true, force: true }));
  return d;
};
const listen = (server: Server): Promise<string> =>
  new Promise((resolve) => {
    cleanup.push(() => (server.closeAllConnections(), server.close()));
    server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`));
  });

describe('카탈로그 읽기', () => {
  it('좋은 항목은 통과하고 기본값이 채워진다', () => {
    const { servers, errors } = parseCatalog({ servers: [good()] });
    expect(errors).toEqual([]);
    expect(servers[0]).toMatchObject({ id: 'mes-lots', writes: false });
  });
  it('토큰을 그대로 적으면 그 항목만 빠진다', () => {
    const { servers, errors } = parseCatalog({ servers: [good(), good({ id: 'bad', spec: { url: 'https://x.corp/mcp', headers: { Authorization: 'Bearer abc123' } } })] });
    expect(servers.map((s) => s.id)).toEqual(['mes-lots']);
    expect(errors.join()).toMatch(/bad.*환경변수/);
  });
  it('${변수}를 쓰면서 requires_env에 안 적으면 거절', () => {
    expect(parseCatalog({ servers: [good({ requires_env: [] })] }).errors.join()).toMatch(/requires_env/);
  });
  it('토큰이 필요한 서버가 http이면 거절 (localhost는 허용)', () => {
    expect(parseCatalog({ servers: [good({ spec: { url: 'http://mes.corp/mcp', headers: { Authorization: 'Bearer ${MES_TOKEN}' } } })] }).errors.join()).toMatch(/https/);
    expect(parseCatalog({ servers: [good({ spec: { url: 'http://127.0.0.1:8800/mcp', headers: { Authorization: 'Bearer ${MES_TOKEN}' } } })] }).errors).toEqual([]);
  });
  it('command와 url을 함께/둘 다 안 적으면 거절, id 중복도 거절', () => {
    expect(parseCatalog({ servers: [good({ spec: {} })] }).servers).toEqual([]);
    expect(parseCatalog({ servers: [good({ spec: { command: 'node', url: 'https://x.corp/mcp' } })] }).servers).toEqual([]);
    expect(parseCatalog({ servers: [good(), good()] }).errors.join()).toMatch(/겹칩니다/);
  });
  it('주소는 팀 스킬 목록 옆으로 정한다', () => {
    expect(catalogUrlFor('https://ghe.corp/raw/org/repo/main/skills/index.json')).toBe('https://ghe.corp/raw/org/repo/main/mcp/catalog.json');
    expect(catalogUrlFor('https://a/skills/index.json', 'https://b/c.json')).toBe('https://b/c.json');
    expect(catalogUrlFor(undefined)).toBeUndefined();
  });
  it('설치 준비와 한 줄 설명', () => {
    const s = parseCatalog({ servers: [good({ writes: true })] }).servers[0];
    expect(missingEnv(s, {})).toEqual(['MES_TOKEN']);
    expect(missingEnv(s, { MES_TOKEN: 'x' })).toEqual([]);
    expect(describeCatalogServer(s, true)).toContain('✔ mes-lots');
    expect(specOf(s).url).toBe('https://mes.example.corp/mcp');
  });
});

describe('카탈로그 받기 (로그인이 필요한 저장소)', () => {
  it('토큰을 Authorization으로 보내고 목록을 읽는다', async () => {
    let auth = '';
    const url = await listen(
      createServer((req, res) => {
        auth = req.headers.authorization ?? '';
        res.end(JSON.stringify({ servers: [good()] }));
      }),
    );
    const r = await fetchCatalog(`${url}/mcp/catalog.json`, { token: 'ghp_abc' });
    expect(auth).toBe('token ghp_abc');
    expect(r.servers).toHaveLength(1);
  });
  it('로그인 화면(HTML)이 오면 토큰 안내와 함께 실패', async () => {
    const url = await listen(createServer((_q, res) => res.end('<!DOCTYPE html><html>login</html>')));
    await expect(fetchCatalog(url)).rejects.toThrow(/토큰/);
  });
  it('401이면 토큰 안내', async () => {
    const url = await listen(createServer((_q, res) => ((res.statusCode = 401), res.end())));
    await expect(fetchCatalog(url)).rejects.toThrow(/401.*mcpCatalogToken/);
  });
});

describe('카탈로그 만들기 도구 (templates/dogent-skills/tools/mcp-index.mjs)', () => {
  const run = (dir: string, ...extra: string[]) => spawnSync(process.execPath, [join(SKILLS, 'tools/mcp-index.mjs'), dir, ...extra], { encoding: 'utf8' });
  it('예시 저장소의 카탈로그는 최신이고 클라이언트도 그대로 읽는다', () => {
    const dir = join(SKILLS, 'mcp');
    expect(run(dir, '--check').status).toBe(0);
    const { servers, errors } = parseCatalog(JSON.parse(readFileSync(join(dir, 'catalog.json'), 'utf8')));
    expect(errors).toEqual([]);
    expect(servers.map((s) => s.id)).toEqual(['mes-lots']);
  });
  it('server.json을 더하면 --check가 실패하고 다시 만들면 통과', () => {
    const dir = temp();
    cpSync(join(SKILLS, 'mcp'), dir, { recursive: true });
    mkdirSync(join(dir, 'hr-leave'));
    writeFileSync(join(dir, 'hr-leave/server.json'), JSON.stringify(good({ id: 'hr-leave', spec: { command: 'node', args: ['x.mjs'] }, requires_env: [] })));
    expect(run(dir, '--check').status).toBe(1);
    expect(run(dir).status).toBe(0);
    expect(run(dir, '--check').status).toBe(0);
  });
  it('폴더 이름과 id가 다르거나 토큰을 적으면 막는다', () => {
    const dir = temp();
    mkdirSync(join(dir, 'a'));
    writeFileSync(join(dir, 'a/server.json'), JSON.stringify(good({ id: 'b', spec: { url: 'https://x.corp/mcp', headers: { Authorization: 'Bearer secret' } } })));
    const r = run(dir);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/폴더 이름/);
    expect(r.stderr).toMatch(/환경변수/);
  });
});

describe('MCP 서버 템플릿 (templates/dogent-mcp/server.mjs)', () => {
  it('stdio: Dogent가 도구를 읽고 부른다. 바꾸는 도구는 ask', async () => {
    const hub = await McpHub.open({ servers: { demo: { command: process.execPath, args: [SERVER] } } });
    try {
      expect(hub.failed).toEqual([]);
      const perms = Object.fromEntries(hub.list().map((t) => [t.name, t.permission]));
      expect(Object.values(perms)).toContain('ask');
      const lot = hub.list().find((t) => t.name.endsWith('lot_list'))!;
      expect(lot.permission).toBe('allow');
      const r = await hub.call(lot.name, { line: '7라인' });
      expect(r.isError).toBe(false);
      expect(JSON.parse(r.text)[0]).toMatchObject({ lot: 'A1', line: '7라인' });
      const bad = await hub.call(lot.name, {});
      expect(bad.isError).toBe(true);
      expect(bad.text).toContain('line');
    } finally {
      await hub.close();
    }
  }, 20_000);

  it('HTTP: MCP_TOKEN이 맞아야 받고, 카탈로그 항목 그대로 연결된다', async () => {
    const port = 18000 + Math.floor(Math.random() * 1000);
    const child: ChildProcess = spawn(process.execPath, [SERVER, '--http', String(port)], { env: { ...process.env, MCP_TOKEN: 'secret-token-1234' }, stdio: ['ignore', 'pipe', 'pipe'] });
    cleanup.push(() => child.kill());
    await new Promise<void>((resolve, reject) => {
      child.stderr!.on('data', (d) => String(d).includes('MCP 서버') && resolve());
      child.on('error', reject);
      setTimeout(() => reject(new Error('서버가 뜨지 않았습니다')), 8000);
    });
    const denied = await fetch(`http://127.0.0.1:${port}/mcp`, { method: 'POST', body: '{}' });
    expect(denied.status).toBe(401);

    process.env.DEMO_MCP_TOKEN = 'secret-token-1234';
    cleanup.push(() => delete process.env.DEMO_MCP_TOKEN);
    const entry = parseCatalog({
      servers: [good({ id: 'demo', requires_env: ['DEMO_MCP_TOKEN'], spec: { url: `http://127.0.0.1:${port}/mcp`, transport: 'http', headers: { Authorization: 'Bearer ${DEMO_MCP_TOKEN}' } } })],
    }).servers[0];
    const hub = await McpHub.open({ servers: { demo: specOf(entry) } });
    try {
      expect(hub.failed).toEqual([]);
      const r = await hub.call(hub.list().find((t) => t.name.endsWith('echo'))!.name, { text: '안녕' });
      expect(r.text).toBe('안녕');
    } finally {
      await hub.close();
    }
  }, 30_000);
});
