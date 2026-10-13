import { browser } from 'wxt/browser';
import { dogentConfig } from '@/dogent.config';
import type { LlmSettings } from '../core/llm';
import type { SkillInputs } from '../core/skill';
import type { PathStore, RunEvent, RunResult, SkillPaths } from '../core/types';

const SETTINGS_KEY = 'llmSettings';
const RUNS_KEY = 'runs';
const MAX_RUNS = 50;

/**
 * 배포할 때 빌드에 넣는 모델 접속 정보. 저장소가 아니라 빌드하는 PC의 .env.local에 적는다 (.env.example 참고).
 * 공용 키를 쓰는 환경에서는 사용자가 설정을 입력하지 않아도 바로 쓸 수 있다.
 */
const BUILT_IN = {
  baseUrl: (import.meta.env.WXT_LLM_BASE_URL as string | undefined) ?? '',
  apiKey: (import.meta.env.WXT_LLM_API_KEY as string | undefined) ?? '',
  model: (import.meta.env.WXT_LLM_MODEL as string | undefined) ?? '',
};

/** 빌드에 공용 API 키가 들어 있는지. 들어 있으면 설정 화면에서 키를 묻지 않아도 된다. */
export const hasBuiltInKey = BUILT_IN.apiKey !== '';

export async function loadSettings(): Promise<LlmSettings> {
  const stored = (await browser.storage.local.get(SETTINGS_KEY))[SETTINGS_KEY] as Partial<LlmSettings> | undefined;
  return {
    ...dogentConfig.llmDefaults,
    ...(BUILT_IN.baseUrl ? { baseUrl: BUILT_IN.baseUrl } : {}),
    ...(BUILT_IN.model ? { model: BUILT_IN.model } : {}),
    ...stored,
  };
}

/**
 * 모델을 부를 때 쓰는 설정. 사용자가 키를 따로 넣지 않았으면 빌드에 든 공용 키를 쓴다.
 * 공용 키는 설정 화면에 보이지 않고 브라우저 저장소에도 복사되지 않는다.
 */
export function effectiveSettings(settings: LlmSettings): LlmSettings {
  return settings.apiKey ? settings : { ...settings, apiKey: BUILT_IN.apiKey };
}

export async function saveSettings(settings: LlmSettings): Promise<void> {
  await browser.storage.local.set({ [SETTINGS_KEY]: settings });
}

const PATHS_KEY = 'skillPaths';
const MAX_PATH_KEYS = 100;

/**
 * 성공한 경로의 보관소. 이 PC의 브라우저에만 남는다.
 * 키에 스킬의 버전과 본문이 들어 있어, 스킬을 고치면 예전 경로는 쓰이지 않고 오래된 것부터 밀려난다.
 */
export const pathStore: PathStore = {
  async load(key) {
    const all = (await browser.storage.local.get(PATHS_KEY))[PATHS_KEY] as Record<string, SkillPaths> | undefined;
    return all?.[key] ?? null;
  },
  async save(key, paths) {
    const all = ((await browser.storage.local.get(PATHS_KEY))[PATHS_KEY] as Record<string, SkillPaths> | undefined) ?? {};
    delete all[key];
    all[key] = paths;
    const keys = Object.keys(all);
    for (const old of keys.slice(0, Math.max(0, keys.length - MAX_PATH_KEYS))) delete all[old];
    await browser.storage.local.set({ [PATHS_KEY]: all });
  },
};

export async function clearPaths(): Promise<void> {
  await browser.storage.local.remove(PATHS_KEY);
}

const DRAFTS_KEY = 'draftSkills';

/**
 * 이 PC에서 만든 스킬 초안. 만든 사람만 쓸 수 있고, 배포하려면 Git 검토를 거쳐 번들에 넣는다.
 * trial은 지금 내용으로 시험 실행을 끝까지 통과한 기록이다. 내용을 고치면 지워진다.
 */
export interface DraftSkill {
  id: string;
  source: string;
  savedAt: string;
  trial?: { at: string; status: string };
}

export async function loadDrafts(): Promise<DraftSkill[]> {
  return ((await browser.storage.local.get(DRAFTS_KEY))[DRAFTS_KEY] as DraftSkill[] | undefined) ?? [];
}

export async function saveDraft(id: string, source: string): Promise<void> {
  const drafts = await loadDrafts();
  const prev = drafts.find((d) => d.id === id);
  const next: DraftSkill = {
    id,
    source,
    savedAt: new Date().toISOString(),
    trial: prev?.source === source ? prev.trial : undefined,
  };
  await browser.storage.local.set({ [DRAFTS_KEY]: [...drafts.filter((d) => d.id !== id), next] });
}

export async function deleteDraft(id: string): Promise<void> {
  await browser.storage.local.set({ [DRAFTS_KEY]: (await loadDrafts()).filter((d) => d.id !== id) });
}

export async function markTrial(id: string, status: string): Promise<void> {
  const drafts = await loadDrafts();
  await browser.storage.local.set({
    [DRAFTS_KEY]: drafts.map((d) => (d.id === id ? { ...d, trial: { at: new Date().toISOString(), status } } : d)),
  });
}

/** 감사 로그 한 건. 표 데이터 자체는 담지 않고 동작과 결과 요약만 남긴다. */
export interface RunRecord {
  id: string;
  startedAt: string;
  skill: { id: string; version: string };
  inputs: SkillInputs;
  tabUrl: string;
  events: RunEvent[];
  result: RunResult;
}

export async function loadRuns(): Promise<RunRecord[]> {
  return ((await browser.storage.local.get(RUNS_KEY))[RUNS_KEY] as RunRecord[] | undefined) ?? [];
}

export async function appendRun(record: RunRecord): Promise<void> {
  const runs = await loadRuns();
  await browser.storage.local.set({ [RUNS_KEY]: [...runs, record].slice(-MAX_RUNS) });
}
