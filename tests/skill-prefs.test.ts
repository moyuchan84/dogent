import { appendFileSync, cpSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { ClientConfig } from '../client/src/config';
import type { Session as SessionType, Ui } from '../client/src/session';
import { loadSkillPrefs, patchSkillPrefs } from '../client/src/skill-prefs';
import { readRecentRuns } from '../client/src/store';
import { isLocalSite, isSampleSkill } from '../src/core';

const ROOT = join(import.meta.dirname, '..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');
const build = { mode: 'company', version: 'test' } as { mode: string; version: string; samples?: boolean };

let Session: typeof SessionType;
beforeAll(async () => {
  // 회사 빌드: 기본 스킬은 범용 스킬 하나
  vi.stubGlobal('__DOGENT_SKILLS__', { 'page-summary/SKILL.md': read('skills/page-summary/SKILL.md') });
  vi.stubGlobal('__DOGENT_BUILD__', build);
  ({ Session } = await import('../client/src/session'));
});

const ui = (lines: string[] = []): Ui => ({ print: (t) => lines.push(t), ask: async () => null, confirm: async () => true, askDefault: async (_q, f) => f });

/** 회사 PC처럼 개인 폴더에 목업 스킬을 복사해 둔 사용자 */
function companyPc(): ClientConfig {
  const home = mkdtempSync(join(tmpdir(), 'dogent-prefs-'));
  for (const id of ['wip-check', 'hold-release']) cpSync(join(ROOT, 'samples/skills', id), join(home, 'skills', id), { recursive: true });
  cpSync(join(ROOT, 'samples/skills/systems'), join(home, 'skills', 'systems'), { recursive: true });
  return { home, llm: { baseUrl: 'http://127.0.0.1:1/v1', model: 'm', apiKey: 'k' } as ClientConfig['llm'], personalSkills: join(home, 'skills'), outputDir: join(home, 'out'), saveThroughExcel: false, file: join(home, 'config.json') };
}
const ids = (s: SessionType) => s.skillList().map((e) => e.skill.id).sort();

describe('예시 스킬 알아보기', () => {
  it('다루는 사이트가 모두 이 PC 안이거나 태그에 "예시"가 있으면 예시', () => {
    expect(isLocalSite('localhost:4173')).toBe(true);
    expect(isLocalSite('http://127.0.0.1:8080/wip')).toBe(true);
    expect(isLocalSite('mes.corp.com')).toBe(false);
    expect(isSampleSkill({ id: 'a', name: 'a', description: '', domains: ['localhost:4173'] })).toBe(true);
    expect(isSampleSkill({ id: 'a', name: 'a', description: '', domains: ['localhost:4173', 'mes.corp.com'] })).toBe(false);
    expect(isSampleSkill({ id: 'a', name: 'a', description: '', domains: ['*'] })).toBe(false);
    expect(isSampleSkill({ id: 'a', name: 'a', description: '', domains: ['mes.corp.com'], tags: ['예시'] })).toBe(true);
  });
});

describe('스킬 끄기·고정·예시 (Session)', () => {
  it('회사 빌드는 개인 폴더에 남은 목업 스킬과 목업 시스템 사전을 숨기고, 켜면 보인다', () => {
    const s = new Session(ui(), companyPc(), { yes: true, allowWrite: false, dryRun: false, waitSec: 1 });
    expect(ids(s)).toEqual(['page-summary']);
    expect(s.systemList()).toEqual([]);
    expect(s.allSkillList().filter((x) => x.sample).map((x) => x.entry.skill.id).sort()).toEqual(['hold-release', 'wip-check']);
    s.setSkillPref({ samples: true });
    expect(ids(s)).toEqual(['hold-release', 'page-summary', 'wip-check']);
    expect(s.systemList().length).toBeGreaterThan(0);
  });

  it('끈 스킬은 요청 후보에서 빠지지만 ID로는 찾고, 다시 켜면 돌아온다', () => {
    const cfg = companyPc();
    const lines: string[] = [];
    const s = new Session(ui(lines), cfg, { yes: true, allowWrite: false, dryRun: false, waitSec: 1 });
    s.setSkillPref({ id: 'page-summary', off: true });
    expect(ids(s)).toEqual([]);
    expect(s.skillInfo('page-summary')).toBe(true);
    expect(loadSkillPrefs(cfg.home).off).toEqual(['page-summary']);
    s.setSkillPref({ id: 'page-summary', off: false });
    expect(ids(s)).toEqual(['page-summary']);
  });

  it('terminal: skills on|off, skills samples on, skills all', async () => {
    const lines: string[] = [];
    const s = new Session(ui(lines), companyPc(), { yes: true, allowWrite: false, dryRun: false, waitSec: 1 });
    await s.handle('skills');
    expect(lines.join('\n')).toContain('예시 스킬 2개는 뺐습니다');
    await s.handle('skills off page-summary');
    await s.handle('skills samples on');
    expect(ids(s)).toEqual(['hold-release', 'wip-check']);
    lines.length = 0;
    await s.handle('skills all');
    expect(lines.join('\n')).toMatch(/page-summary — .*\[꺼짐\]/);
    expect(lines.join('\n')).toMatch(/wip-check — .*\[예시\]/);
  });

  it('개발용 빌드에 예시를 넣었으면 처음부터 보인다', () => {
    build.mode = 'production';
    build.samples = true;
    try {
      const s = new Session(ui(), companyPc(), { yes: true, allowWrite: false, dryRun: false, waitSec: 1 });
      expect(ids(s)).toContain('wip-check');
    } finally {
      build.mode = 'company';
      delete build.samples;
    }
  });
});

describe('설정 파일과 최근 실행', () => {
  it('고정·끄기를 겹치지 않게 저장한다', () => {
    const home = mkdtempSync(join(tmpdir(), 'dogent-prefs-'));
    patchSkillPrefs(home, { id: 'a', pinned: true });
    patchSkillPrefs(home, { id: 'a', pinned: true });
    patchSkillPrefs(home, { id: 'b', off: true });
    expect(loadSkillPrefs(home)).toEqual({ off: ['b'], pinned: ['a'] });
    patchSkillPrefs(home, { id: 'a', pinned: false });
    expect(loadSkillPrefs(home).pinned).toEqual([]);
  });

  it('최근 실행은 새것부터, 같은 요청은 한 번만', () => {
    const home = mkdtempSync(join(tmpdir(), 'dogent-recent-'));
    const line = (skill: string, inputs: object, at: string, message: string) =>
      `${JSON.stringify({ id: at, startedAt: at, skill: { id: skill, version: '1' }, inputs, tabUrl: '', events: [], result: { status: 'done', message } })}\n`;
    appendFileSync(join(home, 'runs.jsonl'), line('free', { request: '요약해줘' }, '1', '첫 판'));
    appendFileSync(join(home, 'runs.jsonl'), line('wip-check', { line: '7라인' }, '2', '7라인 재공'));
    appendFileSync(join(home, 'runs.jsonl'), 'not json\n');
    appendFileSync(join(home, 'runs.jsonl'), line('free', { request: '요약해줘' }, '3', '\n둘째 판'));
    const r = readRecentRuns(home);
    expect(r.map((x) => [x.at, x.request ?? x.skillId, x.summary])).toEqual([
      ['3', '요약해줘', '둘째 판'],
      ['2', 'wip-check', '7라인 재공'],
    ]);
  });
});
