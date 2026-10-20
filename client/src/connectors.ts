import { McpHub, loadMcpConfig, saveMcpConfig, type McpConfig, type McpServerSpec, type Permission } from './mcp-hub';
import { describeInstall, normalizeServers, parseMcpAdd } from './mcp-install';

/**
 * 커넥터(MCP 서버)와 스킬을 붙여 넣은 글 한 덩이로 더한다. 데스크탑 창의 "연결 추가"가 쓴다.
 * 사내 마켓에 적힌 설치 명령이나 설정 JSON을 그대로 붙이면 된다.
 *
 *   claude mcp add --transport http --scope user github-mcp http://서버/mcp
 *   npx skills add https://서버/skills/아이디 -a claude-code
 *   {"mcpServers": {...}}  /  https://서버/mcp
 */

export type Pasted =
  | { kind: 'mcp'; entries: Record<string, McpServerSpec>; scope?: string }
  | { kind: 'skill'; url: string; agent?: string };

/** 따옴표를 지키며 공백으로 가른다. 줄 끝의 \ 나 ^ 로 이은 줄은 한 줄로 본다. */
export function splitCommand(text: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quote = '';
  let has = false;
  const src = text.replace(/[\\^]\s*\r?\n/g, ' ');
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (quote) {
      if (c === quote) quote = '';
      else if (c === '\\' && quote === '"' && (src[i + 1] === '"' || src[i + 1] === '\\')) cur += src[++i];
      else cur += c;
    } else if (c === '"' || c === "'") {
      quote = c;
      has = true;
    } else if (/\s/.test(c)) {
      if (cur || has) out.push(cur);
      cur = '';
      has = false;
    } else cur += c;
  }
  if (quote) throw new Error('따옴표가 닫히지 않았습니다');
  if (cur || has) out.push(cur);
  return out;
}

/** 주소에서 서버 이름을 짓는다 (http://ssai.samsungds.net:9999/mcp → ssai) */
export function nameFromUrl(url: string): string {
  try {
    const host = new URL(url).hostname.split('.')[0] || 'mcp';
    return host.replace(/[^A-Za-z0-9_.-]/g, '-') || 'mcp';
  } catch {
    return 'mcp';
  }
}

const LAUNCHERS = new Set(['npx', 'bunx', 'pnpx', 'claude', 'dogent', 'opencode', 'codex', 'gemini']);

export function parsePasted(raw: string): Pasted {
  const text = raw.trim().replace(/^[$>]\s+/, '');
  if (!text) throw new Error('붙여 넣은 내용이 비어 있습니다');
  if (text.startsWith('{')) {
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch (e) {
      throw new Error(`JSON을 읽지 못했습니다: ${(e as Error).message}`);
    }
    const o = json as { url?: string; command?: unknown };
    const fallback = typeof o.url === 'string' ? nameFromUrl(o.url) : typeof o.command === 'string' ? o.command.split(/[\\/]/).pop()!.replace(/\.\w+$/, '') : 'mcp';
    return { kind: 'mcp', entries: normalizeServers(json, fallback) };
  }
  if (/^https?:\/\/\S+$/i.test(text)) {
    // 스킬 마켓 주소인지 MCP 주소인지는 모양으로 가른다
    if (/\/skills?\/[^/]+\/?$/i.test(text)) return { kind: 'skill', url: text };
    return { kind: 'mcp', entries: { [nameFromUrl(text)]: { url: text, transport: 'http' } } };
  }
  let t = splitCommand(text);
  if (t[0] === 'pnpm' && t[1] === 'dlx') t = t.slice(2);
  while (t.length > 0 && LAUNCHERS.has(t[0])) t = t.slice(1);
  if ((t[0] === 'skills' || t[0] === 'skill') && t[1] === 'add') {
    const ai = t.findIndex((x) => x === '-a' || x === '--agent');
    const url = t.slice(2).find((x, i) => !x.startsWith('-') && ai !== i + 1);
    if (!url) throw new Error('스킬 주소가 없습니다 (npx skills add <주소>)');
    return { kind: 'skill', url, agent: ai >= 0 ? t[ai + 1] : undefined };
  }
  if (t[0] === 'mcp' && t[1] === 'add-json') {
    if (!t[2] || !t[3]) throw new Error("add-json은 이름과 JSON이 필요합니다: mcp add-json <이름> '<JSON>'");
    return { kind: 'mcp', entries: normalizeServers(JSON.parse(t.slice(3).join(' ')) as unknown, t[2]) };
  }
  if (t[0] === 'mcp' && t[1] === 'add') {
    const p = parseMcpAdd(t.slice(2));
    return { kind: 'mcp', entries: { [p.name]: p.spec }, scope: p.scope };
  }
  throw new Error('알아보지 못했습니다. claude mcp add …, npx skills add <주소>, MCP 설정 JSON, 또는 서버 주소(http://…)를 붙여 넣어 주세요');
}

/** 창에 보여 줄 서버 하나 */
export interface ServerRow {
  name: string;
  where: 'remote' | 'local';
  target: string;
  disabled: boolean;
  keywords: string[];
  /** 더하기 전에 사용자에게 보여 줄 줄 (어디로 무엇을 보내는지) */
  notes: string[];
}

export interface ToolRow {
  tool: string;
  description: string;
  readOnly: boolean;
  permission: Permission;
}

export interface ProbeResult {
  name: string;
  ok: boolean;
  error?: string;
  tools: ToolRow[];
}

const targetOf = (s: McpServerSpec) => (s.url ? s.url : [s.command, ...(s.args ?? [])].join(' '));

export const serverRow = (name: string, s: McpServerSpec): ServerRow => ({
  name,
  where: s.url ? 'remote' : 'local',
  target: targetOf(s),
  disabled: !!s.disabled,
  keywords: s.keywords ?? [],
  notes: describeInstall(name, s),
});

export const serverRows = (cfg: McpConfig): ServerRow[] => Object.entries(cfg.servers).map(([n, s]) => serverRow(n, s));

/** 서버 하나를 띄워 도구를 읽어 본다. 안 뜨면 이유를 돌려준다. */
export async function probeServer(name: string, spec: McpServerSpec): Promise<ProbeResult> {
  const hub = await McpHub.open({ servers: { [name]: { ...spec, disabled: false } } });
  try {
    const failed = hub.failed[0];
    return { name, ok: !failed, error: failed?.reason, tools: hub.toolRows() };
  } finally {
    await hub.close();
  }
}

/** 설정에 서버를 더하고 저장한다. 같은 이름이 있으면 덮어쓴다 (replaced에 이름이 나온다). */
export function addServers(entries: Record<string, McpServerSpec>): { saved: string[]; replaced: string[] } {
  const cfg = loadMcpConfig();
  const replaced = Object.keys(entries).filter((n) => cfg.servers[n]);
  // 덮어써도 사용자가 정한 권한·키워드는 새 설정에 없을 때 이어 받는다
  for (const [n, s] of Object.entries(entries)) {
    const old = cfg.servers[n];
    cfg.servers[n] = { ...s, ...(old?.permissions && !s.permissions ? { permissions: old.permissions } : {}), ...(old?.keywords && !s.keywords ? { keywords: old.keywords } : {}) };
  }
  saveMcpConfig(cfg);
  return { saved: Object.keys(entries), replaced };
}

export function patchServer(name: string, patch: { disabled?: boolean; keywords?: string[]; permission?: { tool: string; value: Permission | 'default' } }): void {
  const cfg = loadMcpConfig();
  const s = cfg.servers[name];
  if (!s) throw new Error(`서버 "${name}"이(가) 없습니다`);
  if (patch.disabled !== undefined) s.disabled = patch.disabled || undefined;
  if (patch.keywords) s.keywords = patch.keywords.length ? patch.keywords : undefined;
  if (patch.permission) {
    const perms = { ...(s.permissions ?? {}) };
    if (patch.permission.value === 'default') delete perms[patch.permission.tool];
    else perms[patch.permission.tool] = patch.permission.value;
    s.permissions = Object.keys(perms).length ? perms : undefined;
  }
  saveMcpConfig(cfg);
}

export function removeServer(name: string): void {
  const cfg = loadMcpConfig();
  if (!cfg.servers[name]) throw new Error(`서버 "${name}"이(가) 없습니다`);
  delete cfg.servers[name];
  saveMcpConfig(cfg);
}
