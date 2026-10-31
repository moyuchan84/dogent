import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { docOfSkill, parseSkill, searchSkills, shortlistSkills, skillCoversUrl, type Skill, type SkillDoc } from '../src/core';

const ROOT = join(import.meta.dirname, '..');
const bundled: Skill[] = readdirSync(join(ROOT, 'samples', 'skills')).filter((d) => d !== 'systems').map((d) => parseSkill(readFileSync(join(ROOT, 'samples', 'skills', d, 'SKILL.md'), 'utf8')));
const ids = (hits: { item: Skill }[]) => hits.map((h) => h.item.id);
const find = (q: string, url?: string) => ids(searchSkills(bundled, docOfSkill, q, { url }));

describe('스킬 찾기', () => {
  it('사람이 쓰는 말로 찾는다 (조사·어미가 붙어도)', () => {
    expect(find('홀드 해제해줘')[0]).toBe('hold-release');
    expect(find('방화벽 신청')[0]).toBe('firewall-request');
    expect(find('IP 포트 열어야 해')[0]).toBe('firewall-request');
    expect(find('제품코드로 검색')[0]).toBe('wip-search');
    expect(find('엑셀로 수량을 일괄 입력')[0]).toBe('wip-adjust');
  });

  it('맞는 것이 없으면 아무것도 돌려주지 않는다', () => {
    expect(find('휴가 신청')).toEqual([]);
    expect(find('메일 보내기')).toEqual([]);
  });

  it('말이 비면 전부를, 지금 화면의 사이트를 다루는 스킬을 앞에 둔다', () => {
    const docs: SkillDoc[] = [
      { id: 'a', name: '가', description: 'x', domains: ['other.example.com'] },
      { id: 'b', name: '나', description: 'x', domains: ['mes.example.com'] },
    ];
    const hits = searchSkills(docs, (d) => d, '', { url: 'https://mes.example.com/wip' });
    expect(hits.map((h) => [h.item.id, h.site])).toEqual([
      ['b', true],
      ['a', false],
    ]);
  });

  it('같은 말이면 지금 화면의 사이트를 다루는 스킬이 앞에 온다', () => {
    const docs: SkillDoc[] = [
      { id: 'other', name: '재공 확인', description: '재공을 본다', domains: ['other.example.com'] },
      { id: 'here', name: '재공 확인', description: '재공을 본다', domains: ['*.mes.example.com'] },
    ];
    expect(searchSkills(docs, (d) => d, '재공', { url: 'https://p1.mes.example.com/' }).map((h) => h.item.id)).toEqual(['here', 'other']);
  });

  it('태그로도 찾는다', () => {
    const docs: SkillDoc[] = [
      { id: 'q', name: '품질 이력', description: '검사 결과를 본다', tags: ['SPC', '불량'] },
      { id: 'r', name: '재공 확인', description: '재공을 본다' },
    ];
    expect(searchSkills(docs, (d) => d, 'spc 불량 확인').map((h) => h.item.id)[0]).toBe('q');
  });

  it('주소가 http(s)가 아니거나 domains가 없으면 사이트가 맞지 않는다', () => {
    expect(skillCoversUrl({ id: 'a', name: 'a', description: 'a', domains: ['localhost:4173'] }, 'http://localhost:4173/wip.html')).toBe(true);
    expect(skillCoversUrl({ id: 'a', name: 'a', description: 'a', domains: ['localhost:4173'] }, 'chrome://extensions')).toBe(false);
    expect(skillCoversUrl({ id: 'a', name: 'a', description: 'a' }, 'http://localhost:4173/')).toBe(false);
  });
});

describe('요청 해석에 보여 줄 스킬 고르기', () => {
  const many: SkillDoc[] = Array.from({ length: 40 }, (_, i) => ({ id: `s${i}`, name: `업무 ${i}`, description: '기타 업무', domains: ['x.example.com'] }));
  many.push({ id: 'hold', name: 'Lot 홀드 해제 요청', description: '홀드를 푼다', domains: ['mes.example.com'] });
  many.push({ id: 'here', name: '설비 상태', description: '설비를 본다', domains: ['mes.example.com'] });

  it('적으면 그대로 다 준다', () => {
    expect(shortlistSkills(bundled, docOfSkill, '아무 말')).toHaveLength(bundled.length);
  });

  it('많으면 말이 맞는 것과 지금 화면의 사이트를 다루는 것을 고른다', () => {
    const picked = shortlistSkills(many, (d) => d, '홀드 해제해줘', { url: 'https://mes.example.com/', limit: 5 }).map((d) => d.id);
    expect(picked).toContain('hold');
    expect(picked).toContain('here');
    expect(picked.length).toBeLessThanOrEqual(5);
  });
});
