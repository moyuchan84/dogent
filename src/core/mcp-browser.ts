import type { ActResult, ApprovalRequest, BrowserPort, ConfirmPolicy, DownloadedFile, PageSnapshot, TabInfo, TableData } from './types';

/** MCP 도구 하나를 부른다. 도구가 실패하면 isError가 true다. */
export type McpCall = (name: string, args: Record<string, unknown>) => Promise<{ text: string; isError: boolean }>;

/** 확장이 Dogent 클라이언트에게만 내놓는 도구 (bridge/tools.mjs의 PORT_TOOL) */
const PORT_TOOL = 'dogent_port';

/**
 * Dogent 클라이언트가 쓰는 BrowserPort. 화면 읽기·조작을 MCP로 확장에 맡긴다 (docs/09 D1, D2).
 *
 * 스킬 실행 루프(runSkill)는 사이드 패널과 똑같이 돌고, 브라우저 쪽만 이것으로 바뀐다.
 * 조작할 사이트와 저장·상신 승인은 확장이 지킨다. 승인은 approve()로 확장의 승인 창에서 받고,
 * 승인받은 버튼은 바로 다음 한 번만 승인 창 없이 눌린다.
 */
export class McpBrowser implements BrowserPort {
  constructor(private call: McpCall) {}

  private async port<T>(method: string, ...args: unknown[]): Promise<T> {
    const r = await this.call(PORT_TOOL, { method, args });
    if (r.isError) throw new Error(r.text);
    return JSON.parse(r.text) as T;
  }

  /** 지금 대상 탭 */
  target(): Promise<{ id: number; url: string; title: string; allowed: boolean }> {
    return this.port('target');
  }

  /** 대상을 사용자가 보고 있는 탭으로 되돌린다 (새 탭을 열어 쓴 뒤, 다음 요청 전에) */
  async followActive(): Promise<void> {
    await this.port('followActive');
  }

  snapshot(): Promise<PageSnapshot> {
    return this.port('snapshot');
  }

  navigate(url: string): Promise<ActResult> {
    return this.port('navigate', url);
  }

  click(ref: number, confirm?: ConfirmPolicy): Promise<ActResult> {
    return this.port('click', ref, confirm ?? null);
  }

  closeTab(): Promise<ActResult> {
    return this.port('closeTab');
  }

  tabs(): Promise<TabInfo[]> {
    return this.port('tabs');
  }

  openTab(url: string): Promise<ActResult> {
    return this.port('openTab', url);
  }

  selectTab(tab: number): Promise<ActResult> {
    return this.port('selectTab', tab);
  }

  type(ref: number, text: string): Promise<ActResult> {
    return this.port('type', ref, text);
  }

  select(ref: number, value: string): Promise<ActResult> {
    return this.port('select', ref, value);
  }

  waitFor(text: string, timeoutMs: number): Promise<boolean> {
    return this.port('waitFor', text, timeoutMs);
  }

  extractTable(ref: number): Promise<TableData> {
    return this.port('extractTable', ref);
  }

  fillTable(ref: number, columns: string[], rows: string[][], addRef?: number): Promise<ActResult> {
    return this.port('fillTable', ref, columns, rows, addRef ?? null);
  }

  async download(ref: number, timeoutMs: number, allowed: (url: string) => boolean): Promise<DownloadedFile> {
    const file = await this.port<{ filename: string; url: string; base64: string }>('download', ref, timeoutMs);
    // 확장이 조작할 사이트 밖의 파일은 읽지 않는다. 스킬의 domains로 한 번 더 거른다.
    if (!allowed(file.url)) throw new Error(`허용되지 않은 주소에서 받은 파일입니다: ${file.url}`);
    const bin = atob(file.base64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return { filename: file.filename, url: file.url, data: bytes.buffer };
  }

  async setActive(on: boolean): Promise<void> {
    await this.port('setActive', on);
  }

  readText(ref?: number): Promise<string> {
    return this.port('readText', ref ?? null);
  }

  /** 저장·상신 직전에 확장의 승인 창으로 사람에게 묻는다. */
  approve(request: ApprovalRequest): Promise<boolean> {
    return this.port('approve', request);
  }
}
