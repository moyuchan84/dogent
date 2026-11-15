import { ANY_SITE, covers, sitePattern } from '../../../src/core';

/**
 * 직접 제어(확장 없이)에서 조작할 수 있는 사이트를 정한다.
 *
 * 확장으로 쓸 때는 확장이 사이트 목록을 지키지만, 직접 제어는 확장을 거치지 않는다. 그래서 확장 빌드와 같은 규칙을
 * 클라이언트 빌드에 넣어 두고(client/build-env.mjs의 siteRules) 여기서 같은 결과를 만든다.
 *   - 모든 사이트 빌드(기본): build.sites가 없다 → 모든 http·https
 *   - 목록 방식 빌드(WXT_ALL_SITES=false): 빌드의 sites + 사용자가 더한 사이트(directSites) 중 빌드의 범위(siteScope, 없으면 모든 사이트) 안인 것만
 * 범위 밖이거나 읽지 못한 주소는 버리고 그 까닭을 rejected로 돌려준다.
 */
export function directSites(
  build: { sites?: string[]; siteScope?: string[] },
  added: string | string[] | undefined,
): { sites: string[]; rejected: string[]; listed: boolean } {
  if (!build.sites) return { sites: ANY_SITE, rejected: [], listed: false };
  const scope = build.siteScope?.length ? build.siteScope : ANY_SITE;
  const wanted = (Array.isArray(added) ? added : (added ?? '').split(',')).map((s) => s.trim()).filter(Boolean);
  const sites = [...build.sites];
  const rejected: string[] = [];
  for (const w of wanted) {
    let p: string;
    try {
      p = sitePattern(w);
    } catch (e) {
      rejected.push(`${w}: ${(e as Error).message}`);
      continue;
    }
    if (!scope.some((s) => covers(s, p))) {
      rejected.push(`${w}: 이 빌드에서 더할 수 있는 사이트 범위 밖입니다`);
      continue;
    }
    if (!sites.includes(p)) sites.push(p);
  }
  return { sites, rejected, listed: true };
}
