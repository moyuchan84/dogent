import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseSkill, syncSkills, type SyncPorts } from '../src/core';

const ROOT = join(import.meta.dirname, '..');
const INDEX = 'https://files.example.internal/dogent-skills/index.json';
const read = (path: string) => readFileSync(join(ROOT, 'samples', 'skills', path), 'utf8').replace(/\r\n/g, '\n');
const sha256 = async (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');

/** 주소 → 내용으로 만든 가짜 저장소 */
function repo(files: Record<string, string>): SyncPorts & { asked: string[] } {
  const asked: string[] = [];
  return {
    asked,
    sha256,
    async fetchText(url) {
      asked.push(url);
      const path = url.replace('https://files.example.internal/dogent-skills/', '');
      if (!(path in files)) throw new Error('HTTP 404');
      return files[path];
    },
  };
}

const index = (skills: object[]) => JSON.stringify({ skills });

describe('공유 스킬 저장소', () => {
  it('목록에 적힌 스킬과 정책을 받아 검사한다', async () => {
    const fw = read('firewall-request/SKILL.md');
    const policy = read('firewall-request/policy.yaml');
    const wip = read('wip-check/SKILL.md');
    const ports = repo({
      'index.json': index([
        { id: 'firewall-request', path: 'firewall-request/SKILL.md', sha256: await sha256(fw), policy: 'firewall-request/policy.yaml', policy_sha256: await sha256(policy) },
        { id: 'wip-check', path: 'wip-check/SKILL.md' },
      ]),
      'firewall-request/SKILL.md': fw,
      'firewall-request/policy.yaml': policy,
      // 윈도우에서 올린 파일은 줄바꿈이 다르다.
      'wip-check/SKILL.md': wip.replace(/\n/g, '\r\n'),
    });
    const result = await syncSkills(INDEX, ports);
    expect(result.errors).toEqual([]);
    expect(result.skills.map((s) => [s.id, s.version])).toEqual([
      ['firewall-request', parseSkill(fw).version],
      ['wip-check', parseSkill(wip).version],
    ]);
    // 정책까지 함께 받아야 입력값 규칙이 적용된다.
    expect(parseSkill(result.skills[0].source, result.skills[0].policy).rules.length).toBeGreaterThan(0);
    expect(result.skills[1].source).toBe(wip);
  });

  it('해시가 다르거나, 오류가 있거나, id가 다른 스킬은 받지 않고 나머지는 받는다', async () => {
    const wip = read('wip-check/SKILL.md');
    const ports = repo({
      'index.json': index([
        { id: 'wip-check', path: 'wip-check/SKILL.md', sha256: await sha256(wip) },
        { id: 'tampered', path: 'tampered/SKILL.md', sha256: await sha256(wip) },
        { id: 'broken', path: 'broken/SKILL.md' },
        { id: 'renamed', path: 'renamed/SKILL.md' },
        { id: 'missing', path: 'missing/SKILL.md' },
        { id: 'wip-check', path: 'wip-check/SKILL.md' },
      ]),
      'wip-check/SKILL.md': wip,
      'tampered/SKILL.md': wip.replace('id: wip-check', 'id: tampered'),
      'broken/SKILL.md': '# 선언부가 없는 파일',
      'renamed/SKILL.md': wip,
    });
    const result = await syncSkills(INDEX, ports);
    expect(result.skills.map((s) => s.id)).toEqual(['wip-check']);
    expect(result.errors).toEqual([
      'tampered: tampered/SKILL.md의 내용이 목록의 해시와 다릅니다',
      expect.stringMatching(/^broken: .*선언부/),
      'renamed: 파일의 id는 "wip-check"입니다',
      'missing: HTTP 404',
      'wip-check: 목록에 같은 id가 두 번 있습니다',
    ]);
  });

  it('목록 밖의 서버나 상위 폴더를 가리키는 경로는 목록 전체를 거부한다', async () => {
    for (const path of ['https://evil.example/SKILL.md', '//evil.example/SKILL.md', '/etc/SKILL.md', '../secret/SKILL.md', 'a/../../SKILL.md']) {
      const ports = repo({ 'index.json': index([{ id: 'x', path }]) });
      await expect(syncSkills(INDEX, ports)).rejects.toThrow('상대 경로');
      expect(ports.asked).toEqual([INDEX]);
    }
  });

  it('목록을 읽지 못하면 이유와 함께 던진다', async () => {
    await expect(syncSkills(INDEX, repo({}))).rejects.toThrow(`스킬 목록을 읽지 못했습니다 (${INDEX}): HTTP 404`);
    await expect(syncSkills(INDEX, repo({ 'index.json': '<html>로그인</html>' }))).rejects.toThrow('스킬 목록을 읽지 못했습니다');
    await expect(syncSkills(INDEX, repo({ 'index.json': '{"skill": []}' }))).rejects.toThrow('형식이 잘못되었습니다');
  });

  it('pnpm skill:index가 만든 목록으로 번들된 스킬을 모두 받을 수 있다', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dogent-skills-'));
    cpSync(join(ROOT, 'samples', 'skills'), dir, { recursive: true });
    execFileSync(process.execPath, [join(ROOT, 'tools/skill-index.mjs'), dir]);
    const made = JSON.parse(readFileSync(join(dir, 'index.json'), 'utf8')) as { systems?: { id: string; path: string }[]; skills: { id: string; path: string; policy?: string }[] };
    expect(made.skills.length).toBeGreaterThanOrEqual(5);
    expect(made.skills.find((s) => s.id === 'firewall-request')?.policy).toBe('firewall-request/policy.yaml');

    const files: Record<string, string> = { 'index.json': JSON.stringify(made) };
    for (const s of made.skills) {
      files[s.path] = readFileSync(join(dir, s.path), 'utf8');
      if (s.policy) files[s.policy] = readFileSync(join(dir, s.policy), 'utf8');
    }
    for (const s of made.systems ?? []) files[s.path] = readFileSync(join(dir, s.path), 'utf8');
    const result = await syncSkills(INDEX, repo(files));
    expect(result.errors).toEqual([]);
    expect(result.skills.map((s) => s.id)).toEqual(made.skills.map((s) => s.id));
    expect(result.systems.map((s) => s.id)).toEqual((made.systems ?? []).map((s) => s.id));
  });
});
