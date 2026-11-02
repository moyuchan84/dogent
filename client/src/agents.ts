import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, extname, isAbsolute, join } from 'node:path';
import { dogentHome } from './config';
import type { Permission } from './mcp-hub';
import { McpPeer, type McpToolInfo } from './mcp-peer';

/**
 * 사내의 다른 코딩 에이전트(Claude Code, opencode + GLM)를 Dogent가 부르는 통로 (docs/17 3절).
 *
 * Dogent는 사내 웹 화면·엑셀을 다루고, 코드 작성·파일 분석·스크립트 실행처럼 PC에서 하는 일은 그 에이전트에 맡긴다.
 * 에이전트 하나는 MCP 서버 하나처럼 보인다 (도구 `<이름>.ask`). 그래서 자유 요청이 call_tool로 부르고,
 * 권한(allow/ask/deny)·키워드·끄고 켜기가 MCP 서버와 같다. 기본 권한은 ask: 부를 때마다 무엇을 맡기는지 보여 주고 묻는다.
 *
 * 부르는 방식은 두 CLI의 비대화 모드다.
 *   claude   -p --output-format json [추가 인자]   할 일은 stdin으로, 답은 JSON의 result
 *   opencode run [추가 인자]                       할 일은 stdin으로, 답은 stdout 글
 * 할 일은 늘 stdin으로 넘긴다. 명령줄 인자로 넘기면 윈도우의 .cmd 실행 파일이 셸을 거치며 따옴표·& 같은 글자가 명령으로 읽힐 수 있다.
 *
 * 설정: ~/.dogent/agents.json  {"agents": {"claude": {"kind": "claude"}, "opencode": {"kind": "opencode", "args": ["-m", "<제공자>/glm-5.3"]}}}
 */
export type AgentKind = 'claude' | 'opencode' | 'command';

export interface AgentSpec {
  kind: AgentKind;
  /** 실행 파일. 안 적으면 claude / opencode를 PATH(와 ~/.local/bin)에서 찾는다. kind가 command면 꼭 적는다 */
  command?: string;
  /** 덧붙일 인자 (예: claude는 ["--model", "sonnet"], opencode는 ["-m", "사내/glm-5.3"]) */
  args?: string[];
  /** 일할 폴더. 에이전트가 만드는 파일이 여기에 생긴다. 기본은 결과 저장 폴더 */
  workdir?: string;
  /** 한 번에 기다리는 시간 (기본 600초) */
  timeoutSec?: number;
  /** 기본 ask (부를 때마다 묻는다) */
  permission?: Permission;
  /** 요청에 이 말이 나오면 브라우저 없이 이 에이전트로 처리한다 (이름은 늘 해당) */
  keywords?: string[];
  /** 모델에 보여 줄 설명 (무엇을 잘하는지) */
  description?: string;
  disabled?: boolean;
}

export interface AgentsConfig {
  agents: Record<string, AgentSpec>;
}

export const agentsFile = () => join(dogentHome(), 'agents.json');

/** 미리 정해 둔 두 에이전트 */
export const PRESETS: Record<'claude' | 'opencode', Required<Pick<AgentSpec, 'kind' | 'description' | 'keywords'>> & Pick<AgentSpec, 'args'>> = {
  claude: {
    kind: 'claude',
    description:
      'Claude Code (사내에서 쓰는 코딩 에이전트). PC의 파일을 읽고, 코드·스크립트를 쓰고, 표 파일(csv·xlsx)을 분석하고, 문서를 정리한다. 사내 웹 화면은 다루지 못한다',
    keywords: ['claude', '클로드', '클로드코드', '클로드 코드', 'claude code'],
    // 일할 폴더 안의 파일 쓰기만 묻지 않고 한다. 명령 실행(Bash)은 비대화 모드에서 막힌다 (필요하면 --allowedTools로 연다)
    args: ['--permission-mode', 'acceptEdits'],
  },
  opencode: {
    kind: 'opencode',
    description: 'opencode (사내 GLM 모델로 도는 코딩 에이전트). PC의 파일을 읽고, 코드·스크립트를 쓰고 돌리고, 표 파일을 분석한다. 사내 웹 화면은 다루지 못한다',
    keywords: ['opencode', '오픈코드', '오픈 코드', 'glm'],
  },
};

export function loadAgents(): AgentsConfig {
  const file = agentsFile();
  if (!existsSync(file)) return { agents: {} };
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as Partial<AgentsConfig>;
    const out: Record<string, AgentSpec> = {};
    for (const [name, spec] of Object.entries(raw.agents ?? {})) {
      if (!/^[A-Za-z0-9_-]+$/.test(name)) throw new Error(`에이전트 이름은 영문·숫자·-_ 만 쓸 수 있습니다: ${name}`);
      const kind = spec?.kind ?? (name === 'claude' || name === 'opencode' ? name : undefined);
      if (kind !== 'claude' && kind !== 'opencode' && kind !== 'command') throw new Error(`${name}: kind는 claude, opencode, command 중 하나입니다`);
      if (kind === 'command' && !spec.command) throw new Error(`${name}: kind가 command면 command(실행 파일)를 적어야 합니다`);
      out[name] = { ...spec, kind };
    }
    return { agents: out };
  } catch (e) {
    throw new Error(`${file}을(를) 읽지 못했습니다: ${(e as Error).message}`);
  }
}

export function saveAgents(cfg: AgentsConfig): string {
  const file = agentsFile();
  mkdirSync(dogentHome(), { recursive: true });
  writeFileSync(file, JSON.stringify(cfg, null, 2));
  return file;
}

export const enabledAgents = (cfg: AgentsConfig) => Object.entries(cfg.agents).filter(([, a]) => !a.disabled);

/** 요청이 이 에이전트를 말하는지 (이름, 미리 정한 말, keywords) */
export function mentionedAgents(cfg: AgentsConfig, text: string): string[] {
  const t = text.toLowerCase();
  return enabledAgents(cfg)
    .filter(([name, a]) => [name, ...(a.kind !== 'command' ? PRESETS[a.kind].keywords : []), ...(a.keywords ?? [])].some((w) => w.trim().length >= 2 && t.includes(w.trim().toLowerCase())))
    .map(([name]) => name);
}

/** 실행 파일을 PATH에서 찾는다 (윈도우는 PATHEXT까지). 못 찾으면 null */
export function findExecutable(command: string, env: NodeJS.ProcessEnv = process.env): string | null {
  if (isAbsolute(command) || /[\\/]/.test(command)) return existsSync(command) ? command : null;
  const exts = process.platform === 'win32' ? (env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean) : [''];
  const dirs = [...(env.PATH ?? env.Path ?? '').split(delimiter).filter(Boolean), join(homedir(), '.local', 'bin')];
  for (const dir of dirs) {
    for (const ext of extname(command) ? [''] : exts) {
      const file = join(dir, command + ext.toLowerCase());
      if (existsSync(file)) return file;
      const upper = join(dir, command + ext);
      if (existsSync(upper)) return upper;
    }
  }
  return null;
}

export interface Invocation {
  file: string;
  args: string[];
  /** .cmd·.bat은 셸을 거쳐야 뜬다 */
  shell: boolean;
}

/** 에이전트를 띄울 명령. 할 일은 여기 들어가지 않는다 (stdin으로 간다) */
export function invocation(spec: AgentSpec): Invocation {
  const command = spec.command ?? (spec.kind === 'command' ? '' : spec.kind);
  const file = findExecutable(command);
  if (!file) {
    throw new Error(
      `${command || '(명령 없음)'}을(를) 찾지 못했습니다. 설치되어 있으면 실행 파일 경로를 알려 주세요: dogent agents add ${spec.kind === 'command' ? '<이름>' : spec.kind} --command <경로>`,
    );
  }
  const base = spec.kind === 'claude' ? ['-p', '--output-format', 'json'] : spec.kind === 'opencode' ? ['run'] : [];
  const extra = spec.args ?? (spec.kind !== 'command' ? (PRESETS[spec.kind].args ?? []) : []);
  const shell = process.platform === 'win32' && /\.(cmd|bat)$/i.test(file);
  return { file: shell ? `"${file}"` : file, args: shell ? [...base, ...extra].map(quoteForCmd) : [...base, ...extra], shell };
}

/** 셸(cmd)을 거칠 때 설정에 적은 인자를 한 덩어리로 넘긴다 (할 일은 인자로 넘기지 않으므로 사용자가 적은 값만 여기를 지난다) */
const quoteForCmd = (a: string) => (/^[A-Za-z0-9_\-./:=@]+$/.test(a) ? a : `"${a.replace(/"/g, '""')}"`);

/** 에이전트에 넘길 글: 할 일 + 일할 폴더 + 답하는 방식 */
export function agentPrompt(task: string, workdir: string): string {
  return [
    task.trim(),
    '',
    '---',
    `일할 폴더: ${workdir}`,
    '- 만드는 파일은 이 폴더에 둔다. 요청에 없는 파일은 고치거나 지우지 않는다.',
    '- 사내 웹 화면은 다루지 않는다 (그 일은 Dogent가 한다).',
    '- 끝나면 한 일과 결과(만든 파일의 경로, 답)를 짧게 한국어로 적는다.',
  ].join('\n');
}

export interface AgentReply {
  ok: boolean;
  text: string;
  elapsedMs: number;
  /** claude: 이번 호출의 비용 (달러), 세션 id */
  costUsd?: number;
  sessionId?: string;
}

/** 답을 이만큼까지만 돌려준다 (작은 모델의 프롬프트에 들어간다) */
const REPLY_MAX = 20_000;

/** claude -p --output-format json의 답에서 결과 글을 꺼낸다. JSON이 아니면 그대로 */
export function parseReply(kind: AgentKind, stdout: string): Omit<AgentReply, 'elapsedMs'> {
  const out = stdout.trim();
  if (kind === 'claude') {
    try {
      const j = JSON.parse(out.slice(out.indexOf('{'))) as { result?: string; is_error?: boolean; total_cost_usd?: number; session_id?: string; permission_denials?: unknown[] };
      const denied = Array.isArray(j.permission_denials) && j.permission_denials.length ? `\n(권한이 없어 하지 못한 동작 ${j.permission_denials.length}개)` : '';
      return { ok: !j.is_error, text: `${j.result ?? ''}${denied}`.trim(), costUsd: j.total_cost_usd, sessionId: j.session_id };
    } catch {
      // JSON이 아니면 글 그대로
    }
  }
  // opencode는 진행 표시에 색 글자를 섞어 낼 수 있다
  return { ok: true, text: out.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '') };
}

/** 에이전트에 일 하나를 맡기고 끝나기를 기다린다 */
export function runAgent(
  spec: AgentSpec,
  task: string,
  opts: { workdir: string; signal?: AbortSignal; onLine?: (line: string) => void; spawnFn?: typeof spawn },
): Promise<AgentReply> {
  const inv = invocation(spec);
  const workdir = spec.workdir ?? opts.workdir;
  mkdirSync(workdir, { recursive: true });
  const started = Date.now();
  const timeoutMs = (spec.timeoutSec ?? 600) * 1000;
  return new Promise((resolve, reject) => {
    const child = (opts.spawnFn ?? spawn)(inv.file, inv.args, { cwd: workdir, shell: inv.shell, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, NO_COLOR: '1' } });
    let stdout = '';
    let stderr = '';
    let done = false;
    const finish = (fn: () => void) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', stop);
      fn();
    };
    const stop = () => {
      child.kill();
      finish(() => reject(new Error('사용자가 중지했습니다')));
    };
    const timer = setTimeout(() => {
      child.kill();
      finish(() => reject(new Error(`${Math.round(timeoutMs / 1000)}초 안에 끝나지 않았습니다 (agents.json의 timeoutSec으로 늘림)`)));
    }, timeoutMs);
    opts.signal?.addEventListener('abort', stop, { once: true });
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (c: string) => {
      stdout += c;
      if (spec.kind !== 'claude') for (const l of c.split(/\r?\n/)) if (l.trim()) opts.onLine?.(l);
    });
    child.stderr.on('data', (c: string) => (stderr += c));
    child.on('error', (e) => finish(() => reject(new Error(`${inv.file}을(를) 띄우지 못했습니다: ${e.message}`))));
    child.on('close', (code) =>
      finish(() => {
        const reply = parseReply(spec.kind, stdout);
        const elapsedMs = Date.now() - started;
        if (code !== 0 && !reply.text) {
          return resolve({ ok: false, text: `끝남 코드 ${code}: ${stderr.trim().split('\n').slice(-5).join('\n') || '(메시지 없음)'}`, elapsedMs });
        }
        const text = reply.text.length > REPLY_MAX ? `${reply.text.slice(0, REPLY_MAX)}\n…(뒤 ${reply.text.length - REPLY_MAX}자 줄임)` : reply.text;
        resolve({ ...reply, ok: reply.ok && code === 0, text: text || '(답이 비어 있습니다)', elapsedMs });
      }),
    );
    child.stdin.on('error', () => {});
    child.stdin.end(agentPrompt(task, workdir), 'utf8');
  });
}

/** 에이전트 하나를 MCP 서버처럼 보이게 한다. McpHub가 다른 서버와 같은 목록에 넣는다 */
export class AgentPeer extends McpPeer {
  constructor(
    private name: string,
    private spec: AgentSpec,
    private workdir: string,
    private log?: (line: string) => void,
  ) {
    super();
  }

  tool(): McpToolInfo {
    const desc = this.spec.description ?? (this.spec.kind !== 'command' ? PRESETS[this.spec.kind].description : `${this.name} 에이전트`);
    return {
      name: 'ask',
      description: `${desc}. 할 일을 문장으로 맡기면 끝난 뒤 결과를 글로 돌려준다 (몇 분 걸릴 수 있다). 파일은 경로로 알려 준다. 일할 폴더: ${this.spec.workdir ?? this.workdir}`,
      inputSchema: { properties: { task: { type: 'string', description: '맡길 일. 필요한 값·파일 경로·원하는 결과 모양을 모두 적는다' } }, required: ['task'] },
      annotations: { readOnlyHint: false },
    };
  }

  async request(method: string, params?: Record<string, unknown>): Promise<unknown> {
    if (method === 'tools/list') return { tools: [this.tool()] };
    if (method === 'tools/call') {
      const args = (params?.arguments ?? {}) as Record<string, unknown>;
      const r = await this.ask(String(args.task ?? ''));
      return { content: [{ type: 'text', text: r.text }], isError: !r.ok };
    }
    throw new Error(`지원하지 않는 요청: ${method}`);
  }

  /** McpHub는 120초로 기다리지만 에이전트는 그보다 오래 걸린다. 에이전트의 timeoutSec을 따른다 */
  override async callText(name: string, args: Record<string, unknown>): Promise<{ text: string; isError: boolean }> {
    if (name !== 'ask') return { text: `모르는 도구: ${name}`, isError: true };
    const r = await this.ask(String(args.task ?? ''));
    return { text: r.text, isError: !r.ok };
  }

  async ask(task: string, signal?: AbortSignal): Promise<AgentReply> {
    if (!task.trim()) return { ok: false, text: 'task(맡길 일)가 비어 있습니다', elapsedMs: 0 };
    this.log?.(`${this.name}에 맡기는 중… (${task.replace(/\s+/g, ' ').slice(0, 60)})`);
    try {
      const r = await runAgent(this.spec, task, { workdir: this.workdir, signal, onLine: (l) => this.log?.(`[${this.name}] ${l.slice(0, 200)}`) });
      this.log?.(`${this.name} 끝남 (${Math.round(r.elapsedMs / 1000)}초${r.costUsd !== undefined ? `, $${r.costUsd.toFixed(3)}` : ''})`);
      return r;
    } catch (e) {
      return { ok: false, text: (e as Error).message, elapsedMs: 0 };
    }
  }

  async close(): Promise<void> {}
}

/** `dogent agents`에 보여 줄 줄 */
export function describeAgents(cfg: AgentsConfig, defaultWorkdir: string): string[] {
  const rows = Object.entries(cfg.agents);
  if (rows.length === 0) {
    const found = (['claude', 'opencode'] as const).map((k) => `${k}: ${findExecutable(k) ?? '(이 PC에서 찾지 못함)'}`);
    return [`연결한 에이전트가 없습니다. 더하려면: dogent agents add claude  /  dogent agents add opencode --args "-m <제공자>/<모델>"`, ...found.map((l) => `  ${l}`), `  (설정 파일 ${agentsFile()})`];
  }
  return rows.map(([name, a]) => {
    let where: string;
    try {
      const inv = invocation(a);
      where = [inv.file.replace(/"/g, ''), ...inv.args].join(' ');
    } catch (e) {
      where = `(실행 파일 없음) ${(e as Error).message.split('.')[0]}`;
    }
    return `${a.disabled ? '(꺼짐) ' : ''}${name}  [${a.kind}, ${a.permission ?? 'ask'}]  ${where}  · 일할 폴더 ${a.workdir ?? defaultWorkdir}`;
  });
}
