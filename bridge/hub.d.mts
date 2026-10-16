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
  /** 연결된 확장의 연결 방식. 없으면 null */
  connected(): 'WebSocket' | 'Native Messaging' | null;
  close(): void;
}
export function createHub(options: { token: string; port?: number; pipe?: string; log?: (line: string) => void }): Hub;
