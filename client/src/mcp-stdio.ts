import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import { MCP_CLIENT_INFO, MCP_PROTOCOL_VERSION, McpPeer } from './mcp-peer';

export type { McpToolInfo } from './mcp-peer';

let stdioUsed = false;
/** 이 프로세스가 stdio MCP 서버를 띄웠는지 (끝낼 때 process.exit()를 피하려고 본다) */
export const stdioMcpUsed = () => stdioUsed;

/**
 * 다른 프로그램으로 도는 MCP 서버(stdio)에 붙는다. 오피스 도구(dogent-office.exe)처럼
 * 클라이언트 밖의 도구를 같은 방식으로 더할 때 쓴다 (docs/09 D2).
 */
export class StdioMcp extends McpPeer {
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private exited: Error | null = null;

  private constructor(
    private child: ChildProcessWithoutNullStreams,
    name: string,
  ) {
    super();
    createInterface({ input: child.stdout }).on('line', (line) => {
      let msg: { id?: number; result?: unknown; error?: { message: string } };
      try {
        msg = JSON.parse(line);
      } catch {
        return;
      }
      const p = msg.id === undefined ? undefined : this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id!);
      if (msg.error) p.reject(new Error(msg.error.message));
      else p.resolve(msg.result);
    });
    child.on('exit', (code) => {
      this.exited = new Error(`${name}이(가) 끝났습니다 (코드 ${code})`);
      for (const p of this.pending.values()) p.reject(this.exited);
      this.pending.clear();
    });
  }

  /** 서버를 띄우고 MCP 시작 인사를 마친다. */
  static async start(
    command: string,
    args: string[] = [],
    opts: { name?: string; log?: (line: string) => void; env?: Record<string, string>; cwd?: string; shell?: boolean } = {},
  ): Promise<StdioMcp> {
    const name = opts.name ?? command;
    stdioUsed = true;
    const child = spawn(command, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      env: opts.env ? { ...process.env, ...opts.env } : process.env,
      cwd: opts.cwd,
      shell: opts.shell,
    });
    const failed = new Promise<never>((_, reject) => child.once('error', (e) => reject(new Error(`${name}을(를) 실행하지 못했습니다: ${e.message}`))));
    createInterface({ input: child.stderr }).on('line', (l) => opts.log?.(l));
    const mcp = new StdioMcp(child, name);
    await Promise.race([
      mcp.request('initialize', { protocolVersion: MCP_PROTOCOL_VERSION, capabilities: {}, clientInfo: MCP_CLIENT_INFO }),
      failed,
    ]);
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
    return mcp;
  }

  request(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    if (this.exited) return Promise.reject(this.exited);
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  }

  /** 입력을 닫아 서버가 스스로 정리하고 끝나게 한다. 오래 걸리면 끝낸다. */
  async close(waitMs = 15_000): Promise<void> {
    if (this.exited) return;
    const done = new Promise<void>((r) => this.child.once('exit', () => r()));
    this.child.stdin.end();
    const timer = setTimeout(() => this.child.kill(), waitMs);
    await done;
    clearTimeout(timer);
  }
}
