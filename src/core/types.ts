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
      /** 표 안의 요소면 그 행의 글자 ("칸 | 칸") */
      row?: string;
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
  /** 직전에 읽은 뒤로 페이지가 띄운 창 (동작 결과로 이미 돌려준 것은 빠진다) */
  dialogs?: PageDialog[];
}

/**
 * 사람이 화면에서 한 조작 하나. 스킬 초안을 만들 때 녹화한다.
 * dup은 같은 이름의 요소가 화면에 여럿 있어 이름만으로 특정할 수 없다는 뜻이다.
 */
export type RecordedEvent =
  | { kind: 'click'; role: string; name: string; dup: boolean; row?: string }
  | { kind: 'type'; name: string; value: string; dup: boolean; multiline: boolean; numeric: boolean }
  | { kind: 'select'; name: string; value: string; options: string[]; dup: boolean };

/** 페이지가 띄운 알림·확인·입력 창 하나. accepted는 확인을 누른 것으로 답했는지다. */
export interface PageDialog {
  kind: 'alert' | 'confirm' | 'prompt';
  message: string;
  accepted: boolean;
}

/** 확인 창에 답하는 방법. accept여도 메시지가 unless(정규식)에 걸리면 취소한다. */
export interface ConfirmPolicy {
  accept: boolean;
  unless?: string;
}

export interface ActResult {
  ok: boolean;
  message: string;
  /** 이 동작 뒤에 페이지가 띄운 창. 실제로 띄우지 않고 내용만 받아 둔 것이다. */
  dialogs?: PageDialog[];
}

/** 화면의 내려받기 버튼으로 받은 파일. url은 파일이 온 주소로, 페이지가 만든 파일이면 blob: 또는 data: 로 시작한다. */
export interface DownloadedFile {
  filename: string;
  url: string;
  data: ArrayBuffer;
}

export interface BrowserPort {
  snapshot(): Promise<PageSnapshot>;
  navigate(url: string): Promise<ActResult>;
  /**
   * confirm은 누른 뒤 뜨는 확인 창에 답하는 방법이다. 주지 않으면 취소한다.
   * 누른 결과로 새 창이나 탭이 열리면 그 뒤의 snapshot과 동작은 새 창을 대상으로 한다.
   */
  click(ref: number, confirm?: ConfirmPolicy): Promise<ActResult>;
  /** 에이전트가 따라 들어간 새 창을 닫고 원래 창으로 돌아간다. */
  closeTab?(): Promise<ActResult>;
  type(ref: number, text: string): Promise<ActResult>;
  select(ref: number, value: string): Promise<ActResult>;
  waitFor(text: string, timeoutMs: number): Promise<boolean>;
  extractTable(ref: number): Promise<TableData>;
  /** 입력 칸이 있는 표의 빈 행에 값을 채운다. columns는 표의 머리글 이름이다. */
  fillTable(ref: number, columns: string[], rows: string[][], addRef?: number): Promise<ActResult>;
  /**
   * 요소를 눌러 시작된 내려받기의 파일 내용을 돌려준다. timeoutMs 안에 시작되지 않으면 실패한다.
   * allowed가 false를 돌려주는 주소의 파일은 읽지 않는다.
   */
  download?(ref: number, timeoutMs: number, allowed: (url: string) => boolean): Promise<DownloadedFile>;
  /** 에이전트가 화면을 조작 중임을 사용자에게 표시하거나 지운다. */
  setActive?(on: boolean): Promise<void>;
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface LlmPort {
  complete(messages: ChatMessage[], signal?: AbortSignal): Promise<string>;
}

/** 저장·상신 직전에 사용자에게 보여주는 내용. fields는 화면에서 다시 읽은 현재 값이다. */
export interface ApprovalRequest {
  skill: string;
  button: string;
  url: string;
  fields: { name: string; value: string }[];
  /** 이번 실행에서 채운 표. 화면에서 다시 읽어 원본 데이터와 일치함을 확인한 것만 담긴다. */
  tables: { name: string; dataset: string; columns: string[]; rowCount: number; preview: string[][] }[];
}

export interface UiPort {
  ask(question: string): Promise<string>;
  approve(request: ApprovalRequest): Promise<boolean>;
}

export interface FilePort {
  save(filename: string, data: ArrayBuffer): Promise<void>;
}

export type RunStatus = 'done' | 'aborted' | 'stopped' | 'error' | 'dryrun';

export interface HistoryEntry {
  n: number;
  step: number;
  tool: string;
  args: Record<string, unknown>;
  thought: string;
  ok: boolean;
  result: string;
  /**
   * 이 동작을 정한 쪽. skill이면 스킬에 적힌 인자를, cache면 지난번에 성공한 경로를
   * 모델 호출 없이 그대로 실행한 것이다.
   */
  by: 'model' | 'skill' | 'cache';
}

/** 저장해 둔 동작 하나. 요소는 번호가 아니라 이름으로, 입력값은 {이름} 자리표시자로 적는다. */
export interface CachedAction {
  tool: string;
  args: Record<string, unknown>;
}

/** 한 단계를 끝낸 동작들. inputs가 있으면 입력값이 그때와 같을 때만 다시 쓴다. */
export interface StepPath {
  actions: CachedAction[];
  inputs?: Record<string, string>;
  /** 모델 없이 다시 쓴 횟수 */
  hits: number;
}

/** 단계 번호 → 그 단계의 경로 */
export type SkillPaths = Record<number, StepPath>;

/** 성공한 경로를 실행과 실행 사이에 보관하는 곳 */
export interface PathStore {
  load(key: string): Promise<SkillPaths | null>;
  save(key: string, paths: SkillPaths): Promise<void>;
}

export type RunEvent =
  | { type: 'observe'; n: number; url: string; title: string }
  | { type: 'llm_retry'; n: number; reason: string }
  | { type: 'blocked'; n: number; tool: string; reason: string }
  | { type: 'action'; entry: HistoryEntry }
  | { type: 'step_done'; step: number }
  | { type: 'approval'; n: number; request: ApprovalRequest; approved: boolean; dryRun: boolean }
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
  /** 스킬의 "기록:" 줄로 화면에서 읽은 값 (예: 신청 번호) */
  outputs: Record<string, string>;
  elapsedMs: number;
}
