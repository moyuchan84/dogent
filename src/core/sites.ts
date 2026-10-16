/**
 * 에이전트가 조작할 사이트의 주소 규칙(크롬 match pattern)을 다룬다.
 * 빌드에 넣은 사이트 말고도, 사용자가 설정에서 사이트를 더하면 크롬에 그 사이트 권한을 요청한다.
 */

/** 모든 http·https 사이트. 빌드에서 범위를 정하지 않았을 때 사용자가 더할 수 있는 상한이다. */
export const ANY_SITE = ['http://*/*', 'https://*/*'];

/**
 * 사람이 적은 주소를 크롬의 사이트 규칙으로 바꾼다.
 * "mes.corp.com", "https://mes.corp.com/wip/list?x=1", "http://10.1.2.3:8080" → "https://mes.corp.com/*" 처럼 호스트 단위.
 * "*.corp.com"처럼 하위 도메인 전체도 된다.
 */
export function sitePattern(input: string): string {
  let text = input.trim();
  if (text === '') throw new Error('주소를 적어 주세요');
  if (!/^[a-z]+:\/\//i.test(text)) text = `https://${text}`;
  const m = /^(https?):\/\/([^/?#]+)/i.exec(text);
  if (!m) throw new Error(`"${input}"은(는) http나 https 주소가 아닙니다`);
  const scheme = m[1].toLowerCase();
  const host = m[2].toLowerCase();
  if (host.lastIndexOf('*') > 0 || (host.includes('*') && !host.startsWith('*.'))) throw new Error('*는 맨 앞에만 쓸 수 있습니다. 예: *.example.com');
  const name = host.replace(/^\*\./, '').replace(/:\d+$/, '');
  if (!/^[a-z0-9.-]+$/.test(name) || name.startsWith('.') || name.endsWith('.') || !name.includes('.') && name !== 'localhost') {
    throw new Error(`"${input}"에서 호스트를 읽지 못했습니다. 예: mes.example.com`);
  }
  return `${scheme}://${host}/*`;
}

/** 규칙이 덮는 호스트 부분. "https://*.corp.com/*" → { scheme: 'https', host: '*.corp.com' } */
function parts(pattern: string): { scheme: string; host: string } | null {
  const m = /^(\*|https?):\/\/([^/]+)\//.exec(pattern);
  return m ? { scheme: m[1], host: m[2] } : null;
}

const hostOnly = (host: string) => host.replace(/:\d+$/, '');

/** scope 규칙이 pattern 규칙을 모두 덮는지. 사용자가 더하려는 사이트가 빌드의 범위 안인지 볼 때 쓴다. */
export function covers(scope: string, pattern: string): boolean {
  const s = parts(scope);
  const p = parts(pattern);
  if (!s || !p) return false;
  if (s.scheme !== '*' && s.scheme !== p.scheme) return false;
  if (s.host === '*') return true;
  if (s.host.startsWith('*.')) {
    const base = hostOnly(s.host.slice(2));
    const target = hostOnly(p.host.replace(/^\*\./, ''));
    return target === base || target.endsWith(`.${base}`);
  }
  return s.host === p.host || hostOnly(s.host) === p.host;
}

/** 주소의 출처를 사이트 규칙으로. 화면 점검에서 읽지 못한 화면을 바로 허용할 때 쓴다. */
export function originPattern(url: string): string | null {
  try {
    const u = new URL(url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return `${u.protocol}//${u.host}/*`;
  } catch {
    return null;
  }
}
