export function tokenFile(): string;
export function loadToken(): string;

export interface McpRequest {
  jsonrpc: '2.0';
  id?: number | string | null;
  method: string;
  params?: Record<string, any>;
}
export interface McpResponse {
  jsonrpc: '2.0';
  id: number | string;
  result?: any;
  error?: { code: number; message: string };
}

export interface Hub {
  ready: Promise<unknown>;
  handleMcp(req: McpRequest): Promise<McpResponse | null>;
  /** 지금 쓰는 브라우저의 연결 방식. 없으면 null */
  connected(): 'WebSocket' | 'Native Messaging' | null;
  /** 연결된 브라우저들. selected는 지금 도구를 보내는 브라우저 */
  browsers(): BrowserLink[];
  /** 번호나 이름 일부로 고른다. 맞는 것이 없거나 여럿이면 던진다 */
  select(which: string | number): { id: number; browser: string; via: string };
  close(): void;
}
export interface BrowserLink {
  id: number;
  browser: string;
  via: 'WebSocket' | 'Native Messaging';
  since: number;
  selected: boolean;
}
export function createHub(options: { token: string; port?: number; pipe?: string; log?: (line: string) => void }): Hub;
