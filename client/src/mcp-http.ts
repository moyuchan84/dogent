import { MCP_CLIENT_INFO, MCP_PROTOCOL_VERSION, McpPeer } from './mcp-peer';

/**
 * 원격 MCP 서버(URL)에 붙는다. claude mcp add --transport http|sse 로 더하는 서버와 같은 것이다.
 *
 * - http: Streamable HTTP. 요청마다 POST하고, 답은 JSON 한 덩이나 SSE 흐름으로 온다.
 * - sse: 옛 방식. 주소로 GET해 흐름을 열어 두고, 거기서 받은 endpoint로 POST한다. 답은 흐름으로 온다.
 *
 * 로그인(OAuth)은 하지 않는다. 인증이 필요한 서버는 headers에 Authorization을 적는다.
 */
export interface RemoteOptions {
  headers?: Record<string, string>;
  name?: string;
  /** 요청 하나가 끝나기를 기다리는 시간 */
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 130_000;

let remoteUsed = false;
/** 이 프로세스가 원격 MCP 서버와 HTTP로 통신했는지 (끝낼 때 process.exit()를 피하려고 본다) */
export const remoteMcpUsed = () => remoteUsed;

/** 서버가 알린 오류를 사람이 읽을 글로. 인증 오류는 어떻게 고치는지도 적는다. */
async function httpError(res: Response, who: string): Promise<Error> {
  const body = (await res.text().catch(() => '')).replace(/\s+/g, ' ').slice(0, 200);
  const hint =
    res.status === 401 || res.status === 403
      ? ' — 인증이 필요합니다. 서버 설정의 headers에 {"Authorization": "Bearer ${토큰 환경변수}"} 를 적으세요 (dogent mcp add … --header "Authorization: Bearer …")'
      : res.status === 404 || res.status === 405
        ? ' — 이 주소가 MCP 서버가 아니거나 전송 방식이 다릅니다 (--transport http 또는 sse)'
        : '';
  return new Error(`${who}: HTTP ${res.status}${body ? ` ${body}` : ''}${hint}`);
}

type Rpc = { id?: number | string; result?: unknown; error?: { message: string; code?: number }; method?: string };

/** SSE 흐름에서 이벤트를 하나씩 읽는다. data 줄은 이어 붙인다. */
async function* sseEvents(body: ReadableStream<Uint8Array>): AsyncGenerator<{ event: string; data: string }> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n');
      for (let end = buffer.indexOf('\n\n'); end >= 0; end = buffer.indexOf('\n\n')) {
        const block = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        let event = 'message';
        const data: string[] = [];
        for (const line of block.split('\n')) {
          if (line.startsWith('event:')) event = line.slice(6).trim();
          else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
        }
        if (data.length > 0) yield { event, data: data.join('\n') };
      }
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
}

const parseRpc = (text: string): Rpc | null => {
  try {
    const v = JSON.parse(text) as Rpc;
    return v && typeof v === 'object' ? v : null;
  } catch {
    return null;
  }
};

function answer(msg: Rpc): unknown {
  if (msg.error) throw new Error(msg.error.message);
  return msg.result;
}

export class HttpMcp extends McpPeer {
  private nextId = 1;
  private session: string | undefined;
  private protocol = MCP_PROTOCOL_VERSION;

  private constructor(
    private url: string,
    private opts: RemoteOptions,
  ) {
    super();
  }

  private headers(): Record<string, string> {
    return {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'mcp-protocol-version': this.protocol,
      ...(this.session ? { 'mcp-session-id': this.session } : {}),
      ...this.opts.headers,
    };
  }

  private post(body: object): Promise<Response> {
    return fetch(this.url, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.opts.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    });
  }

  /** 서버를 만나 MCP 시작 인사를 마친다. 주소가 MCP 서버가 아니면 던진다. */
  static async start(url: string, opts: RemoteOptions = {}): Promise<HttpMcp> {
    remoteUsed = true;
    const mcp = new HttpMcp(url, opts);
    const init = (await mcp.request('initialize', { protocolVersion: MCP_PROTOCOL_VERSION, capabilities: {}, clientInfo: MCP_CLIENT_INFO })) as {
      protocolVersion?: string;
    };
    if (init?.protocolVersion) mcp.protocol = init.protocolVersion;
    await mcp.notify('notifications/initialized');
    return mcp;
  }

  async request(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    const id = this.nextId++;
    const who = this.opts.name ?? this.url;
    const res = await this.post({ jsonrpc: '2.0', id, method, params }).catch((e: Error) => {
      throw new Error(`${who}에 닿지 못했습니다: ${e.cause instanceof Error ? e.cause.message : e.message}`);
    });
    if (!res.ok) throw await httpError(res, who);
    const sid = res.headers.get('mcp-session-id');
    if (sid) this.session = sid;
    const type = res.headers.get('content-type') ?? '';
    if (type.includes('text/event-stream') && res.body) {
      for await (const ev of sseEvents(res.body)) {
        const msg = parseRpc(ev.data);
        if (msg && msg.id === id && (msg.result !== undefined || msg.error)) return answer(msg);
      }
      throw new Error(`${who}: 답이 오기 전에 연결이 끝났습니다`);
    }
    const msg = parseRpc(await res.text());
    if (!msg) throw new Error(`${who}: 서버의 답이 JSON-RPC가 아닙니다`);
    return answer(msg);
  }

  private async notify(method: string): Promise<void> {
    const res = await this.post({ jsonrpc: '2.0', method }).catch(() => null);
    await res?.body?.cancel().catch(() => {});
  }

  /** 세션이 있으면 서버에 끝낸다고 알린다. 서버가 받지 않아도 상관없다. */
  async close(): Promise<void> {
    if (!this.session) return;
    await fetch(this.url, { method: 'DELETE', headers: this.headers(), signal: AbortSignal.timeout(3000) }).catch(() => {});
    this.session = undefined;
  }
}

export class SseMcp extends McpPeer {
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private endpoint = '';
  private abort = new AbortController();
  private closed: Error | null = null;

  private constructor(
    private url: string,
    private opts: RemoteOptions,
  ) {
    super();
  }

  static async start(url: string, opts: RemoteOptions = {}): Promise<SseMcp> {
    remoteUsed = true;
    const mcp = new SseMcp(url, opts);
    await mcp.open();
    await mcp.request('initialize', { protocolVersion: MCP_PROTOCOL_VERSION, capabilities: {}, clientInfo: MCP_CLIENT_INFO });
    await mcp.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    return mcp;
  }

  private async open(): Promise<void> {
    const who = this.opts.name ?? this.url;
    const res = await fetch(this.url, { headers: { accept: 'text/event-stream', ...this.opts.headers }, signal: this.abort.signal }).catch((e: Error) => {
      throw new Error(`${who}에 닿지 못했습니다: ${e.cause instanceof Error ? e.cause.message : e.message}`);
    });
    if (!res.ok || !res.body) throw await httpError(res, who);
    const body = res.body;
    const ready = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${who}: endpoint 알림이 오지 않았습니다 (SSE 서버가 아닌 듯합니다)`)), 15_000);
      void (async () => {
        try {
          for await (const ev of sseEvents(body)) {
            if (ev.event === 'endpoint') {
              this.endpoint = new URL(ev.data.trim(), this.url).href;
              clearTimeout(timer);
              resolve();
              continue;
            }
            const msg = parseRpc(ev.data);
            const p = msg?.id === undefined ? undefined : this.pending.get(Number(msg.id));
            if (!msg || !p) continue;
            this.pending.delete(Number(msg.id));
            if (msg.error) p.reject(new Error(msg.error.message));
            else p.resolve(msg.result);
          }
          this.closed = new Error(`${who}의 연결이 끊어졌습니다`);
        } catch (e) {
          this.closed = this.abort.signal.aborted ? new Error(`${who}의 연결을 닫았습니다`) : (e as Error);
        }
        clearTimeout(timer);
        reject(this.closed ?? new Error('연결이 끊어졌습니다'));
        for (const p of this.pending.values()) p.reject(this.closed!);
        this.pending.clear();
      })();
    });
    await ready;
  }

  private async send(body: object): Promise<void> {
    const res = await fetch(this.endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...this.opts.headers },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.opts.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    });
    if (!res.ok) throw await httpError(res, this.opts.name ?? this.url);
    await res.body?.cancel().catch(() => {});
  }

  request(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    if (this.closed) return Promise.reject(this.closed);
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.send({ jsonrpc: '2.0', id, method, params }).catch((e: Error) => {
        this.pending.delete(id);
        reject(e);
      });
    });
  }

  async close(): Promise<void> {
    this.abort.abort();
  }
}

/**
 * 주소의 MCP 서버에 붙는다. transport를 안 주면 Streamable HTTP를 먼저 해 보고,
 * 그 방식을 모르는 서버(404, 405)면 옛 SSE 방식으로 다시 붙는다.
 */
export async function connectRemote(url: string, transport: 'http' | 'sse' | undefined, opts: RemoteOptions = {}): Promise<McpPeer> {
  if (transport === 'sse') return SseMcp.start(url, opts);
  try {
    return await HttpMcp.start(url, opts);
  } catch (e) {
    if (transport === 'http' || !/HTTP (404|405)\b/.test((e as Error).message)) throw e;
    return SseMcp.start(url, opts);
  }
}
