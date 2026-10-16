import { describe, expect, it } from 'vitest';
import { ANY_SITE, covers, originPattern, sitePattern } from '../src/core';

describe('사이트 규칙', () => {
  it('사람이 적은 주소를 호스트 단위 규칙으로 바꾼다', () => {
    expect(sitePattern('mes.example.com')).toBe('https://mes.example.com/*');
    expect(sitePattern(' https://MES.example.com/wip/list?line=7#top ')).toBe('https://mes.example.com/*');
    expect(sitePattern('http://10.1.2.3:8080/app')).toBe('http://10.1.2.3:8080/*');
    expect(sitePattern('http://localhost:4173')).toBe('http://localhost:4173/*');
    expect(sitePattern('*.corp.example.com')).toBe('https://*.corp.example.com/*');
  });

  it('주소로 읽을 수 없는 것은 이유를 알린다', () => {
    expect(() => sitePattern('')).toThrow(/적어/);
    expect(() => sitePattern('ftp://files.example.com')).toThrow(/http나 https/);
    expect(() => sitePattern('사내 시스템')).toThrow(/호스트/);
    expect(() => sitePattern('mes.*.com')).toThrow(/맨 앞/);
  });

  it('범위가 사이트를 덮는지 본다', () => {
    for (const p of ['https://mes.example.com/*', 'http://10.1.2.3:8080/*']) expect(ANY_SITE.some((s) => covers(s, p))).toBe(true);
    expect(covers('https://*.corp.com/*', 'https://mes.corp.com/*')).toBe(true);
    expect(covers('https://*.corp.com/*', 'https://a.b.corp.com/*')).toBe(true);
    expect(covers('https://*.corp.com/*', 'https://corp.com/*')).toBe(true);
    expect(covers('https://*.corp.com/*', 'https://*.mes.corp.com/*')).toBe(true);
    expect(covers('https://*.corp.com/*', 'https://evilcorp.com/*')).toBe(false);
    expect(covers('https://*.corp.com/*', 'http://mes.corp.com/*')).toBe(false);
    expect(covers('*://*.corp.com/*', 'http://mes.corp.com:8080/*')).toBe(true);
    expect(covers('https://mes.corp.com/*', 'https://wiki.corp.com/*')).toBe(false);
  });

  it('주소의 출처를 규칙으로 바꾼다', () => {
    expect(originPattern('http://127.0.0.1:4173/wip.html?x=1')).toBe('http://127.0.0.1:4173/*');
    expect(originPattern('chrome://extensions')).toBeNull();
  });
});
