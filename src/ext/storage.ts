import { browser } from 'wxt/browser';
import { dogentConfig } from '@/dogent.config';
import type { LlmSettings } from '../core/llm';
import type { SkillInputs } from '../core/skill';
import type { PathStore, RunEvent, RunResult, SkillPaths } from '../core/types';

const SETTINGS_KEY = 'llmSettings';
const RUNS_KEY = 'runs';
const MAX_RUNS = 50;

/**
 * 빌드에 넣는 모델 접속 정보. 저장소가 아니라 빌드하는 PC의 환경 파일에 적는다.
 * 집(Ollama)은 .env.home.local, 회사(사내 Gemma)는 .env.company.local (.env.home.example, .env.company.example 참고).
 * 이렇게 넣어 두면 설정 화면을 건드리지 않아도 바로 쓸 수 있다.
 */
const env = import.meta.env as Record<string, string | undefined>;
const BUILT_IN = {
  baseUrl: env.WXT_LLM_BASE_URL ?? '',
  apiKey: env.WXT_LLM_API_KEY ?? '',
  model: env.WXT_LLM_MODEL ?? '',
  skillsUrl: env.WXT_SKILLS_URL ?? '',
  jsonMode: env.WXT_LLM_JSON_MODE ? env.WXT_LLM_JSON_MODE.trim().toLowerCase() === 'true' : undefined,
  timeoutScale: Number(env.WXT_LLM_TIMEOUT_SCALE) || undefined,
  // 사내 게이트웨이처럼 Authorization이 아닌 헤더로 키와 사용자를 받는 API용. wxt.config.ts가 빌드할 때 형식을 검사한다.
  headers: parseHeaders(env.WXT_LLM_HEADERS),
  userId: env.WXT_LLM_USER_ID ?? '',
  userType: env.WXT_LLM_USER_TYPE ?? '',
};

function parseHeaders(raw: string | undefined): Record<string, string> | undefined {
  if (!raw?.trim()) return undefined;
  return JSON.parse(raw) as Record<string, string>;
}

/** 빌드에 공용 API 키가 들어 있는지. 들어 있으면 설정 화면에서 키를 묻지 않아도 된다. */
export const hasBuiltInKey = BUILT_IN.apiKey !== '';

/** 빌드에 들어 있는 요청 헤더 틀. 설정 화면이 헤더 이름과 채워야 할 칸을 보여 줄 때 쓴다. */
export const builtInHeaders = BUILT_IN.headers;

/** 이 빌드의 기본 설정: 개발 기본값 위에 환경 파일의 값을 얹는다. 공용 키와 헤더 틀은 넣지 않는다. */
function buildDefaults(): LlmSettings {
  const d: LlmSettings = { ...dogentConfig.llmDefaults };
  if (BUILT_IN.baseUrl) d.baseUrl = BUILT_IN.baseUrl;
  if (BUILT_IN.model) d.model = BUILT_IN.model;
  if (BUILT_IN.jsonMode !== undefined) d.jsonMode = BUILT_IN.jsonMode;
  if (BUILT_IN.timeoutScale) d.timeoutScale = BUILT_IN.timeoutScale;
  if (BUILT_IN.userId) d.userId = BUILT_IN.userId;
  if (BUILT_IN.userType) d.userType = BUILT_IN.userType;
  return d;
}

/**
 * 저장소에는 사용자가 기본값과 다르게 바꾼 값만 남는다. 그래서 다시 빌드하면 바꾸지 않은 칸은 새 빌드의 값을 따른다.
 * 예전 버전은 설정 전체를 저장했으므로, 개발 기본값과 같은 값은 사용자가 고른 것이 아니라고 보고 버린다.
 */
export async function loadSettings(): Promise<LlmSettings> {
  const stored = { ...((await browser.storage.local.get(SETTINGS_KEY))[SETTINGS_KEY] as Partial<LlmSettings> | undefined) };
  const dev = dogentConfig.llmDefaults as Record<string, unknown>;
  for (const key of Object.keys(stored) as (keyof LlmSettings)[]) if (key in dev && stored[key] === dev[key]) delete stored[key];
  delete stored.headers;
  const merged = { ...buildDefaults(), ...stored };
  // 저장소 주소는 비워 저장했더라도 배포에 든 주소가 있으면 그것을 쓴다.
  return { ...merged, skillsUrl: merged.skillsUrl || BUILT_IN.skillsUrl };
}

/**
 * 모델을 부를 때 쓰는 설정. 사용자가 키를 따로 넣지 않았으면 빌드에 든 공용 키를 쓴다.
 * 공용 키는 설정 화면에 보이지 않고 브라우저 저장소에도 복사되지 않는다.
 */
export function effectiveSettings(settings: LlmSettings): LlmSettings {
  const withKey = settings.apiKey ? settings : { ...settings, apiKey: BUILT_IN.apiKey };
  return BUILT_IN.headers ? { ...withKey, headers: BUILT_IN.headers } : withKey;
}

export async function saveSettings(settings: LlmSettings): Promise<void> {
  const defaults = buildDefaults() as unknown as Record<string, unknown>;
  const changed = Object.fromEntries(
    Object.entries(settings).filter(([key, value]) => key !== 'headers' && value !== (defaults[key] ?? (key === 'apiKey' || key === 'userId' || key === 'userType' ? '' : undefined))),
  );
  await browser.storage.local.set({ [SETTINGS_KEY]: changed });
}

/** 설정 화면에서 바꾼 값을 모두 지우고 이 빌드의 기본값으로 돌아간다. */
export async function resetSettings(): Promise<LlmSettings> {
  await browser.storage.local.remove(SETTINGS_KEY);
  return loadSettings();
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

export async function clearRuns(): Promise<void> {
  await browser.storage.local.remove(RUNS_KEY);
}

export async function appendRun(record: RunRecord): Promise<void> {
  const runs = await loadRuns();
  await browser.storage.local.set({ [RUNS_KEY]: [...runs, record].slice(-MAX_RUNS) });
}
