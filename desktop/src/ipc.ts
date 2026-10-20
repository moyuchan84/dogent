// 메인 프로세스 ↔ 창 사이에 오가는 메시지 모양. 양쪽이 같이 쓴다.
import type { BrowserLink } from '../../bridge/hub.mjs';
import type { ApprovalRequest, RunEvent, RunResult } from '../../src/core';
import type { ProbeResult, ServerRow } from '../../client/src/connectors';
import type { Permission } from '../../client/src/mcp-hub';

export type { ProbeResult, ServerRow, ToolRow } from '../../client/src/connectors';
export type { Permission };

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
  | { kind: 'browsers'; browsers: BrowserLink[] }
  /** 스킬 목록이 바뀜 (팀 스킬 저장소를 받아 옴) */
  | { kind: 'skills' };

export interface SkillSummary {
  id: string;
  name: string;
  description: string;
  risk: string;
  source: '개인' | '팀' | '기본';
  owner: string;
  tags: string[];
  domains: string[];
  /** 이 PC의 실행 기록 (없으면 아직 실행하지 않음) */
  stats?: { runs: number; rate: number | null; broken: boolean };
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
/** 왼쪽 시스템 목록의 한 줄 */
export interface SystemSummary {
  id: string;
  name: string;
  description: string;
  aliases: string[];
  url: string;
  source: '개인' | '팀' | '기본';
  /** 이 시스템의 사이트를 다루는 스킬 수 */
  skills: number;
}

/** 커넥터 붙여 넣기의 미리보기: 무엇을 더하게 되는지 */
export type ConnectPreview =
  | { kind: 'mcp'; servers: ServerRow[]; replaces: string[]; scope?: string }
  | { kind: 'skill'; url: string; agent?: string };

export interface DogentApi {
  init(): Promise<InitInfo>;
  send(text: string): Promise<void>;
  run(id: string, values: Record<string, string>): Promise<void>;
  answer(id: number, value: string | null): Promise<void>;
  stop(): Promise<void>;
  skills(): Promise<SkillSummary[]>;
  systems(): Promise<SystemSummary[]>;
  /** 지금 브라우저 탭 (확장이 붙어 있지 않으면 null) */
  page(): Promise<{ url: string; title: string } | null>;
  browsers(): Promise<BrowserLink[]>;
  selectBrowser(which: string): Promise<void>;
  excelDocs(): Promise<{ name: string; full_name: string; read_only: boolean }[]>;
  show(path: string): Promise<void>;
  options(patch: { allowWrite?: boolean; dryRun?: boolean }): Promise<unknown>;
  token(): Promise<string>;
  /** 확장 연결(Native Messaging 등록) 상태. register를 주면 그 확장 ID도 허용해 등록한다. */
  extension(register?: string): Promise<ExtensionStatus>;
  setConfig(key: string, value: string): Promise<string>;
  /** 커넥터(MCP 서버) */
  connectors(): Promise<ServerRow[]>;
  /** 붙여 넣은 글을 읽어 무엇을 더할지 보여 준다 (아직 저장하지 않는다) */
  connectPreview(text: string): Promise<ConnectPreview>;
  /** 미리보기대로 저장하고 연결을 시험한다 */
  connectAdd(text: string): Promise<ProbeResult[]>;
  connectProbe(name: string): Promise<ProbeResult>;
  connectPatch(name: string, patch: { disabled?: boolean; keywords?: string[]; permission?: { tool: string; value: Permission | 'default' } }): Promise<ServerRow[]>;
  connectRemove(name: string): Promise<ServerRow[]>;
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
