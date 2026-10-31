import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildFreeSkill, describeSystem, lintSystem, parseSystem, planRequest, searchSystems, syncSkills, systemForUrl, type System } from '../src/core';

const ROOT = join(import.meta.dirname, '..');
const dir = join(ROOT, 'samples/skills/systems');
const sources = readdirSync(dir).map((d) => readFileSync(join(dir, d, 'SYSTEM.md'), 'utf8'));
const systems: System[] = sources.map(parseSystem);
const ids = (q: string) => searchSystems(systems, q).map((s) => s.id);

describe('시스템 사전', () => {
  it('기본으로 넣은 시스템 문서는 오류 없이 읽힌다', () => {
    for (const source of sources) {
      const r = lintSystem(source);
      expect(r.errors).toEqual([]);
      expect(r.warnings).toEqual([]);
    }
  });

  it('도메인을 비우면 주소의 호스트를 쓴다', () => {
    const s = parseSystem('---\nid: x\nname: 엑스\ndescription: d\nurl: https://x.example.com/app\nowner: o\n---\n');
    expect(s.domains).toEqual(['x.example.com']);
  });

  it('필수 항목이 빠지면 무엇이 빠졌는지 알려 준다', () => {
    expect(lintSystem('---\nid: x\nname: 엑스\n---\n').errors[0]).toMatch(/description/);
    expect(lintSystem('본문만').errors[0]).toMatch(/선언부/);
    expect(lintSystem('---\nid: x\nname: n\ndescription: d\nurl: ftp://x\nowner: o\n---\n').errors[0]).toMatch(/url/);
  });

  it('긴 요청에서도 별칭으로 시스템을 찾는다', () => {
    expect(ids('재공 시스템 들어가서 8라인 홀드 걸린 거 보여줘')[0]).toBe('mes');
    expect(ids('재공시스템에서 7라인 조회')[0]).toBe('mes');
    expect(ids('방화벽 신청하러 보안 포털 열어줘')[0]).toBe('security-portal');
    expect(ids('휴가 신청')).toEqual([]);
  });

  it('지금 화면의 주소로 시스템을 알아낸다', () => {
    expect(systemForUrl(systems, 'http://localhost:4173/wip.html')?.id).toBeDefined();
    expect(systemForUrl(systems, 'https://other.example.com/')).toBeUndefined();
    expect(systemForUrl(systems, undefined)).toBeUndefined();
  });

  it('모델에 보여 줄 설명에 별칭, 화면, 용어가 들어간다', () => {
    const text = describeSystem(systems.find((s) => s.id === 'mes')!);
    expect(text).toMatch(/재공 시스템/);
    expect(text).toMatch(/재공 현황 조회 \[재공 > 재공 현황\]/);
    expect(text).toMatch(/HOLD: 품질 문제/);
  });

  it('요청 해석과 자유 요청 프롬프트에 시스템 설명이 실린다', async () => {
    const info = describeSystem(systems.find((s) => s.id === 'mes')!);
    const seen: string[] = [];
    await planRequest('홀드 보여줘', [], { complete: async (m) => (seen.push(m.map((x) => x.content).join('\n')), '{"skill_id": null}') }, undefined, info);
    expect(seen[0]).toMatch(/사내 시스템 설명[\s\S]*HOLD: 품질 문제/);

    const free = buildFreeSkill('http://localhost:4173/wip.html', false, info);
    expect(free.body).toMatch(/## 시스템 정보[\s\S]*HOLD: 품질 문제/);
    expect(buildFreeSkill('http://localhost:4173/wip.html', false).body).not.toMatch(/시스템 정보/);
  });

  it('팀 저장소 목록의 시스템 문서를 받는다. 검사에서 떨어진 문서는 받지 않는다', async () => {
    const files: Record<string, string> = {
      'https://git.example.com/s/index.json': JSON.stringify({
        systems: [
          { id: 'mes', path: 'systems/mes/SYSTEM.md' },
          { id: 'bad', path: 'systems/bad/SYSTEM.md' },
          { id: 'other', path: 'systems/other/SYSTEM.md' },
        ],
        skills: [],
      }),
      'https://git.example.com/s/systems/mes/SYSTEM.md': sources.find((s) => /^id: mes$/m.test(s))!,
      'https://git.example.com/s/systems/bad/SYSTEM.md': '---\nid: bad\n---\n',
      'https://git.example.com/s/systems/other/SYSTEM.md': sources.find((s) => /^id: mes$/m.test(s))!,
    };
    const r = await syncSkills('https://git.example.com/s/index.json', {
      fetchText: async (u) => files[u] ?? Promise.reject(new Error('HTTP 404')),
    });
    expect(r.systems.map((x) => x.id)).toEqual(['mes']);
    expect(r.errors.join('\n')).toMatch(/시스템 bad/);
    expect(r.errors.join('\n')).toMatch(/시스템 other: 파일의 id는 "mes"/);
  });
});
