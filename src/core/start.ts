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
