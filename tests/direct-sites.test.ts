import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ROOT, siteRules } from '../client/build-env.mjs';
import { directSites } from '../client/src/direct/sites';
import { launchBrowser } from '../client/src/launch-browser';
import { ANY_SITE, siteAllowed } from '../src/core';

describe('직접 제어의 조작할 사이트', () => {
  it('모든 사이트 빌드(기본)면 모든 http·https', () => {
    const r = directSites({}, 'mes.corp.com');
    expect(r).toEqual({ sites: ANY_SITE, rejected: [], listed: false });
  });

  it('목록 방식 빌드면 빌드의 목록만 허용하고, 다른 사이트는 막는다', () => {
    const r = directSites({ sites: ['http://localhost:4173/*', 'https://mes.corp.com/*'] }, undefined);
    expect(r.listed).toBe(true);
    expect(siteAllowed('https://mes.corp.com/wip', r.sites)).toBe(true);
    expect(siteAllowed('https://naver.com/', r.sites)).toBe(false);
  });

  it('사용자가 더한 사이트는 빌드의 범위 안인 것만 받는다', () => {
    const r = directSites({ sites: ['https://mes.corp.com/*'], siteScope: ['https://*.corp.com/*'] }, 'erp.corp.com, https://naver.com/x, 이상한 주소, *.docs.corp.com');
    expect(r.sites).toEqual(['https://mes.corp.com/*', 'https://erp.corp.com/*', 'https://*.docs.corp.com/*']);
    expect(r.rejected).toHaveLength(2);
    expect(r.rejected[0]).toMatch(/naver\.com.*범위 밖/);
    expect(siteAllowed('https://a.docs.corp.com/doc', r.sites)).toBe(true);
    expect(siteAllowed('https://naver.com/', r.sites)).toBe(false);
  });

  it('범위가 없으면 사용자가 아무 사이트나 더할 수 있다 (확장 패널의 "이 사이트 허용"과 같음)', () => {
    const r = directSites({ sites: ['https://mes.corp.com/*'] }, ['naver.com']);
    expect(r.sites).toContain('https://naver.com/*');
    expect(r.rejected).toEqual([]);
  });
});

describe('클라이언트 빌드의 사이트 규칙 (확장 빌드와 같은 값)', () => {
  const saved = { all: process.env.WXT_ALL_SITES, perm: process.env.WXT_SITE_PERMISSIONS, scope: process.env.WXT_SITE_SCOPE };
  const mode = `sitetest${process.pid}`;
  const envFile = join(ROOT, `.env.${mode}.local`);
  afterEach(() => {
    for (const [k, v] of [['WXT_ALL_SITES', saved.all], ['WXT_SITE_PERMISSIONS', saved.perm], ['WXT_SITE_SCOPE', saved.scope]] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    rmSync(envFile, { force: true });
  });

  it('WXT_ALL_SITES가 없으면 아무것도 넣지 않는다 (모든 사이트)', () => {
    delete process.env.WXT_ALL_SITES;
    expect(siteRules(mode)).toEqual({});
  });

  it('목록 방식이면 환경 파일의 사이트와 범위를 넣는다', () => {
    delete process.env.WXT_ALL_SITES;
    delete process.env.WXT_SITE_PERMISSIONS;
    delete process.env.WXT_SITE_SCOPE;
    writeFileSync(envFile, 'WXT_ALL_SITES=false\nWXT_SITE_PERMISSIONS=https://mes.corp.com/*, https://erp.corp.com/*\nWXT_SITE_SCOPE=https://*.corp.com/*\n');
    expect(siteRules(mode)).toEqual({
      sites: ['http://localhost:4173/*', 'https://mes.corp.com/*', 'https://erp.corp.com/*'],
      siteScope: ['https://*.corp.com/*'],
    });
  });
});

describe('브라우저 자동 실행', () => {
  it('띄우는 데 실패해도 던지지 않는다', () => {
    const r = launchBrowser('chrome', {
      platform: 'win32',
      running: () => false,
      start: () => {
        throw new Error('spawn ENOENT');
      },
    });
    expect(r).toBe('unsupported');
  });

  it('실제 실행 함수는 cmd.exe를 못 찾아도 프로세스를 죽이지 않는다', async () => {
    if (process.platform !== 'win32') return;
    const saved = process.env.ComSpec;
    process.env.ComSpec = join(mkdtempSync(join(tmpdir(), 'dogent-nocmd-')), 'no-such-cmd.exe');
    try {
      // 떠 있지 않다고 보게 해서 실제 start(spawn)를 부른다. 없는 실행 파일이라 비동기 error가 나야 한다.
      expect(launchBrowser('chrome', { running: () => false })).toBe('started');
      await new Promise((r) => setTimeout(r, 300));
    } finally {
      if (saved === undefined) delete process.env.ComSpec;
      else process.env.ComSpec = saved;
    }
  });
});
