import { userInfo } from 'node:os';
import { createHub, loadToken } from '../../bridge/hub.mjs';
import { DEFAULT_PORT, pipePath } from '../../bridge/protocol.mjs';
import { McpBrowser, type McpCall } from '../../src/core';

/**
 * 확장과의 연결. 브리지(bridge/hub.mjs)를 이 프로세스 안에서 띄우고 MCP 메시지로 부른다.
 * 확장은 지금처럼 WebSocket이나 Native Messaging으로 이 브리지에 붙어 온다 (설정 → 클라이언트 연결).
 *
 * Claude Code가 브리지를 이미 띄워 두었으면 포트가 겹친다. 그때는 Claude Code를 닫거나 포트를 바꾼다.
 */
export interface Bridge {
  browser: McpBrowser;
  call: McpCall;
  /** 확장이 붙어 있는지 (붙은 방식) */
  connected(): string | null;
  /** 확장이 붙을 때까지 기다린다. 시간 안에 붙지 않으면 false */
  waitForExtension(ms: number): Promise<boolean>;
  close(): void;
}

export async function openBridge(opts: { port?: number; log?: (line: string) => void } = {}): Promise<Bridge> {
  const port = opts.port ?? Number(process.env.DOGENT_BRIDGE_PORT ?? DEFAULT_PORT);
  const hub = createHub({
    token: loadToken(),
    port,
    pipe: process.env.DOGENT_BRIDGE_PIPE ?? pipePath(userInfo().username),
    log: opts.log ?? (() => {}),
  });
  try {
    await hub.ready;
  } catch {
    hub.close();
    throw new Error(
      `확장과 잇는 포트 ${port}을(를) 열지 못했습니다. Claude Code 같은 다른 프로그램이 Dogent 브리지를 이미 쓰고 있으면 닫고 다시 실행하세요.`,
    );
  }
  let id = 1;
  const call: McpCall = async (name, args) => {
    const res = await hub.handleMcp({ jsonrpc: '2.0', id: id++, method: 'tools/call', params: { name, arguments: args } });
    if (!res) throw new Error('브리지가 답하지 않았습니다');
    if (res.error) return { text: res.error.message, isError: true };
    const result = res.result as { content: { text: string }[]; isError?: boolean };
    return { text: result.content[0]?.text ?? '', isError: !!result.isError };
  };
  return {
    browser: new McpBrowser(call),
    call,
    connected: () => hub.connected(),
    async waitForExtension(ms) {
      const end = Date.now() + ms;
      while (Date.now() < end) {
        if (hub.connected()) return true;
        await new Promise((r) => setTimeout(r, 200));
      }
      return !!hub.connected();
    },
    close: () => hub.close(),
  };
}

export { loadToken };
