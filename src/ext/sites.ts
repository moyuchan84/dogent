import { browser } from 'wxt/browser';
import { dogentConfig } from '@/dogent.config';
import { ANY_SITE, covers, sitePattern } from '../core/sites';

/**
 * 사용자가 설정에서 더할 수 있는 사이트의 범위. 빌드 환경 파일의 WXT_SITE_SCOPE (쉼표로 여러 개).
 * 적지 않으면 모든 http·https 사이트다. wxt.config.ts가 같은 값을 optional_host_permissions에 넣는다.
 */
export const SITE_SCOPE: string[] = (() => {
  const raw = (import.meta.env.WXT_SITE_SCOPE as string | undefined) ?? '';
  const list = raw.split(',').map((s) => s.trim()).filter(Boolean);
  return list.length ? list : ANY_SITE;
})();

/** 빌드에 들어 있어 지울 수 없는 사이트 */
export const BUILT_IN_SITES = dogentConfig.sitePermissions;

/** 사용자가 설정이나 화면 점검에서 더한 사이트 (크롬이 허용한 것) */
export async function addedSites(): Promise<string[]> {
  const granted = (await browser.permissions.getAll()).origins ?? [];
  const fixed = new Set(browser.runtime.getManifest().host_permissions ?? []);
  return granted.filter((o) => !fixed.has(o));
}

/** 에이전트가 조작할 수 있는 사이트 전체 */
export async function allSites(): Promise<string[]> {
  return [...new Set([...BUILT_IN_SITES, ...(await addedSites())])];
}

/**
 * 크롬에 사이트 권한을 요청한다. 크롬이 허용할지 묻는 창을 띄우므로 버튼을 누른 그 처리 안에서 불러야 한다.
 * 범위 밖이거나 사용자가 거절하면 이유를 담은 오류를 낸다.
 */
export async function requestSites(inputs: string[]): Promise<string[]> {
  const patterns = [...new Set(inputs.map(sitePattern))];
  const outside = patterns.filter((p) => !SITE_SCOPE.some((s) => covers(s, p)));
  if (outside.length) {
    throw new Error(`${outside.join(', ')}은(는) 이 배포에서 허용할 수 있는 범위(${SITE_SCOPE.join(', ')}) 밖입니다`);
  }
  let granted: boolean;
  try {
    granted = await browser.permissions.request({ origins: patterns });
  } catch (e) {
    throw new Error(`크롬이 권한 요청을 받지 않았습니다: ${(e as Error).message}. 회사 정책으로 막혀 있으면 빌드 설정 파일의 WXT_SITE_PERMISSIONS에 적어 다시 빌드하세요`);
  }
  if (!granted) throw new Error('허용하지 않았습니다. 크롬이 묻는 창에서 "허용"을 눌러야 합니다');
  return patterns;
}

export async function removeSite(pattern: string): Promise<void> {
  await browser.permissions.remove({ origins: [pattern] });
}
