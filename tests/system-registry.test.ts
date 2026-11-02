import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { lintSystem, lintSystemSet, parseSystem } from '../src/core';
import { loadRegistry } from '../tools/systems-registry';
import { SystemsMcp } from '../tools/systems-mcp-core';

const doc = (over: Record<string, string> = {}, body = '- 메모') => {
  const meta: Record<string, string> = {
    id: 'gsams',
    name: 'GSAMS',
    description: 'IP 방화벽 정책을 신청하는 사내 시스템',
    aliases: '[GSAMS, 방화벽 신청]',
    url: 'https://gsams.samsungds.net/',
    domains: '[gsams.samsungds.net]',
    owner: '정보보안',
    screens: '\n  - name: IP 방화벽 신청\n    path: 신청 > 방화벽\n    url: https://gsams.samsungds.net/fw',
    terms: '\n  출발지: 접속을 시작하는 IP',
    ...over,
  };
  return `---\n${Object.entries(meta)
    .filter(([, v]) => v !== '')
    .map(([k, v]) => `${k}: ${v}`)
    .join('\n')}\n---\n${body}\n`;
};

describe('시스템 문서 검사 (lintSystem)', () => {
  it('잘 쓴 문서는 오류도 경고도 없고, 기본 상태는 verified', () => {
    const r = lintSystem(doc(), { folder: 'gsams' });
    expect(r.errors).toEqual([]);
    expect(r.warnings).toEqual([]);
    expect(r.system?.status).toBe('verified');
  });

  it('폴더 이름과 id가 다르면 오류', () => {
    expect(lintSystem(doc(), { folder: 'gsam' }).errors[0]).toMatch(/폴더 이름\(gsam\)과 id\(gsams\)/);
  });

  it('url이나 화면 주소가 domains 밖이면 오류', () => {
    expect(lintSystem(doc({ url: 'https://other.net/' })).errors[0]).toMatch(/domains/);
    const screens = '\n  - name: 신청\n    url: https://evil.example/fw';
    expect(lintSystem(doc({ screens })).errors[0]).toMatch(/화면 "신청"의 url.*domains 밖/);
  });

  it('같은 화면이 두 번이면 오류', () => {
    expect(lintSystem(doc({ screens: '\n  - name: 신청\n  - name: 신 청' })).errors[0]).toMatch(/두 번/);
  });

  it('검증 전(draft)과 채우지 않은 틀 칸은 경고', () => {
    const r = lintSystem(doc({ status: 'draft', owner: '(담당 부서)', screens: '\n  - name: 신청\n    path: (메뉴 경로)' }));
    expect(r.errors).toEqual([]);
    expect(r.warnings.join('\n')).toMatch(/채우지 않은 칸.*owner.*화면 "신청"/);
    expect(r.warnings.join('\n')).toMatch(/검증 전/);
  });

  it('updated는 YYYY-MM-DD (YAML이 날짜로 읽어도 같은 글자로)', () => {
    expect(parseSystem(doc({ updated: '2026-11-02' })).updated).toBe('2026-11-02');
    expect(lintSystem(doc({ updated: '11월 2일' })).errors[0]).toMatch(/YYYY-MM-DD/);
  });

  it('잘못된 상태 값은 오류', () => {
    expect(lintSystem(doc({ status: 'ok' })).errors[0]).toMatch(/status/);
  });
});

describe('사전 전체 검사 (lintSystemSet)', () => {
  const sys = (over: Record<string, string>) => parseSystem(doc(over));
  it('같은 id, 다른 시스템과 겹치는 이름·별칭은 오류 · 같은 사이트는 경고', () => {
    const out = lintSystemSet([
      { file: 'a', system: sys({}) },
      { file: 'b', system: sys({}) },
      { file: 'c', system: sys({ id: 'fw', name: '방화벽', aliases: '[방화벽 신청]' }) },
    ]);
    expect(out.find((p) => p.file === 'b' && /id "gsams"/.test(p.message))?.level).toBe('error');
    expect(out.find((p) => p.file === 'c' && /방화벽신청/.test(p.message))?.level).toBe('error');
    expect(out.find((p) => p.file === 'c' && /사이트/.test(p.message))?.level).toBe('warn');
  });
});

function repo(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'dogent-systems-'));
  for (const [id, src] of Object.entries(files)) {
    mkdirSync(join(root, 'systems', id), { recursive: true });
    writeFileSync(join(root, 'systems', id, 'SYSTEM.md'), src);
  }
  return root;
}

describe('사전 저장소 읽기 (loadRegistry)', () => {
  it('오류 있는 파일과 _틀 폴더는 빼고, 이름이 겹치면 뒤의 것을 뺀다', () => {
    const root = repo({
      gsams: doc(),
      _template: doc({ id: '(영문)' }),
      broken: '본문만',
      zfw: doc({ id: 'zfw', name: '방화벽', aliases: '[GSAMS]', url: 'https://fw.net/', domains: '[fw.net]', screens: '' }),
    });
    const reg = loadRegistry(root);
    expect(reg.systems.map((s) => s.system.id)).toEqual(['gsams']);
    expect(reg.problems.some((p) => p.file === 'systems/broken/SYSTEM.md' && p.level === 'error')).toBe(true);
    expect(reg.problems.some((p) => p.file === 'systems/zfw/SYSTEM.md' && /gsams/.test(p.message))).toBe(true);
    expect(reg.problems.some((p) => p.file.includes('_template'))).toBe(false);
    expect(reg.version).toMatch(/^[0-9a-f]{12}$/);
  });
});

describe('시스템 MCP 서버 (SystemsMcp)', () => {
  const call = (mcp: SystemsMcp, name: string, args: Record<string, unknown> = {}) => {
    const r = mcp.handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) as { result: { content: { text: string }[]; isError: boolean } };
    return { text: r.result.content[0].text, isError: r.result.isError };
  };

  it('initialize·tools/list에 답하고 알림에는 답하지 않는다', () => {
    const mcp = new SystemsMcp({ root: repo({ gsams: doc() }) });
    const init = mcp.handle({ jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: '2025-06-18' } }) as { result: { protocolVersion: string; serverInfo: { name: string } } };
    expect(init.result.protocolVersion).toBe('2025-06-18');
    expect(init.result.serverInfo.name).toBe('dogent-systems');
    expect(mcp.handle({ jsonrpc: '2.0', method: 'notifications/initialized' })).toBeNull();
    const list = mcp.handle({ jsonrpc: '2.0', id: 2, method: 'tools/list' }) as { result: { tools: { name: string }[] } };
    expect(list.result.tools.map((t) => t.name)).toEqual(['find_system', 'get_system', 'list_systems', 'report_issue']);
  });

  it('요청 문장으로 시스템을 찾고, 자세히 보고, 목록을 본다', () => {
    const mcp = new SystemsMcp({
      root: repo({ gsams: doc(), mes: doc({ id: 'mes', name: 'MES', aliases: '[재공 시스템]', url: 'https://mes.net/', domains: '[mes.net]', screens: '' }) }),
    });
    const found = JSON.parse(call(mcp, 'find_system', { query: 'GSAMS 들어가서 IP 방화벽 신청해 줘' }).text);
    expect(found.results[0]).toMatchObject({ id: 'gsams', url: 'https://gsams.samsungds.net/', status: 'verified' });
    const got = JSON.parse(call(mcp, 'get_system', { id: 'gsams' }).text);
    expect(got.system.screens[0].path).toBe('신청 > 방화벽');
    expect(got.prompt).toMatch(/### GSAMS/);
    const all = JSON.parse(call(mcp, 'list_systems').text);
    expect(all.count).toBe(2);
    expect(all.version).toBe(found.version);
    const missing = call(mcp, 'get_system', { id: 'gsam' });
    expect(missing.isError).toBe(true);
    expect(missing.text).toMatch(/비슷한 것: gsams/);
  });

  it('파일이 바뀌면 다시 읽어 판 번호가 바뀐다', async () => {
    const root = repo({ gsams: doc() });
    const mcp = new SystemsMcp({ root });
    const before = mcp.registry().version;
    writeFileSync(join(root, 'systems', 'gsams', 'SYSTEM.md'), doc({ description: 'IP 방화벽과 포트 정책을 신청하는 시스템' }));
    // 바뀐 것을 보는 간격(3초)을 기다리지 않게 시계를 앞당긴다
    (mcp as unknown as { checkedAt: number }).checkedAt = 0;
    (mcp as unknown as { stamp: string }).stamp = '';
    expect(mcp.registry().version).not.toBe(before);
  });

  it('신고는 --reports 파일에 한 줄씩 쌓인다', () => {
    const root = repo({ gsams: doc() });
    const file = join(root, 'out', 'issues.jsonl');
    const mcp = new SystemsMcp({ root, reportsFile: file });
    expect(call(mcp, 'report_issue', { id: 'gsams', problem: '주소가 /new 로 바뀜' }).text).toMatch(/남겼습니다/);
    expect(call(mcp, 'report_issue', { id: 'duo', problem: '사전에 없음' }).text).toMatch(/사전에 없는 시스템/);
    const rows = readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(rows.map((r) => [r.id, r.known])).toEqual([
      ['gsams', true],
      ['duo', false],
    ]);
    expect(call(new SystemsMcp({ root }), 'report_issue', { id: 'gsams', problem: 'x' }).isError).toBe(true);
  });
});
