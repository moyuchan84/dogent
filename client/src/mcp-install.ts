import type { McpServerSpec } from './mcp-hub';

/**
 * 다른 도구에서 쓰던 MCP 서버 설정을 Dogent의 설정(~/.dogent/mcp.json)으로 옮긴다.
 *
 *   claude mcp add --transport http --scope user github-mcp http://서버/mcp
 *   claude mcp add -e KEY=값 mes -- npx -y @회사/mes-mcp
 *   {"mcpServers": {"mes": {"command": "npx", "args": ["-y", "pkg"], "env": {...}}}}    Claude Code, Cursor, Windsurf
 *   {"servers": {"x": {"type": "http", "url": "...", "headers": {...}}}}                 VS Code
 *   {"mcp": {"x": {"type": "remote", "url": "..."}, "y": {"type": "local", "command": ["npx", "pkg"]}}}   opencode
 *
 * 순수 함수만 둔다 (파일과 네트워크는 건드리지 않는다).
 */

export interface ParsedAdd {
  name: string;
  spec: McpServerSpec;
  /** claude의 --scope. Dogent는 PC 하나에 설정이 하나라 알려 주기만 한다 */
  scope?: string;
  yes: boolean;
  /** 더한 뒤 연결 시험을 하지 않는다 */
  noTest: boolean;
}

const URL_RE = /^https?:\/\//i;
const ENV_RE = /^[A-Za-z_][A-Za-z0-9_]*=/;

/** "Authorization: Bearer x" 또는 "Authorization=Bearer x" */
export function parseHeader(text: string): [string, string] {
  const m = /^\s*([^:=\s]+)\s*[:=]\s*(.*)$/.exec(text);
  if (!m) throw new Error(`헤더는 "이름: 값" 모양이어야 합니다: ${text}`);
  return [m[1], m[2].trim()];
}

/**
 * `claude mcp add` 와 같은 인자를 읽는다 (맨 앞의 add는 뗀 것).
 *   <이름> <주소>                         원격 서버 (--transport http|sse, 기본 http)
 *   <이름> -- <명령> [인자 …]             이 PC에서 도는 서버 (stdio)
 *   <이름> <명령> [인자 …]                옛 dogent mcp add 방식 (그대로 받는다)
 * 옵션: -t/--transport, -s/--scope, -H/--header "이름: 값", -e/--env KEY=값 …, --yes
 */
export function parseMcpAdd(argv: string[]): ParsedAdd {
  const headers: Record<string, string> = {};
  const env: Record<string, string> = {};
  const positional: string[] = [];
  let rest: string[] = [];
  let transport: string | undefined;
  let scope: string | undefined;
  let yes = false;
  let noTest = false;
  const value = (i: number, flag: string) => {
    const v = argv[i + 1];
    if (v === undefined || v === '--') throw new Error(`${flag} 뒤에 값이 필요합니다`);
    return v;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const eq = /^(--[a-z-]+)=(.*)$/.exec(a);
    const flag = eq ? eq[1] : a;
    const take = () => (eq ? eq[2] : (i++, value(i - 1, flag)));
    if (a === '--') {
      rest = argv.slice(i + 1);
      break;
    } else if (flag === '--transport' || flag === '-t') transport = take();
    else if (flag === '--scope' || flag === '-s') scope = take();
    else if (flag === '--header' || flag === '-H') {
      const [k, v] = parseHeader(take());
      headers[k] = v;
    } else if (flag === '--env' || flag === '-e') {
      // -e A=1 B=2 처럼 KEY=값을 여러 개 이어 적을 수 있다
      const addEnv = (kv: string) => {
        if (!ENV_RE.test(kv)) throw new Error(`환경 변수는 KEY=값 모양이어야 합니다: ${kv}`);
        env[kv.slice(0, kv.indexOf('='))] = kv.slice(kv.indexOf('=') + 1);
      };
      addEnv(take());
      while (!eq && i + 1 < argv.length && ENV_RE.test(argv[i + 1])) addEnv(argv[++i]);
    } else if (flag === '--yes') yes = true;
    else if (flag === '--no-test') noTest = true;
    else if (a.startsWith('-') && a.length > 1 && !positional.length) throw new Error(`알 수 없는 옵션: ${a}`);
    else positional.push(a);
  }
  const [name, ...more] = positional;
  if (!name) throw new Error('서버 이름이 필요합니다. 예: dogent mcp add github-mcp http://서버/mcp --transport http');
  if (!/^[A-Za-z0-9_.-]+$/.test(name)) throw new Error(`서버 이름은 영문·숫자·-_. 만 쓸 수 있습니다: ${name}`);
  const result = (spec: McpServerSpec): ParsedAdd => ({ name, spec, scope, yes, noTest });

  if (transport && !['http', 'sse', 'stdio', 'streamable-http'].includes(transport)) throw new Error(`--transport는 http, sse, stdio 중 하나입니다: ${transport}`);
  const remote = rest.length === 0 && more.length === 1 && URL_RE.test(more[0]) && transport !== 'stdio';
  if (remote) {
    const kind = transport === 'sse' ? 'sse' : 'http';
    return result({ url: more[0], transport: kind, ...(Object.keys(headers).length ? { headers } : {}) });
  }
  if (transport === 'http' || transport === 'sse') {
    throw new Error(`--transport ${transport}에는 http:// 또는 https:// 주소가 필요합니다`);
  }
  const command = rest[0] ?? more[0];
  const args = rest.length ? rest.slice(1) : more.slice(1);
  if (!command) throw new Error('주소(http://…) 또는 실행 명령이 필요합니다. 예: dogent mcp add mes -- npx -y @회사/mes-mcp');
  if (Object.keys(headers).length) throw new Error('--header는 원격(http/sse) 서버에만 쓸 수 있습니다');
  return result({ command, ...(args.length ? { args } : {}), ...(Object.keys(env).length ? { env } : {}) });
}

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const strings = (v: unknown): Record<string, string> | undefined => {
  if (!isObject(v)) return undefined;
  const out = Object.fromEntries(Object.entries(v).filter(([, x]) => typeof x === 'string' || typeof x === 'number').map(([k, x]) => [k, String(x)]));
  return Object.keys(out).length ? out : undefined;
};

/** 서버 설정 하나를 읽는다. 모르는 모양이면 이유와 함께 던진다. */
export function normalizeServer(name: string, raw: unknown): McpServerSpec {
  if (!isObject(raw)) throw new Error(`${name}: 서버 설정이 객체가 아닙니다`);
  const type = typeof raw.type === 'string' ? raw.type.toLowerCase() : '';
  const url = typeof raw.url === 'string' ? raw.url : typeof raw.serverUrl === 'string' ? raw.serverUrl : typeof raw.httpUrl === 'string' ? raw.httpUrl : undefined;
  // Dogent 설정의 권한·키워드는 그대로 보존한다 (다른 도구의 설정에는 없다)
  const perms = isObject(raw.permissions)
    ? Object.fromEntries(Object.entries(raw.permissions).filter(([, v]) => v === 'allow' || v === 'ask' || v === 'deny'))
    : {};
  const disabled = {
    ...(raw.disabled === true || raw.enabled === false ? { disabled: true } : {}),
    ...(Object.keys(perms).length ? { permissions: perms as McpServerSpec['permissions'] } : {}),
    ...(Array.isArray(raw.keywords) ? { keywords: raw.keywords.map(String) } : {}),
  };
  if (url && type !== 'stdio' && type !== 'local') {
    if (!URL_RE.test(url)) throw new Error(`${name}: 주소는 http:// 또는 https:// 로 시작해야 합니다 (${url})`);
    const headers = strings(raw.headers);
    return { url, transport: type === 'sse' ? 'sse' : 'http', ...(headers ? { headers } : {}), ...disabled };
  }
  // opencode는 명령을 배열 하나로 적는다
  const cmd = raw.command;
  const parts = Array.isArray(cmd) ? cmd.map(String) : typeof cmd === 'string' ? [cmd, ...(Array.isArray(raw.args) ? raw.args.map(String) : [])] : [];
  if (parts.length === 0) throw new Error(`${name}: command(실행 명령)나 url(주소)이 없습니다`);
  const env = strings(raw.env) ?? strings(raw.environment);
  return {
    command: parts[0],
    ...(parts.length > 1 ? { args: parts.slice(1) } : {}),
    ...(env ? { env } : {}),
    ...(typeof raw.cwd === 'string' ? { cwd: raw.cwd } : {}),
    ...disabled,
  };
}

const looksLikeServer = (v: unknown) => isObject(v) && ('command' in v || 'url' in v || 'serverUrl' in v || 'httpUrl' in v);

/**
 * mcp.json의 여러 모양을 이름 → 설정으로 바꾼다.
 * {"mcpServers": …} (Claude Code, Cursor), {"servers": …} (VS Code, Dogent), {"mcp": …} (opencode),
 * 또는 서버 설정이 바로 이름 아래 있는 객체. 서버 하나만 적은 객체는 fallbackName을 이름으로 쓴다.
 */
export function normalizeServers(input: unknown, fallbackName?: string): Record<string, McpServerSpec> {
  if (!isObject(input)) throw new Error('설정이 JSON 객체가 아닙니다');
  if (Object.keys(input).length === 0) return {};
  const root = [input.mcpServers, input.servers, input.mcp].find(isObject);
  let table: Record<string, unknown>;
  if (root) table = root;
  else if (looksLikeServer(input)) {
    if (!fallbackName) throw new Error('서버 하나만 적은 설정이라 이름이 필요합니다');
    table = { [fallbackName]: input };
  } else if (Object.values(input).length > 0 && Object.values(input).every(looksLikeServer)) table = input;
  else throw new Error('서버 목록(mcpServers, servers, mcp)을 찾지 못했습니다');
  const out: Record<string, McpServerSpec> = {};
  const errors: string[] = [];
  for (const [name, raw] of Object.entries(table)) {
    try {
      if (!/^[A-Za-z0-9_.-]+$/.test(name)) throw new Error(`${name}: 서버 이름은 영문·숫자·-_. 만 쓸 수 있습니다`);
      out[name] = normalizeServer(name, raw);
    } catch (e) {
      errors.push((e as Error).message);
    }
  }
  if (errors.length > 0 && Object.keys(out).length === 0) throw new Error(errors.join('\n'));
  if (errors.length > 0) throw new Error(`일부 서버를 읽지 못했습니다:\n${errors.join('\n')}`);
  return out;
}

/** 설치 전에 사용자에게 보여 줄 줄들. 이 PC에서 실행될 명령, 데이터를 보낼 주소를 그대로 적는다. */
export function describeInstall(name: string, spec: McpServerSpec): string[] {
  if (spec.url) {
    const h = Object.keys(spec.headers ?? {});
    return [
      `${name}: 원격 서버 (${spec.transport === 'sse' ? 'SSE' : 'HTTP'})`,
      `  주소: ${spec.url}`,
      ...(h.length ? [`  보내는 헤더: ${h.join(', ')}`] : []),
      '  이 서버로 도구 호출의 인자(요청에 쓴 값)가 전송됩니다.',
    ];
  }
  const env = Object.keys(spec.env ?? {});
  return [
    `${name}: 이 PC에서 실행되는 서버 (stdio)`,
    `  명령: ${[spec.command, ...(spec.args ?? [])].join(' ')}`,
    ...(env.length ? [`  환경 변수: ${env.join(', ')}`] : []),
    '  이 명령은 설치 후 서버를 쓸 때마다 이 PC에서 실행됩니다. 아는 서버만 더하세요.',
  ];
}
