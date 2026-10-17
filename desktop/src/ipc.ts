// 메인 프로세스 ↔ 창 사이에 오가는 메시지 모양. 양쪽이 같이 쓴다.
import type { BrowserLink } from '../../bridge/hub.mjs';
import type { ApprovalRequest, RunEvent, RunResult } from '../../src/core';

export type UiMessage =
  | { kind: 'print'; text: string }
  /** 묻기. confirm이면 y/n, text면 글 (fallback은 빈 답일 때 쓸 값) */
  | { kind: 'ask'; id: number; mode: 'text' | 'confirm'; question: string; fallback: string }
  | { kind: 'ask-closed'; id: number }
  | { kind: 'started'; skill: string; page: string }
  | { kind: 'run'; event: RunEvent }
  | { kind: 'approval'; request: ApprovalRequest }
  | { kind: 'result'; result: RunResult; saved: string[] }
  | { kind: 'busy'; busy: boolean }
  | { kind: 'browsers'; browsers: BrowserLink[] };

export interface SkillSummary {
  id: string;
  name: string;
  description: string;
  risk: string;
  source: '개인' | '팀' | '기본';
  inputs: { name: string; label: string; type: string; required: boolean; description: string; values: string[]; default: string }[];
}

export interface InitInfo {
  mode: string;
  version: string;
  config: string;
  skills: SkillSummary[];
  browsers: BrowserLink[];
  options: { allowWrite: boolean; dryRun: boolean };
}

/** 창에서 쓰는 API (preload가 window.dogent로 내놓는다) */
export interface DogentApi {
  init(): Promise<InitInfo>;
  send(text: string): Promise<void>;
  run(id: string, values: Record<string, string>): Promise<void>;
  answer(id: number, value: string | null): Promise<void>;
  stop(): Promise<void>;
  skills(): Promise<SkillSummary[]>;
  browsers(): Promise<BrowserLink[]>;
  selectBrowser(which: string): Promise<void>;
  excelDocs(): Promise<{ name: string; full_name: string; read_only: boolean }[]>;
  show(path: string): Promise<void>;
  options(patch: { allowWrite?: boolean; dryRun?: boolean }): Promise<unknown>;
  token(): Promise<string>;
  /** 확장 연결(Native Messaging 등록) 상태. register를 주면 그 확장 ID도 허용해 등록한다. */
  extension(register?: string): Promise<ExtensionStatus>;
  setConfig(key: string, value: string): Promise<string>;
  onUi(listener: (message: UiMessage) => void): () => void;
}

/** 앱이 브라우저 확장에 연결되는 길(Native Messaging)을 깔아 둔 상태 */
export interface ExtensionStatus {
  /** 등록된 허용 확장 ID */
  ids: string[];
  /** 브라우저 프로필에서 찾은 Dogent 확장 중 아직 등록되지 않은 것 */
  missing: { id: string; browser: string }[];
  /** 방금 등록하다 난 오류 */
  error?: string;
}
