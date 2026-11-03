import { UPLOAD_CHUNK_BYTES, bytesToBase64 } from './upload';
import type { ActResult, ApprovalRequest, BrowserPort, ConfirmPolicy, DownloadedFile, PageSnapshot, Screenshot, TabInfo, TableData } from './types';

/** 올릴 파일을 읽어 검사한 결과 (클라이언트가 만든다. client/src/upload.ts) */
export interface UploadSource {
  name: string;
  mime: string;
  bytes: Uint8Array;
}

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
  /**
   * readUpload는 올릴 파일을 읽는다. 올릴 수 있는 폴더 안인지, 크기, 숨김·키 파일인지를 여기서 검사하고 어기면 던진다.
   * 주지 않으면 파일 올리기를 쓸 수 없다 (확장은 PC의 파일을 읽을 수 없다).
   */
  constructor(
    private call: McpCall,
    private readUpload?: (path: string) => Promise<UploadSource>,
  ) {}

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

  pressKey(key: string, ref?: number): Promise<ActResult> {
    return this.port('pressKey', key, ref ?? null);
  }

  scroll(ref?: number, direction?: 'up' | 'down'): Promise<ActResult> {
    return this.port('scroll', ref ?? null, direction ?? 'down');
  }

  goBack(): Promise<ActResult> {
    return this.port('goBack');
  }

  /** 대상 탭의 화면 그림. 조작할 사이트 밖의 탭이거나 로그인 화면이면 확장이 거절한다. */
  screenshot(): Promise<Screenshot> {
    return this.port('screenshot');
  }

  /**
   * 파일을 읽어 검사하고, 조각으로 나눠 확장에 보낸 뒤(Native Messaging은 한 메시지가 1MB까지)
   * 확장에 올려 달라고 한다. 확장이 사용자 승인을 받아야 파일이 페이지에 들어간다.
   */
  async uploadFile(ref: number, path: string): Promise<ActResult> {
    if (!this.readUpload) return { ok: false, message: '이 환경에서는 파일을 올릴 수 없습니다' };
    let file: UploadSource;
    try {
      file = await this.readUpload(path);
    } catch (e) {
      return { ok: false, message: (e as Error).message };
    }
    const id = crypto.randomUUID();
    await this.port('uploadBegin', id, file.name, file.mime, file.bytes.length);
    for (let i = 0, at = 0; at < file.bytes.length; i++, at += UPLOAD_CHUNK_BYTES) {
      await this.port('uploadChunk', id, i, bytesToBase64(file.bytes.subarray(at, at + UPLOAD_CHUNK_BYTES)));
    }
    return this.port('uploadFile', ref, id);
  }

  /** 저장·상신 직전에 확장의 승인 창으로 사람에게 묻는다. */
  approve(request: ApprovalRequest): Promise<boolean> {
    return this.port('approve', request);
  }
}
