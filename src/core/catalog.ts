import { hostAllowed } from './policy';
import type { Skill } from './skill';

/**
 * 스킬 찾기. 사람이 쓴 말("홀드 해제", "방화벽 신청")로 스킬을 찾고, 지금 연 화면의 사이트에 맞는 스킬을 앞에 둔다.
 *
 * 모델을 부르지 않는 글자 검색이다. 스킬이 수백 개여도 바로 답하고, 앱의 검색창처럼 글자를 칠 때마다 돌릴 수 있다.
 * 한국어는 조사·어미가 붙어 낱말이 그대로 맞지 않으므로("해제해줘" ↔ "해제 요청") 두 글자씩 끊은 조각도 맞춰 본다.
 * 브라우저 API와 Node API를 쓰지 않는다 (앱의 화면 코드도 이 파일을 쓴다).
 */
export interface SkillDoc {
  id: string;
  name: string;
  description: string;
  owner?: string;
  tags?: string[];
  domains?: string[];
  inputs?: { name: string; label?: string; description?: string }[];
}

export interface SearchHit<T> {
  item: T;
  score: number;
  /** 지금 화면의 사이트를 다루는 스킬 */
  site: boolean;
}

export const docOfSkill = (s: Skill): SkillDoc => ({
  id: s.id,
  name: s.name,
  description: s.description,
  owner: s.owner,
  tags: s.tags,
  domains: s.domains,
  inputs: s.inputs.map((i) => ({ name: i.name, label: i.label, description: i.description })),
});

/** 검색에 뜻이 없는 말 */
const STOP = new Set(['스킬', '업무', '해줘', '알려줘', '줘', '좀', '해', '주세요', '하는', '것', '거']);
/** 낱말 끝에 붙는 조사·어미. 긴 것부터 뗀다 */
const ENDINGS = ['해주세요', '해줘', '하기', '해서', '하고', '에서', '으로', '에게', '부터', '까지', '로', '을', '를', '은', '는', '이', '가', '의', '도', '만', '과', '와', '에'];

const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

function terms(query: string): string[] {
  return norm(query)
    .split(' ')
    .map((w) => {
      for (const e of ENDINGS) if (w.length > e.length + 1 && w.endsWith(e)) return w.slice(0, -e.length);
      return w;
    })
    .filter((w) => w && !STOP.has(w));
}

/** 두 글자 조각 (띄어쓰기는 무시) */
function bigrams(s: string): Set<string> {
  const t = norm(s).replace(/ /g, '');
  const out = new Set<string>();
  for (let i = 0; i < t.length - 1; i++) out.add(t.slice(i, i + 2));
  return out;
}

/** 필드마다의 무게. 이름과 태그가 맞으면 설명보다 크게 친다 */
function fields(d: SkillDoc): [string, number][] {
  return [
    [d.name, 4],
    [(d.tags ?? []).join(' '), 4],
    [d.id.replace(/-/g, ' '), 2],
    [d.description, 2],
    [d.owner ?? '', 1],
    [(d.inputs ?? []).map((i) => `${i.label ?? ''} ${i.description ?? ''}`).join(' '), 1],
    [(d.domains ?? []).join(' '), 1],
  ];
}

/**
 * 말의 낱말 중 스킬에 나오는 것의 비율. 낱말이 그대로 없어도 두 글자 조각의 2/3 이상이 있으면 나온 것으로 본다 (어미·오타).
 * "휴가 신청"처럼 흔한 말("신청") 하나만 맞는 스킬을 걸러 내는 데 쓴다.
 */
function coverage(d: SkillDoc, words: string[]): number {
  const all = norm(fields(d).map(([t]) => t).join(' '));
  const grams = bigrams(all);
  let hit = 0;
  for (const w of words) {
    if (all.includes(w)) hit++;
    else if (w.length >= 3) {
      const g = [...bigrams(w)];
      if (g.filter((x) => grams.has(x)).length / g.length >= 2 / 3) hit++;
    }
  }
  return words.length ? hit / words.length : 0;
}

function score(d: SkillDoc, words: string[], grams: Set<string>): number {
  let total = 0;
  for (const [text, weight] of fields(d)) {
    if (!text) continue;
    const t = norm(text);
    for (const w of words) if (t.includes(w)) total += weight * (w.length >= 2 ? 2 : 1);
    if (grams.size) {
      const g = bigrams(text);
      let hit = 0;
      for (const x of grams) if (g.has(x)) hit++;
      total += weight * (hit / grams.size);
    }
  }
  return total;
}

/** 이 PC 안의 주소 (목업 사이트 pnpm mock:site 등) */
const LOCAL_HOST = /^(localhost|127(?:\.\d{1,3}){3}|\[::1\])(:\d+)?$/i;

/** 주소(또는 domains의 한 줄)가 이 PC 안의 시험용 사이트인지 */
export function isLocalSite(entry: string): boolean {
  const host = entry.trim().replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').split('/')[0];
  return LOCAL_HOST.test(host);
}

/**
 * 시험용 예시 스킬인지: 다루는 사이트가 모두 이 PC 안(localhost)이거나 태그에 "예시"가 있다.
 * 목업 사이트용 스킬을 개인·팀 폴더에 복사해 두었어도 업무 목록에 섞이지 않게 앱이 따로 둔다.
 */
export function isSampleSkill(d: SkillDoc): boolean {
  if ((d.tags ?? []).includes('예시')) return true;
  const domains = (d.domains ?? []).filter((x) => x !== '*');
  return domains.length > 0 && domains.every(isLocalSite);
}

/** 지금 화면 주소가 스킬이 다루는 사이트인지 */
export function skillCoversUrl(d: SkillDoc, url: string | undefined): boolean {
  if (!url || !d.domains?.length) return false;
  try {
    return /^https?:$/.test(new URL(url).protocol) && hostAllowed(url, d.domains);
  } catch {
    return false;
  }
}

/**
 * 말로 스킬을 찾는다. 맞는 순서로 돌려준다.
 * query가 비면 모두를 돌려주되 지금 화면의 사이트를 다루는 스킬을 앞에 둔다.
 * 사이트가 맞으면 점수를 조금 더 준다 (같은 말이면 지금 화면의 스킬이 앞).
 */
export function searchSkills<T>(items: T[], toDoc: (t: T) => SkillDoc, query: string, opts: { url?: string; limit?: number } = {}): SearchHit<T>[] {
  const words = terms(query);
  const grams = bigrams(words.join(' '));
  const hits: SearchHit<T>[] = [];
  for (const item of items) {
    const d = toDoc(item);
    const site = skillCoversUrl(d, opts.url);
    if (!words.length) {
      hits.push({ item, score: site ? 1 : 0, site });
      continue;
    }
    // 낱말의 절반 넘게 나와야 한다 (낱말이 하나면 그것이 나와야 함)
    const cover = coverage(d, words);
    if (cover <= 0.5) continue;
    hits.push({ item, score: score(d, words, grams) * cover + (site ? 2 : 0), site });
  }
  hits.sort((a, b) => b.score - a.score || Number(b.site) - Number(a.site) || toDoc(a.item).name.localeCompare(toDoc(b.item).name));
  return opts.limit ? hits.slice(0, opts.limit) : hits;
}

/**
 * 요청을 해석할 모델에 보여 줄 스킬을 고른다. 스킬이 많으면 모두 보여 주면 프롬프트가 길어지므로,
 * 말이 맞는 것과 지금 화면의 사이트를 다루는 것을 limit개까지 고른다. 적으면 그대로 다 준다.
 */
export function shortlistSkills<T>(items: T[], toDoc: (t: T) => SkillDoc, request: string, opts: { url?: string; limit?: number } = {}): T[] {
  const limit = opts.limit ?? 20;
  if (items.length <= limit) return items;
  const picked = new Set<T>(searchSkills(items, toDoc, request, { url: opts.url, limit }).map((h) => h.item));
  for (const item of items) {
    if (picked.size >= limit) break;
    if (skillCoversUrl(toDoc(item), opts.url)) picked.add(item);
  }
  return items.filter((i) => picked.has(i));
}
