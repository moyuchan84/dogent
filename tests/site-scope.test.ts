import { describe, expect, it } from 'vitest';
import { allSitesFor } from '../dogent.config';

describe('모든 사이트 권한을 선언할지 (allSitesFor)', () => {
  it('회사 빌드는 기본이 목록 방식, 개발·집 빌드는 모든 사이트', () => {
    expect(allSitesFor('company', undefined)).toBe(false);
    expect(allSitesFor('company', '')).toBe(false);
    expect(allSitesFor('home', undefined)).toBe(true);
    expect(allSitesFor('production', undefined)).toBe(true);
    expect(allSitesFor(undefined, undefined)).toBe(true);
  });

  it('WXT_ALL_SITES를 적으면 모드와 상관없이 그 값을 따른다', () => {
    expect(allSitesFor('company', 'true')).toBe(true);
    expect(allSitesFor('company', '1')).toBe(true);
    expect(allSitesFor('home', 'false')).toBe(false);
    expect(allSitesFor('home', 'OFF')).toBe(false);
    expect(allSitesFor('home', ' 0 ')).toBe(false);
  });
});
