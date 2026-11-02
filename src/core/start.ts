import { hostAllowed } from './policy';
import type { Skill } from './skill';
import type { System } from './systems';

/**
 * 요청을 어느 주소에서 시작할지 정한다.
 *
 * "https://mes.example.com 들어가서 8라인 홀드 보여줘"처럼 요청에 주소가 있거나, 요청이 사내 시스템 이름을 부르면
 * 지금 열려 있는 탭을 밀어내지 않고 새 탭에서 시작한다 (Claude in Chrome과 같다).
 * 브라우저 API와 Node API를 쓰지 않는다.
 */

/** 주소에 쓰는 글자만 이어 붙인다. 한글 조사("…com에서")는 거기서 끊긴다 */
const URL_CHARS = "[A-Za-z0-9._~:/?#@!$&'()*+,;=%\\-\\[\\]]+";
const FULL = new RegExp(`https?://${URL_CHARS}`, 'i');
/** 스킴 없이 쓴 사내 주소: localhost:4173/a, 10.1.2.3:8080, mes.company.co.kr/wip */
const BARE = new RegExp(`(?<![A-Za-z0-9@.-])((?:localhost|\\d{1,3}(?:\\.\\d{1,3}){3}|[a-z0-9-]+(?:\\.[a-z0-9-]+)+)(?::\\d+)?(?![A-Za-z0-9@-])(?:/${URL_CHARS})?)`, 'i');

/** 끝에 붙은 문장부호를 뗀다 */
const tidy = (u: string) => u.replace(/[.,;:!?)\]]+$/, '');

/** 요청 글에서 첫 주소를 꺼낸다. 없으면 null. 스킴이 없으면 http(s)를 붙인다 (localhost와 IP는 http, 나머지는 https) */
export function urlInText(text: string): string | null {
  const full = FULL.exec(text);
  const raw = full ? full[0] : BARE.exec(text)?.[1];
  if (!raw) return null;
  const url = tidy(raw);
  if (full) return validUrl(url);
  // "mes.company.co.kr" 같은 말만 주소로 본다. 파일 이름(report.xlsx)이나 숫자(3.5)는 거른다
  const host = url.split(/[/:]/)[0];
  const isIp = /^\d{1,3}(\.\d{1,3}){3}$/.test(host);
  const isLocal = host.toLowerCase() === 'localhost';
  if (!isIp && !isLocal && !/\.[a-z]{2,}$/i.test(host)) return null;
  if (!isIp && !isLocal && /\.(xlsx?|csv|docx?|pptx?|pdf|txt|md|json|zip|png|jpe?g|gif|mjs|ts|js)$/i.test(host)) return null;
  return validUrl(`${isIp || isLocal ? 'http' : 'https'}://${url}`);
}

function validUrl(u: string): string | null {
  try {
    const x = new URL(u);
    return /^https?:$/.test(x.protocol) ? x.href : null;
  } catch {
    return null;
  }
}

const covers = (domains: string[], url: string) => {
  try {
    return hostAllowed(url, domains);
  } catch {
    return false;
  }
};

/**
 * 스킬을 시작할 주소. 지금 탭이 스킬의 사이트가 아닐 때 새 탭에서 열 곳이다. 없으면 null.
 *  1. 요청에 쓴 주소 (스킬의 사이트 안일 때)
 *  2. 스킬의 사이트를 다루는 시스템 사전의 주소
 *  3. 스킬 본문에 적힌 첫 주소 (스킬의 사이트 안일 때)
 */
export function startUrlForSkill(skill: Skill, systems: System[], request?: string): string | null {
  const asked = request ? urlInText(request) : null;
  if (asked && covers(skill.domains, asked)) return asked;
  const sys = systems.find((s) => covers(skill.domains, s.url));
  if (sys) return sys.url;
  for (const m of skill.body.matchAll(new RegExp(`https?://${URL_CHARS}`, 'gi'))) {
    const u = validUrl(tidy(m[0]));
    if (u && covers(skill.domains, u)) return u;
  }
  return null;
}

/** 두 주소가 같은 사이트(호스트와 포트)인지 */
export function sameSite(a: string | undefined, b: string): boolean {
  try {
    return !!a && new URL(a).host === new URL(b).host;
  } catch {
    return false;
  }
}

/** 두 주소가 같은 화면인지 (#뒤는 무시) */
export function sameUrl(a: string | undefined, b: string): boolean {
  try {
    if (!a) return false;
    const x = new URL(a);
    const y = new URL(b);
    x.hash = '';
    y.hash = '';
    return x.href.replace(/\/$/, '') === y.href.replace(/\/$/, '');
  } catch {
    return false;
  }
}

/** 일할 탭을 어떻게 마련할지 (chooseWorkTab의 답) */
export type WorkTabPlan =
  | { kind: 'use'; id: number; why: 'current' | 'open' | 'work' }
  | { kind: 'navigate'; id: number; url: string; why: 'current' | 'open' | 'work' }
  | { kind: 'open'; url: string }
  | { kind: 'none' };

/**
 * 요청마다 새 탭을 열지 않고, 이미 열린 탭을 먼저 쓴다. 새 탭은 쓸 탭이 없을 때만 연다.
 *  1. 그 주소를 이미 보여 주는 탭 → 그대로 쓴다 (지금 탭 > Dogent가 연 탭 > 다른 탭)
 *  2. 그 사이트(covers)의 탭 → 그대로 쓴다. 단 exact(요청에 주소를 썼으면)는 이 단계를 건너뛴다
 *     (그 주소로 가야 하는데 사용자가 보던 화면을 바꿔 버리지 않게)
 *  3. Dogent가 앞서 연 탭이 남아 있으면 → 그 탭을 그 주소로 옮긴다 (사용자가 보던 탭은 다른 화면으로 옮기지 않는다)
 *  4. 그래도 없으면 → 새 탭
 * url이 없으면(주소를 모르면) 지금 탭에서 한다. 조작할 사이트 목록 밖의 탭(allowed: false)은 고르지 않는다.
 */
export function chooseWorkTab(
  tabs: { id: number; url: string; current: boolean; allowed: boolean }[],
  want: { url: string | null; covers?: (url: string) => boolean; exact?: boolean },
  workTab: number | null = null,
): WorkTabPlan {
  const usable = tabs.filter((t) => t.allowed && /^https?:/.test(t.url));
  const why = (t: { id: number; current: boolean }) => (t.current ? 'current' : t.id === workTab ? 'work' : 'open') as 'current' | 'open' | 'work';
  // 지금 탭, Dogent가 연 탭, 나머지 순으로 본다
  const ordered = [...usable].sort((a, b) => Number(b.current) - Number(a.current) || Number(b.id === workTab) - Number(a.id === workTab));
  if (!want.url) {
    const now = usable.find((t) => t.current);
    return now ? { kind: 'use', id: now.id, why: 'current' } : { kind: 'none' };
  }
  const url = want.url;
  const same = ordered.find((t) => sameUrl(t.url, url));
  if (same) return { kind: 'use', id: same.id, why: why(same) };
  const covers = want.covers ?? ((u: string) => sameSite(u, url));
  const site = want.exact ? undefined : ordered.find((t) => covers(t.url));
  if (site) return { kind: 'use', id: site.id, why: why(site) };
  const work = workTab !== null ? tabs.find((t) => t.id === workTab) : undefined;
  if (work) return { kind: 'navigate', id: work.id, url, why: 'work' };
  return { kind: 'open', url };
}
