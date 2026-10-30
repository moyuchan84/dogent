import { docOfSkill, shortlistSkills } from './catalog';
import { pickSkill, planOneShot, planRequest, type Plan } from './planner';
import { parseSkill, type Skill } from './skill';
import type { ChatMessage, LlmPort } from './types';

/**
 * 스킬 고르기 시험 (dogent eval pick).
 *
 * 같은 요청을 고르는 방식만 바꿔 모델에 물어, 모델에게 스킬 선택을 얼마나 맡길 수 있는지 잰다.
 * - current: 지금 제품의 경로. 코드가 후보를 줄이고(shortlistSkills) planRequest가 고른다
 * - one-shot: 코드가 줄이지 않고, 모든 스킬의 입력 설명까지 한 번에 보여 주고 고르기와 값 뽑기를 함께 묻는다
 * - index: Claude Code처럼 색인(이름과 설명 한 줄)만 보여 주고 모델이 고른 뒤, 그 스킬의 입력만 보고 값을 뽑는다
 */
export type PickStrategy = 'current' | 'one-shot' | 'index';
export const PICK_STRATEGIES: PickStrategy[] = ['current', 'one-shot', 'index'];

export interface PickCase {
  request: string;
  /** 기대하는 스킬 id. 맞는 스킬이 없어야 하면 null */
  expect: string | null;
  /** 방해 스킬을 섞었을 때의 기대값이 다르면 적는다 (예: 섞은 목록에만 있는 스킬) */
  with_distractors?: string | null;
  /** 맞았다고 볼 입력값. 적은 것만 비교한다 (글자 그대로, 앞뒤 공백 무시) */
  inputs?: Record<string, string | number>;
}

export interface PickTrial {
  request: string;
  strategy: PickStrategy;
  /** 모델에 보인 스킬 수 (current는 줄이기 전 수) */
  catalog: number;
  distractors: boolean;
  expect: string | null;
  got: string | null;
  skillOk: boolean;
  /** 기대 입력값이 있고 스킬을 맞혔을 때만 */
  inputsOk?: boolean;
  /** 틀린 입력값: 이름 → [기대, 받은 값] */
  wrongInputs?: Record<string, [string, string]>;
  /** 모델 답을 읽지 못했거나 호출이 실패했을 때 */
  error?: string;
  calls: number;
  /** 모델에 보낸 글자 수 (시스템 + 사용자) */
  chars: number;
  ms: number;
}

export interface PickEvalOptions {
  cases: PickCase[];
  skills: Skill[];
  llm: LlmPort;
  strategies?: PickStrategy[];
  /** 주면 이 스킬들을 섞은 목록으로 한 번 더 잰다 */
  distractors?: Skill[];
  /** 같은 문항을 몇 번 물을지. 온도 0이어도 게이트웨이에 따라 답이 흔들릴 수 있다 */
  repeat?: number;
  signal?: AbortSignal;
  onTrial?: (t: PickTrial) => void;
}

const same = (a: unknown, b: unknown) => String(a ?? '').trim() === String(b ?? '').trim();

async function plan(strategy: PickStrategy, request: string, skills: Skill[], llm: LlmPort, signal?: AbortSignal): Promise<Plan> {
  if (strategy === 'current') return planRequest(request, shortlistSkills(skills, docOfSkill, request), llm, signal);
  if (strategy === 'one-shot') return planOneShot(request, skills, llm, signal);
  const choice = await pickSkill(request, skills, llm, signal);
  const one = skills.find((s) => s.id === choice.skill_id);
  if (!one) return { skill_id: null, inputs: {}, reason: choice.skill_id ? `없는 스킬(${choice.skill_id})` : choice.reason };
  return planOneShot(request, [one], llm, signal);
}

/** 문항 × 방식 × (기본 목록, 방해 스킬을 섞은 목록) × 반복 횟수만큼 모델에 묻는다. 차례로 묻는다 (게이트웨이 한도) */
export async function runPickEval(opts: PickEvalOptions): Promise<PickTrial[]> {
  const strategies = opts.strategies ?? PICK_STRATEGIES;
  const catalogs: { skills: Skill[]; distractors: boolean }[] = [{ skills: opts.skills, distractors: false }];
  if (opts.distractors?.length) {
    const ids = new Set(opts.skills.map((s) => s.id));
    catalogs.push({ skills: [...opts.skills, ...opts.distractors.filter((d) => !ids.has(d.id))], distractors: true });
  }
  const trials: PickTrial[] = [];
  for (const catalog of catalogs) {
    for (const c of opts.cases) {
      const expect = catalog.distractors && c.with_distractors !== undefined ? c.with_distractors : c.expect;
      for (const strategy of strategies) {
        for (let r = 0; r < (opts.repeat ?? 1); r++) {
          opts.signal?.throwIfAborted();
          let calls = 0;
          let chars = 0;
          const counted: LlmPort = {
            complete: (m: ChatMessage[], s?: AbortSignal) => {
              calls++;
              chars += m.reduce((n, x) => n + x.content.length, 0);
              return opts.llm.complete(m, s);
            },
          };
          const started = Date.now();
          const t: PickTrial = { request: c.request, strategy, catalog: catalog.skills.length, distractors: catalog.distractors, expect, got: null, skillOk: false, calls: 0, chars: 0, ms: 0 };
          try {
            const p = await plan(strategy, c.request, catalog.skills, counted, opts.signal);
            t.got = p.skill_id;
            t.skillOk = p.skill_id === expect;
            if (t.skillOk && c.inputs && expect) {
              const wrong: Record<string, [string, string]> = {};
              for (const [k, v] of Object.entries(c.inputs)) if (!same(p.inputs[k], v)) wrong[k] = [String(v), String(p.inputs[k] ?? '(없음)')];
              t.inputsOk = Object.keys(wrong).length === 0;
              if (!t.inputsOk) t.wrongInputs = wrong;
            }
          } catch (e) {
            if (opts.signal?.aborted) throw e;
            t.error = (e as Error).message;
          }
          Object.assign(t, { calls, chars, ms: Date.now() - started });
          trials.push(t);
          opts.onTrial?.(t);
        }
      }
    }
  }
  return trials;
}

export interface PickSummaryRow {
  strategy: PickStrategy;
  distractors: boolean;
  catalog: number;
  n: number;
  /** 스킬을 맞힌 비율 */
  skill: number;
  /** 맞는 스킬이 없어야 하는 문항에서 null을 고른 비율 (그런 문항이 없으면 undefined) */
  none?: number;
  /** 스킬을 맞히고 입력값까지 맞힌 비율 (입력값을 적은 문항 기준) */
  inputs?: number;
  /** 답을 읽지 못한 비율 */
  errors: number;
  chars: number;
  calls: number;
  ms: number;
}

const ratio = (xs: boolean[]) => (xs.length ? xs.filter(Boolean).length / xs.length : undefined);
const avg = (xs: number[]) => (xs.length ? Math.round(xs.reduce((a, b) => a + b, 0) / xs.length) : 0);

export function summarizePick(trials: PickTrial[]): PickSummaryRow[] {
  const groups = new Map<string, PickTrial[]>();
  for (const t of trials) {
    const key = `${t.distractors}|${t.strategy}`;
    groups.set(key, [...(groups.get(key) ?? []), t]);
  }
  return [...groups.values()].map((g) => ({
    strategy: g[0].strategy,
    distractors: g[0].distractors,
    catalog: g[0].catalog,
    n: g.length,
    skill: ratio(g.map((t) => t.skillOk)) ?? 0,
    none: ratio(g.filter((t) => t.expect === null).map((t) => t.skillOk)),
    inputs: ratio(g.filter((t) => t.inputsOk !== undefined).map((t) => t.inputsOk === true)),
    errors: ratio(g.map((t) => t.error !== undefined)) ?? 0,
    chars: avg(g.map((t) => t.chars)),
    calls: Math.round((g.reduce((a, t) => a + t.calls, 0) / g.length) * 10) / 10,
    ms: avg(g.map((t) => t.ms)),
  }));
}

/** 한글은 터미널에서 두 칸을 차지한다 */
const padWide = (s: string, n: number) => s + ' '.repeat(Math.max(0, n - [...s].reduce((w, ch) => w + (ch.charCodeAt(0) > 0x1100 ? 2 : 1), 0)));
const pct = (x: number | undefined) => (x === undefined ? '   -' : `${Math.round(x * 100)}%`.padStart(4));

/** 터미널에 찍을 표 */
export function formatPickSummary(rows: PickSummaryRow[]): string[] {
  const lines = [`${padWide('목록', 14)}  방식       문항  스킬  없음  입력  오류  글자/문항  호출  시간(ms)`];
  for (const r of rows) {
    const where = padWide(`${r.distractors ? '방해 포함' : '기본'} ${r.catalog}개`, 14);
    lines.push(
      `${where}  ${r.strategy.padEnd(9)}  ${String(r.n).padStart(4)}  ${pct(r.skill)}  ${pct(r.none)}  ${pct(r.inputs)}  ${pct(r.errors)}  ${String(r.chars).padStart(9)}  ${String(r.calls).padStart(4)}  ${String(r.ms).padStart(8)}`,
    );
  }
  lines.push('스킬: 맞는 스킬(또는 없음)을 고른 비율 · 없음: 맞는 스킬이 없는 문항에서 고르지 않은 비율 · 입력: 스킬을 맞힌 문항 중 입력값까지 맞힌 비율 · 오류: 답을 읽지 못한 비율');
  return lines;
}

/** 시험 문항 파일(JSON 배열)을 검사해 읽는다 */
export function parsePickCases(text: string): PickCase[] {
  const data = JSON.parse(text) as unknown;
  if (!Array.isArray(data)) throw new Error('시험 문항 파일은 JSON 배열이어야 합니다: [{"request": "...", "expect": "스킬id 또는 null"}]');
  return data.map((c, i) => {
    if (typeof c?.request !== 'string' || !('expect' in c) || !(c.expect === null || typeof c.expect === 'string')) {
      throw new Error(`${i + 1}번 문항에 request(글)와 expect(스킬 id 또는 null)가 필요합니다`);
    }
    return c as PickCase;
  });
}

/** 방해 스킬 하나를 만든다. 고르기 시험에만 쓰므로 단계는 형식만 갖춘다 */
export function fakeSkill(id: string, name: string, description: string, inputs: { name: string; label: string }[] = []): Skill {
  const meta = { id, name, description, version: '0.0.1', owner: '시험용', risk: 'R1', domains: ['eval.invalid'], inputs: inputs.map((i) => ({ ...i, type: 'string' })) };
  return parseSkill(`---\n${JSON.stringify(meta)}\n---\n## 단계\n1. 화면을 연다.\n`);
}
