import { browser } from 'wxt/browser';
import { dogentConfig } from '@/dogent.config';
import type { LlmSettings } from '../core/llm';
import type { SkillInputs } from '../core/skill';
import type { RunEvent, RunResult } from '../core/types';

const SETTINGS_KEY = 'llmSettings';
const RUNS_KEY = 'runs';
const MAX_RUNS = 50;

export async function loadSettings(): Promise<LlmSettings> {
  const stored = (await browser.storage.local.get(SETTINGS_KEY))[SETTINGS_KEY] as Partial<LlmSettings> | undefined;
  return { ...dogentConfig.llmDefaults, ...stored };
}

export async function saveSettings(settings: LlmSettings): Promise<void> {
  await browser.storage.local.set({ [SETTINGS_KEY]: settings });
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
