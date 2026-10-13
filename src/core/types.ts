export type Cell = string | number;

export interface Dataset {
  name: string;
  columns: string[];
  rows: Cell[][];
}

export interface TableData {
  columns: string[];
  rows: string[][];
}

export type SnapshotItem =
  | { kind: 'frame'; url: string }
  | { kind: 'heading'; text: string }
  | { kind: 'text'; text: string }
  | {
      kind: 'el';
      ref: number;
      role: string;
      name: string;
      value?: string;
      detail?: string;
      disabled?: boolean;
    };

export type ElementItem = Extract<SnapshotItem, { kind: 'el' }>;

/** 한 프레임에서 페이지 에이전트가 돌려주는 원본 스냅샷. ref는 프레임 안에서만 유일하다. */
export interface FrameSnapshot {
  url: string;
  title: string;
  hasPassword: boolean;
  truncated: boolean;
  items: SnapshotItem[];
}

/** 모든 프레임을 합친 스냅샷. ref는 탭 전체에서 유일하다. */
export interface PageSnapshot {
  url: string;
  title: string;
  hasPassword: boolean;
  items: SnapshotItem[];
}

export interface ActResult {
  ok: boolean;
  message: string;
}

export interface BrowserPort {
  snapshot(): Promise<PageSnapshot>;
  navigate(url: string): Promise<ActResult>;
  click(ref: number): Promise<ActResult>;
  type(ref: number, text: string): Promise<ActResult>;
  select(ref: number, value: string): Promise<ActResult>;
  waitFor(text: string, timeoutMs: number): Promise<boolean>;
  extractTable(ref: number): Promise<TableData>;
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface LlmPort {
  complete(messages: ChatMessage[], signal?: AbortSignal): Promise<string>;
}

export interface UiPort {
  ask(question: string): Promise<string>;
}

export interface FilePort {
  save(filename: string, data: ArrayBuffer): Promise<void>;
}

export type RunStatus = 'done' | 'aborted' | 'stopped' | 'error';

export interface HistoryEntry {
  n: number;
  step: number;
  tool: string;
  args: Record<string, unknown>;
  thought: string;
  ok: boolean;
  result: string;
}

export type RunEvent =
  | { type: 'observe'; n: number; url: string; title: string }
  | { type: 'llm_retry'; n: number; reason: string }
  | { type: 'blocked'; n: number; tool: string; reason: string }
  | { type: 'action'; entry: HistoryEntry }
  | { type: 'step_done'; step: number }
  | { type: 'end'; status: RunStatus; message: string };

export interface DatasetInfo {
  name: string;
  columns: string[];
  rowCount: number;
}

export interface RunResult {
  status: RunStatus;
  message: string;
  lastStep: number;
  actions: number;
  files: string[];
  datasets: DatasetInfo[];
  elapsedMs: number;
}
