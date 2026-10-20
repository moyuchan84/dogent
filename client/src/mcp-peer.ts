import type { McpCall } from '../../src/core';

/** tools/list의 도구 하나 */
export interface McpToolInfo {
  name: string;
  description?: string;
  inputSchema?: { properties?: Record<string, { type?: string; description?: string; enum?: unknown[] }>; required?: string[] };
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean };
}

export const MCP_PROTOCOL_VERSION = '2025-06-18';
export const MCP_CLIENT_INFO = { name: 'dogent-client', version: '0.1.0' };

/**
 * MCP 서버 하나와의 연결. 서버를 어떻게 잇는지(자식 프로세스의 stdio, HTTP, SSE)만 하위 클래스가 맡고,
 * 도구 목록과 도구 부르기는 여기서 같은 방식으로 한다.
 */
export abstract class McpPeer {
  abstract request(method: string, params?: Record<string, unknown>): Promise<unknown>;
  abstract close(waitMs?: number): Promise<void>;

  /** tools/call. 도구가 실패하면 isError가 true다. */
  call: McpCall = async (name, args) => {
    const r = (await this.request('tools/call', { name, arguments: args })) as { content: { text: string }[]; isError?: boolean };
    return { text: r.content[0]?.text ?? '', isError: !!r.isError };
  };

  /** tools/list. 여러 쪽이면 끝까지 모은다. */
  async listTools(): Promise<McpToolInfo[]> {
    const all: McpToolInfo[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 20; page++) {
      const r = (await this.request('tools/list', cursor ? { cursor } : {})) as { tools?: McpToolInfo[]; nextCursor?: string };
      all.push(...(r.tools ?? []));
      cursor = r.nextCursor;
      if (!cursor) break;
    }
    return all;
  }

  /** tools/call. 글 내용을 모두 이어 돌려주고, 글이 아닌 내용은 개수만 적는다. 시간이 넘으면 실패한다. */
  async callText(name: string, args: Record<string, unknown>, timeoutMs = 120_000): Promise<{ text: string; isError: boolean }> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${name}이(가) ${Math.round(timeoutMs / 1000)}초 안에 끝나지 않았습니다`)), timeoutMs);
    });
    try {
      const r = (await Promise.race([this.request('tools/call', { name, arguments: args }), timeout])) as {
        content?: { type?: string; text?: string }[];
        structuredContent?: unknown;
        isError?: boolean;
      };
      const parts = r.content ?? [];
      const text = parts.filter((c) => typeof c.text === 'string').map((c) => c.text).join('\n');
      const others = parts.length - parts.filter((c) => typeof c.text === 'string').length;
      const body = text || (r.structuredContent !== undefined ? JSON.stringify(r.structuredContent) : '');
      return { text: others > 0 ? `${body}${body ? '\n' : ''}(글이 아닌 내용 ${others}개는 받지 않았습니다)` : body, isError: !!r.isError };
    } finally {
      clearTimeout(timer);
    }
  }
}
