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
