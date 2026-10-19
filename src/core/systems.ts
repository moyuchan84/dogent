import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { searchSkills, skillCoversUrl, type SkillDoc } from './catalog';

/**
 * 시스템 사전. 사내 시스템이 무엇이고 어디에 있고 어떻게 쓰는지를 적은 문서(SYSTEM.md)다.
 *
 * 모델은 "구글"은 알지만 "재공 시스템"은 모른다. 스킬이 업무 하나의 절차라면, 시스템 문서는 그 시스템 전체에 대한 설명이다:
 * 별칭, 주소, 화면(메뉴 경로), 사내 용어, 주의사항. 요청에 시스템 이름이 나오면 이 문서를 찾아 모델에 함께 보여 준다.
 *
 *   <스킬 폴더>/systems/<id>/SYSTEM.md
 *
 * 브라우저 API와 Node API를 쓰지 않는다 (앱의 화면 코드도 이 파일을 쓴다).
 */
const SystemMeta = z.object({
  id: z.string().regex(/^[a-z][a-z0-9-]*$/),
  name: z.string().min(1),
  /** 이 시스템이 무엇인지 한두 문장 */
  description: z.string().min(1),
  /** 사람들이 이 시스템을 부르는 말. 요청에서 시스템을 찾는 데 쓴다 (예: 재공, WIP) */
  aliases: z.array(z.string().min(1)).default([]),
  /** 처음 여는 주소 */
  url: z.url().refine((u) => /^https?:/.test(u), 'http(s) 주소여야 합니다'),
  /** 이 시스템의 사이트. 비우면 url의 호스트 */
  domains: z.array(z.string().min(1)).default([]),
  owner: z.string().min(1),
  /** 로그인 방식과 알아 둘 점 (예: 사내 SSO, 처음 열면 로그인 창이 뜸) */
  login: z.string().optional(),
  screens: z
    .array(
      z.object({
        name: z.string().min(1),
        /** 메뉴 경로 (예: 재공 > 재공 조회) */
        path: z.string().optional(),
        purpose: z.string().optional(),
        /** 화면 주소를 알면 */
        url: z.string().optional(),
      }),
    )
    .default([]),
  /** 사내 용어와 뜻 (예: HOLD: 공정 진행을 멈춘 Lot) */
  terms: z.record(z.string(), z.string()).default({}),
});

export interface System extends z.infer<typeof SystemMeta> {
  /** 주의사항 등 자유롭게 적은 본문 */
  notes: string;
}

export function parseSystem(source: string): System {
  const m = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(source.replace(/\r\n/g, '\n').replace(/^﻿/, ''));
  if (!m) throw new Error('시스템 선언부(--- 로 감싼 YAML)를 찾을 수 없습니다');
  const parsed = SystemMeta.safeParse(parseYaml(m[1]));
  if (!parsed.success) throw new Error(`시스템 선언부 오류:\n${z.prettifyError(parsed.error)}`);
  const domains = parsed.data.domains.length ? parsed.data.domains : [new URL(parsed.data.url).host];
  return { ...parsed.data, domains, notes: m[2].trim() };
}

/** 스킬 찾기와 같은 글자 검색을 쓰기 위한 모양. 별칭은 태그로, 화면 이름과 용어는 설명으로 친다. */
export const docOfSystem = (s: System): SkillDoc => ({
  id: s.id,
  name: s.name,
  description: [s.description, ...s.screens.map((x) => x.name), ...Object.keys(s.terms)].join(' '),
  owner: s.owner,
  tags: s.aliases,
  domains: s.domains,
});

const norm = (t: string) => t.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

/**
 * 말에 맞는 시스템을 맞는 순서로 돌려준다. 맞는 것이 없으면 빈 목록.
 * "재공 시스템 들어가서 8라인 홀드 걸린 거 보여줘"처럼 긴 요청에서 시스템 이름은 일부이므로,
 * 먼저 별칭·이름이 요청에 그대로 나오는지 보고(긴 별칭이 우선), 없으면 스킬 찾기와 같은 글자 검색을 쓴다.
 */
export function searchSystems(systems: System[], query: string, limit = 3): System[] {
  const text = ` ${norm(query)} `;
  if (text.trim() === '') return [];
  const direct = systems
    .map((s) => {
      const names = [...s.aliases, s.name, s.id.replace(/-/g, ' ')].map(norm).filter((n) => n.length >= 2);
      // 낱말 경계 없이 포함이면 맞는 것으로 본다 (조사가 붙어도: "재공시스템에서")
      const best = Math.max(0, ...names.filter((n) => text.includes(n)).map((n) => n.length));
      return { s, best };
    })
    .filter((x) => x.best > 0)
    .sort((a, b) => b.best - a.best);
  if (direct.length) return direct.slice(0, limit).map((x) => x.s);
  return searchSkills(systems, docOfSystem, query, { limit }).map((h) => h.item);
}

/** 이 주소(지금 화면)가 속한 시스템 */
export function systemForUrl(systems: System[], url: string | undefined): System | undefined {
  return systems.find((s) => skillCoversUrl(docOfSystem(s), url));
}

/**
 * 모델에게 보여 줄 시스템 설명. 프롬프트가 길어지지 않게 화면 20개, 용어 30개, 본문 1200자까지만 싣는다.
 */
export function describeSystem(s: System): string {
  const lines = [`### ${s.name}${s.aliases.length ? ` (${s.aliases.join(', ')})` : ''}`, s.description, `주소: ${s.url} · 담당: ${s.owner}`];
  if (s.login) lines.push(`로그인: ${s.login}`);
  if (s.screens.length) {
    lines.push('화면:');
    for (const x of s.screens.slice(0, 20)) lines.push(`- ${x.name}${x.path ? ` [${x.path}]` : ''}${x.purpose ? `: ${x.purpose}` : ''}${x.url ? ` (${x.url})` : ''}`);
  }
  const terms = Object.entries(s.terms).slice(0, 30);
  if (terms.length) {
    lines.push('용어:');
    for (const [k, v] of terms) lines.push(`- ${k}: ${v}`);
  }
  if (s.notes) lines.push(s.notes.length > 1200 ? `${s.notes.slice(0, 1200)}…` : s.notes);
  return lines.join('\n');
}

/** 시스템 문서의 품질 점검. 오류가 있으면 쓰지 않는다. */
export function lintSystem(source: string): { system?: System; errors: string[]; warnings: string[] } {
  let system: System;
  try {
    system = parseSystem(source);
  } catch (e) {
    return { errors: [(e as Error).message], warnings: [] };
  }
  const warnings: string[] = [];
  if (!system.aliases.length) warnings.push('aliases(부르는 말)가 없습니다. 사람들이 쓰는 이름을 적어야 요청에서 찾힙니다');
  if (!system.screens.length) warnings.push('screens(화면)가 없습니다. 메뉴 경로를 적으면 모델이 화면을 찾아갑니다');
  if (!Object.keys(system.terms).length) warnings.push('terms(용어)가 없습니다');
  return { system, errors: [], warnings };
}
