import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { qualify, type ExternalTool, type ToolPort } from '../../src/core';
import { dogentHome } from './config';
import { connectRemote } from './mcp-http';
import { normalizeServers } from './mcp-install';
import type { McpPeer, McpToolInfo } from './mcp-peer';
import { StdioMcp } from './mcp-stdio';

export type Permission = 'allow' | 'ask' | 'deny';

/** ~/.dogent/mcp.json 의 서버 하나 */
export interface McpServerSpec {
  /** 이 PC에서 띄울 서버(stdio)의 실행 파일. url과 둘 중 하나 */
  command?: string;
  args?: string[];
  /** 원격 서버의 주소 (command 대신). 인증은 headers로 한다 */
  url?: string;
  /** 원격 서버의 전송 방식. 안 적으면 http를 먼저 하고 안 되면 sse */
  transport?: 'http' | 'sse';
  /** 원격 서버에 보낼 헤더. 값의 ${이름}은 이 PC의 환경 변수로 채운다 */
  headers?: Record<string, string>;
  /** 서버에 넘길 환경 변수. 값의 ${이름}은 이 PC의 환경 변수로 채운다 (토큰을 파일에 적지 않으려고) */
  env?: Record<string, string>;
  cwd?: string;
  /** 도구 이름 → 권한. "*"는 나머지 전부. 안 적으면 읽기 전용 도구는 allow, 바꾸는 도구는 ask */
  permissions?: Record<string, Permission>;
  /** 요청에 이 말이 나오면 브라우저 없이 이 서버의 도구로 처리한다 (서버 이름은 늘 해당) */
  keywords?: string[];
  disabled?: boolean;
}

export interface McpConfig {
  servers: Record<string, McpServerSpec>;
}

export const mcpFile = () => join(dogentHome(), 'mcp.json');

export function loadMcpConfig(): McpConfig {
  const file = mcpFile();
  if (!existsSync(file)) return { servers: {} };
  try {
    // Claude Code 형식(mcpServers)으로 적어 둔 파일도 읽는다
    return { servers: normalizeServers(JSON.parse(readFileSync(file, 'utf8')) as unknown) };
  } catch (e) {
    throw new Error(`${file}을(를) 읽지 못했습니다: ${(e as Error).message}`);
  }
}

export function saveMcpConfig(cfg: McpConfig): string {
  const file = mcpFile();
  mkdirSync(dogentHome(), { recursive: true });
  writeFileSync(file, JSON.stringify(cfg, null, 2));
  return file;
}

/** 켜져 있는 서버만 */
export const enabledServers = (cfg: McpConfig) => Object.entries(cfg.servers).filter(([, s]) => !s.disabled);

/** 요청이 이 서버를 말하는지: 서버 이름이나 keywords가 요청에 들어 있다. */
export function mentionedServers(cfg: McpConfig, text: string): string[] {
  const t = text.toLowerCase();
  return enabledServers(cfg)
    .filter(([name, s]) => [name, ...(s.keywords ?? [])].some((w) => w.trim().length >= 2 && t.includes(w.trim().toLowerCase())))
    .map(([name]) => name);
}

const expand = (value: string) => value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, n: string) => process.env[n] ?? '');

/** 서버의 도구에 정한 권한. 정한 게 없으면 읽기 전용은 allow, 아니면 ask */
export function permissionOf(spec: McpServerSpec, tool: string, readOnly: boolean): Permission {
  const set = spec.permissions ?? {};
  return set[tool] ?? set['*'] ?? (readOnly ? 'allow' : 'ask');
}

interface Entry {
  server: string;
  mcp: McpPeer;
  /** 서버가 쓰는 원래 도구 이름 */
  tool: string;
}

const START_TIMEOUT_MS = 30_000;

/**
 * 설정한 MCP 서버들을 띄워 도구를 한 목록으로 모은다. 실행 중인 에이전트는 이 목록을 ToolPort로 본다.
 * 서버 하나가 안 떠도 나머지는 쓴다 (안 뜬 이유는 failed에 남는다).
 */
export class McpHub implements ToolPort {
  private entries = new Map<string, Entry>();
  private tools: ExternalTool[] = [];
  private rows: { tool: string; description: string; readOnly: boolean; permission: Permission }[] = [];
  readonly failed: { server: string; reason: string }[] = [];
  private servers: McpPeer[] = [];

  static async open(cfg: McpConfig, log?: (line: string) => void): Promise<McpHub> {
    const hub = new McpHub();
    await Promise.all(enabledServers(cfg).map(([name, spec]) => hub.add(name, spec, log)));
    hub.tools.sort((a, b) => a.name.localeCompare(b.name));
    return hub;
  }

  private async add(server: string, spec: McpServerSpec, log?: (line: string) => void): Promise<void> {
    let mcp: McpPeer | undefined;
    try {
      let started: Promise<McpPeer>;
      if (spec.url) {
        const headers = Object.fromEntries(Object.entries(spec.headers ?? {}).map(([k, v]) => [k, expand(v)]));
        started = connectRemote(spec.url, spec.transport, { name: server, headers });
      } else if (spec.command) {
        const env = Object.fromEntries(Object.entries(spec.env ?? {}).map(([k, v]) => [k, expand(v)]));
        // npx 같은 .cmd 실행 파일은 윈도우에서 셸을 거쳐야 뜬다
        const shell = process.platform === 'win32' && /^(npx|npm|pnpm|yarn|uvx)$|\.(cmd|bat)$/i.test(spec.command);
        started = StdioMcp.start(spec.command, spec.args ?? [], { name: server, env, cwd: spec.cwd, shell, log: (l) => log?.(`[${server}] ${l}`) });
      } else {
        throw new Error('command(실행 명령)나 url(주소)이 없습니다');
      }
      let timer: NodeJS.Timeout | undefined;
      const limit = new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new Error(`${START_TIMEOUT_MS / 1000}초 안에 시작하지 않았습니다`)), START_TIMEOUT_MS)));
      mcp = await Promise.race([started, limit]).finally(() => clearTimeout(timer));
      const listed: McpToolInfo[] = await mcp.listTools();
      this.servers.push(mcp);
      for (const t of listed) {
        const name = qualify(server, t.name);
        const readOnly = t.annotations?.readOnlyHint === true;
        this.rows.push({ tool: t.name, description: t.description ?? '', readOnly, permission: permissionOf(spec, t.name, readOnly) });
        this.entries.set(name.toLowerCase(), { server, mcp, tool: t.name });
        this.tools.push({
          name,
          description: t.description ?? '',
          schema: t.inputSchema,
          readOnly,
          permission: permissionOf(spec, t.name, readOnly),
        });
      }
    } catch (e) {
      this.failed.push({ server, reason: (e as Error).message });
      await mcp?.close(2000).catch(() => {});
    }
  }

  list(): ExternalTool[] {
    return this.tools;
  }

  /** 서버가 쓰는 원래 도구 이름으로 본 목록 (설정 화면용) */
  toolRows(): { tool: string; description: string; readOnly: boolean; permission: Permission }[] {
    return this.rows;
  }

  async call(name: string, args: Record<string, unknown>): Promise<{ text: string; isError: boolean }> {
    const entry = this.entries.get(name.toLowerCase());
    if (!entry) throw new Error(`알 수 없는 외부 도구: ${name}`);
    return entry.mcp.callText(entry.tool, args);
  }

  async close(): Promise<void> {
    await Promise.all(this.servers.map((s) => s.close(3000).catch(() => {})));
    this.servers = [];
  }
}

/** `dogent mcp list`에 보여 줄 설정 요약 */
export function describeMcpConfig(cfg: McpConfig): string[] {
  const rows = Object.entries(cfg.servers);
  if (rows.length === 0) return [`연결된 MCP 서버가 없습니다. 더하려면: dogent mcp add <이름> <주소 | -- 명령 …>  (설정 파일 ${mcpFile()})`];
  return rows.map(([name, s]) => {
    const perms = Object.entries(s.permissions ?? {}).map(([t, p]) => `${t}=${p}`).join(' ');
    return `${s.disabled ? '(꺼짐) ' : ''}${name}  ${s.url ? `${s.url} (${s.transport ?? 'http'})` : [s.command, ...(s.args ?? [])].join(' ')}${perms ? `  권한: ${perms}` : ''}${s.keywords?.length ? `  키워드: ${s.keywords.join(', ')}` : ''}`;
  });
}

/** 도구 목록을 사람이 읽을 글로. 서버가 안 뜬 이유도 함께 */
export function describeHub(hub: McpHub): string[] {
  const out = hub.list().map((t) => {
    const flag = t.permission === 'deny' ? '금지' : t.permission === 'ask' ? '묻고 부름' : '바로 부름';
    return `${t.name}  [${t.readOnly ? '읽기' : '바꿈'}, ${flag}]  ${t.description.replace(/\s+/g, ' ').slice(0, 80)}`;
  });
  for (const f of hub.failed) out.push(`${f.server}: 시작하지 못했습니다 — ${f.reason}`);
  return out.length ? out : ['도구가 없습니다'];
}
