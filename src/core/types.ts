import type { Skill } from './skill';

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

/** 화면 점검에서 본 표 하나. 칸의 값은 담지 않는다. */
export interface TableInspection {
  name: string;
  /** <table>인지 role=grid 같은 그리드인지 */
  kind: 'table' | 'grid';
  rows: number;
  columns: string[];
  /** 본문 행 중 칸에 입력 요소가 있는 행의 수. 0이면 조회용 표이거나 붙여넣기 전용 그리드다. */
  inputRows: number;
}

/** 한 프레임에서 페이지 에이전트가 돌려주는 화면 점검 결과. 화면의 값과 본문 글자는 담지 않는다. */
export interface FrameInspection {
  url: string;
  title: string;
  hasPassword: boolean;
  /** 스냅샷에 들어간 조작 가능한 요소의 수 */
  elements: number;
  /** 요소가 너무 많아 스냅샷에서 일부가 빠졌는지 */
  truncated: boolean;
  /** 이름을 찾지 못한 요소의 역할별 수 */
  unnamed: Record<string, number>;
  tables: TableInspection[];
  /** 화면에 크게 그려진 canvas (그림으로 그리는 그리드일 수 있다) */
  canvases: { width: number; height: number }[];
  /** 안에 조작할 요소가 있는 웹 컴포넌트(shadow DOM). 스냅샷이 그 안을 읽지 못한다. */
  shadowHosts: { tag: string; controls: number }[];
  /** 이 프레임이 담은 iframe·frame의 주소 */
  frames: string[];
  /** 내려받기로 보이는 버튼·링크의 이름 */
  downloads: string[];
  /** 다음 페이지로 보이는 버튼·링크의 이름 */
  pagers: string[];
}

/**
 * 사람이 화면에서 한 조작 하나. 스킬 초안을 만들 때 녹화한다.
 * dup은 같은 이름의 요소가 화면에 여럿 있어 이름만으로 특정할 수 없다는 뜻이다.
 */
export type RecordedEvent =
  | { kind: 'click'; role: string; name: string; dup: boolean; row?: string; /** 누른 시각 (ms) */ at?: number }
  | { kind: 'type'; name: string; value: string; dup: boolean; multiline: boolean; numeric: boolean }
  | { kind: 'select'; name: string; value: string; options: string[]; dup: boolean };

/** 페이지가 띄운 알림·확인·입력 창 하나. accepted는 확인을 누른 것으로 답했는지다. */
export interface PageDialog {
  kind: 'alert' | 'confirm' | 'prompt';
  message: string;
  accepted: boolean;
  /** 창이 뜬 시각 (ms). 녹화할 때만 적는다. 어느 누름 뒤에 뜬 창인지 가리는 데 쓴다. */
  at?: number;
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

/** 브라우저 탭 하나. allowed는 Dogent가 조작할 수 있는 사이트인지다. */
export interface TabInfo {
  id: number;
  url: string;
  title: string;
  current: boolean;
  allowed: boolean;
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
  /** 브라우저의 탭 목록 (current는 지금 조작 대상) */
  tabs?(): Promise<TabInfo[]>;
  /** 새 탭에서 주소를 열고 그 탭을 조작 대상으로 삼는다. 조작할 사이트 목록 밖이면 실패한다. */
  openTab?(url: string): Promise<ActResult>;
  /** 다른 탭을 조작 대상으로 삼는다 */
  selectTab?(tab: number): Promise<ActResult>;
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
  /** 화면(ref를 주면 그 요소)에 보이는 글. 입력 칸의 값과 비밀번호는 담지 않는다. */
  readText?(ref?: number): Promise<string>;
  /** 키를 누른다 (Enter, Escape, Tab, 화살표 등). ref가 있으면 그 요소에서, 없으면 지금 초점이 있는 요소에서. */
  pressKey?(key: string, ref?: number): Promise<ActResult>;
  /** ref가 있으면 그 요소가 보이게, 없으면 화면을 한 쪽 아래(up이면 위)로 스크롤한다. */
  scroll?(ref?: number, direction?: 'up' | 'down'): Promise<ActResult>;
  /** 브라우저의 뒤로 가기 */
  goBack?(): Promise<ActResult>;
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
  /** 엑셀 문서를 바꾸기 전에 사용자의 허락을 받는다. 없으면 바꾸지 않는다. */
  confirm?(message: string): Promise<boolean>;
}

/** 사용자 Excel에 열려 있는 문서 하나 */
export interface OfficeDoc {
  name: string;
  /** 전체 경로나 주소 */
  fullName: string;
  readOnly: boolean;
}

/**
 * 엑셀 문서를 다루는 통로. 문서는 이름(열린 문서) 또는 경로로 가리킨다.
 * 구현은 사용자의 Excel을 거치므로 문서 보안(NASCA)이 걸린 문서도 다룰 수 있다.
 */
export interface OfficePort {
  /** 사용자의 Excel에 지금 열려 있는 문서 */
  docs(): Promise<OfficeDoc[]>;
  /** 시트의 표를 읽는다 (첫 행은 열 이름). sheets는 문서의 시트 이름들, total은 표 전체 행 수 */
  read(
    doc: string,
    opts: { sheet?: string; range?: string },
  ): Promise<{ sheet: string; sheets: string[]; columns: string[]; rows: Cell[][]; total: number }>;
  /** 시트에 표를 쓴다 (저장은 하지 않는다). 시트가 없으면 만든다 */
  write(doc: string, sheet: string, table: { columns: string[]; rows: Cell[][] }, start?: string): Promise<string>;
  /** Excel로 저장한다. path가 없으면 연 곳에, 있으면 그 경로에 다른 이름으로. 저장한 곳을 돌려준다 */
  save(doc: string, path?: string): Promise<string>;
}

/** 외부 도구(MCP 서버 등) 하나. name은 "서버.도구" 모양이다. */
export interface ExternalTool {
  name: string;
  description: string;
  /** 인자의 JSON 스키마 (MCP inputSchema) */
  schema?: { properties?: Record<string, { type?: string; description?: string; enum?: unknown[] }>; required?: string[] };
  /** 읽기만 하는 도구 (MCP의 readOnlyHint). 아니면 바꾸는 도구로 본다 */
  readOnly: boolean;
  /** allow: 묻지 않고 부름, ask: 부르기 전에 사용자에게 묻는다, deny: 부르지 않는다 */
  permission: 'allow' | 'ask' | 'deny';
}

/** 외부 도구를 부르는 통로. 도구 목록은 실행을 시작할 때 정해진다. */
export interface ToolPort {
  list(): ExternalTool[];
  call(name: string, args: Record<string, unknown>): Promise<{ text: string; isError: boolean }>;
}

/** 다른 스킬을 부르는 통로 (run_skill). 스킬 목록은 실행을 시작할 때 정해진다. */
export interface SkillCatalogPort {
  list(): Skill[];
  get(id: string): Skill | undefined;
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
  /**
   * ref·next_ref·add_ref가 가리킨 요소. 번호는 화면이 바뀌면 달라지므로,
   * 실행을 스킬로 저장할 때 이 이름으로 단계를 적는다.
   */
  targets?: Record<string, ActionTarget>;
}

/** 동작이 가리킨 요소. dup은 같은 역할·이름의 요소가 화면에 둘 이상이었다는 뜻이다. */
export interface ActionTarget {
  role: string;
  name: string;
  dup: boolean;
  row?: string;
  /** 고르기 칸의 보기 */
  options?: string[];
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
  /** raw는 형식에 맞지 않았던 모델 응답의 앞부분이다. 왜 다시 물었는지 기록에서 볼 수 있게 남긴다. */
  | { type: 'llm_retry'; n: number; reason: string; raw?: string }
  /** 모델을 한 번 부를 때 보낸 글자 수와 걸린 시간. 프롬프트를 줄인 효과를 재는 데 쓴다. */
  | { type: 'llm_usage'; n: number; systemChars: number; userChars: number; replyChars: number; ms: number }
  | { type: 'blocked'; n: number; tool: string; reason: string }
  | { type: 'action'; entry: HistoryEntry }
  | { type: 'step_done'; step: number }
  /** run_skill로 다른 스킬을 따로 실행하기 시작함 */
  | { type: 'sub_start'; skill: string; name: string; inputs: Record<string, string | number> }
  /** 따로 실행 중인 스킬의 동작 하나. 부모의 동작 기록(action)과 섞이지 않게 따로 낸다. */
  | { type: 'sub_action'; skill: string; entry: HistoryEntry }
  | { type: 'sub_end'; skill: string; status: RunStatus; message: string }
  | { type: 'approval'; n: number; request: ApprovalRequest; approved: boolean; dryRun: boolean }
  /** 로그인 화면을 만나 사람이 로그인하기를 기다리기 시작함 */
  | { type: 'login_wait'; url: string; timeoutSec: number }
  /** 로그인이 끝나 이어서 진행함 */
  | { type: 'login_done'; url: string }
  | { type: 'end'; status: RunStatus; message: string };

export interface DatasetInfo {
  name: string;
  columns: string[];
  rowCount: number;
}

export interface RunResult {
  status: RunStatus;
  message: string;
  /**
   * 스킬 탓이 아닌 중단의 이유. user: 사용자가 승인하지 않음, policy: 입력값이 정책에 걸림,
   * login: 로그인이 풀려 있음. 스킬의 성공률을 셀 때 이런 실행은 뺀다.
   */
  cause?: 'user' | 'policy' | 'login';
  lastStep: number;
  actions: number;
  files: string[];
  datasets: DatasetInfo[];
  /** 스킬의 "기록:" 줄로 화면에서 읽은 값 (예: 신청 번호) */
  outputs: Record<string, string>;
  elapsedMs: number;
}
