import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseSkill, parseSystem, sameUrl, startUrlForSkill, urlInText } from '../src/core';

const ROOT = join(import.meta.dirname, '..');
const wip = parseSkill(readFileSync(join(ROOT, 'samples/skills/wip-check/SKILL.md'), 'utf8'));
const mes = parseSystem(readFileSync(join(ROOT, 'samples/skills/systems/mes/SYSTEM.md'), 'utf8'));

describe('요청에서 시작 주소 찾기', () => {
  it('전체 주소는 조사 앞에서 끊는다', () => {
    expect(urlInText('https://mes.example.com/wip?line=8 에서 8라인 보여줘')).toBe('https://mes.example.com/wip?line=8');
    expect(urlInText('https://mes.example.com에서 홀드 확인')).toBe('https://mes.example.com/');
    expect(urlInText('http://localhost:4173/hold.html 들어가서 해제 요청 화면 읽어줘.')).toBe('http://localhost:4173/hold.html');
  });

  it('끝의 문장부호는 뗀다', () => {
    expect(urlInText('(https://mes.example.com/a), 열어')).toBe('https://mes.example.com/a');
  });

  it('스킴이 없는 사내 주소도 알아본다 (localhost와 IP는 http, 나머지는 https)', () => {
    expect(urlInText('localhost:4173/wip.html 열어줘')).toBe('http://localhost:4173/wip.html');
    expect(urlInText('10.1.2.3:8080 접속해서 확인')).toBe('http://10.1.2.3:8080/');
    expect(urlInText('mes.company.co.kr 들어가서 재공 조회')).toBe('https://mes.company.co.kr/');
  });

  it('파일 이름, 숫자, 이메일은 주소로 보지 않는다', () => {
    expect(urlInText('report.xlsx 를 열어줘')).toBeNull();
    expect(urlInText('수량을 3.5 로 바꿔줘')).toBeNull();
    expect(urlInText('a.kim@company.com 에게 알려줘')).toBeNull();
    expect(urlInText('8라인 재공 알려줘')).toBeNull();
  });
});

describe('스킬을 시작할 주소', () => {
  it('요청에 쓴 주소가 스킬의 사이트 안이면 그것을 쓴다', () => {
    expect(startUrlForSkill(wip, [mes], 'http://localhost:4173/wip.html?line=8 열어서 확인')).toBe('http://localhost:4173/wip.html?line=8');
  });

  it('요청의 주소가 스킬의 사이트 밖이면 쓰지 않고 시스템 사전의 주소를 쓴다', () => {
    expect(startUrlForSkill(wip, [mes], 'https://other.example.com/ 에서')).toBe(mes.url);
  });

  it('시스템 사전도 없으면 스킬 본문에 적힌 주소, 그것도 없으면 null', () => {
    expect(startUrlForSkill(wip, [])).toBe('http://localhost:4173/wip.html');
    // 사이트가 본문의 주소와 다르면 쓸 수 없다
    const elsewhere = parseSkill(readFileSync(join(ROOT, 'samples/skills/wip-check/SKILL.md'), 'utf8').replace('  - localhost:4173', '  - other.example.com'));
    expect(startUrlForSkill(elsewhere, [])).toBeNull();
  });
});

describe('같은 화면 비교', () => {
  it('# 뒤와 끝 슬래시는 무시한다', () => {
    expect(sameUrl('http://a.com/x#top', 'http://a.com/x')).toBe(true);
    expect(sameUrl('http://a.com/', 'http://a.com')).toBe(true);
    expect(sameUrl('http://a.com/x', 'http://a.com/y')).toBe(false);
    expect(sameUrl(undefined, 'http://a.com')).toBe(false);
  });
});
