import { createServer, type Server } from 'node:http';
import { createInterface } from 'node:readline';
import { searchSystems, type ApprovalRequest, type RunEvent, type RunResult } from '../../src/core';
import type { BrowserLink } from '../../bridge/hub.mjs';
import type { Session, SessionOptions, Ui } from './session';
import { describeApproval, describeEvent, describeResult } from './terminal';

/**
 * Dogent를 MCP 서버로 내놓는다. Claude Code·opencode가 사내 웹 업무를 Dogent에 맡긴다 (docs/17 3절).
 *
 *   Claude Code / opencode ──MCP── Dogent (스킬, 사내 모델, 시스템 사전) ── 확장 ── 사내 웹 화면
 *
 * 브라우저 도구 하나하나(bridge/hub.mjs)를 내놓는 것과 다르다. 여기서는 "요청 하나", "스킬 하나"를 통째로 맡긴다.
 * 스킬 고르기·화면 조작·검사·승인은 Dogent가 하고, 부른 쪽은 결과(요약, 파일, 데이터셋)만 받는다.
 * 저장·상신 승인 창, 조작할 사이트 목록, 로그인 대기는 그대로 확장이 지킨다 (docs/09 D6).
 *
 * 띄우는 곳
 *   dogent serve                   stdio (Claude Code가 띄운다). 브리지를 자기 안에 띄우므로 Dogent 앱을 끈 PC에서
 *   Dogent 앱 (config mcpServePort) http://127.0.0.1:<포트>/mcp, 브리지 토큰을 Bearer로. 앱이 켜져 있으면 이쪽.
 *                                   앱에서는 요청이 대화에 보이고, 실행 확인을 사람이 앱에서 한다
 */

type Json = Record<string, unknown>;
export interface RpcMessage {
  jsonrpc?: '2.0';
  id?: number | string | null;
  method?: string;
  params?: Json;
}

export const SERVE_INFO = { name: 'dogent', version: '0.1.0' };
const PROTOCOLS = ['2025-06-18', '2025-03-26', '2024-11-05'];

export interface RunReport {
  ok: boolean;
  /** 실행 중 Dogent가 남긴 글 (단계, 승인 안내, 결과) */
  transcript: string;
  result?: RunResult;
  saved: string[];
}

/** Dogent에 일을 맡기는 쪽이 쓰는 것. 터미널(dogent serve)과 앱이 각자 만든다 */
export interface DogentRunner {
  request(text: string, opts: { allowWrite: boolean; dryRun: boolean; caller: string }): Promise<RunReport>;
  runSkill(id: string, inputs: Record<string, string>, opts: { dryRun: boolean; caller: string }): Promise<RunReport>;
  skills(query?: string): Promise<{ id: string; name: string; description: string; source: string; risk: string; inputs: { name: string; label: string; type: string; required: boolean }[] }[]>;
  systems(query?: string): { id: string; name: string; description: string; url: string; status: string }[];
  newConversation(): void;
}

const TOOLS = [
  {
    name: 'dogent_request',
    title: 'Dogent에 사내 웹 업무 맡기기',
    description:
      '사내 웹 시스템(MES, GSAMS 등)에서 할 일을 말로 맡긴다. Dogent가 맞는 스킬을 골라 실행하고, 없으면 지금 브라우저 화면에서 직접 한다. ' +
      '결과 요약·저장한 파일 경로·만든 데이터셋을 돌려준다. 앞선 요청을 이어서 말할 수 있다 ("방금 조회한 것 중 7라인만"). ' +
      '필요한 값(라인, 기간, 파일 경로)은 요청에 모두 적는다 (도중에 되묻지 못한다). 저장·상신은 allow_write를 켜야 하고, 켜도 브라우저의 승인 창에서 사람이 승인한다. 몇 분 걸릴 수 있다.',
    inputSchema: {
      type: 'object',
      properties: {
        request: { type: 'string', description: '할 일 (예: "MES에서 7라인 재공 조회해서 정체 Lot을 엑셀로")' },
        allow_write: { type: 'boolean', description: '저장·상신 버튼을 눌러도 되는지 (기본 false). 눌러도 승인 창을 거친다' },
        dry_run: { type: 'boolean', description: '저장·상신 직전에 멈춘다 (기본 false)' },
      },
      required: ['request'],
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  },
  {
    name: 'dogent_run_skill',
    title: 'Dogent 스킬 실행',
    description: 'Dogent 스킬 하나를 정한 입력값으로 실행한다. 스킬 id와 입력 이름은 dogent_skills로 본다. 파일 입력은 PC의 파일 경로로 준다.',
    inputSchema: {
      type: 'object',
      properties: {
        skill_id: { type: 'string' },
        inputs: { type: 'object', description: '입력 이름 → 값', additionalProperties: { type: 'string' } },
        dry_run: { type: 'boolean', description: '저장·상신 직전에 멈춘다' },
      },
      required: ['skill_id'],
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  },
  {
    name: 'dogent_skills',
    title: 'Dogent 스킬 목록',
    description: 'Dogent가 가진 사내 업무 스킬 (개인 > 팀 > 기본). query를 주면 말로 찾는다 (예: "홀드 해제").',
    inputSchema: { type: 'object', properties: { query: { type: 'string' } } },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'dogent_systems',
    title: '사내 시스템 사전',
    description: '사내 시스템의 이름·별칭·주소. query로 찾는다 (예: "지삼스", "방화벽 신청").',
    inputSchema: { type: 'object', properties: { query: { type: 'string' } } },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'dogent_new_conversation',
    title: '새 대화',
    description: 'Dogent가 기억하는 앞선 요청과 데이터셋을 지운다. 관계없는 새 일을 맡기기 전에 부른다.',
    inputSchema: { type: 'object', properties: {} },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
];

/** 결과를 부른 쪽이 읽을 글로 */
export function reportText(r: RunReport): string {
  const res = r.result;
  const head = res
    ? {
        status: res.status,
        message: res.message,
        files: r.saved,
        datasets: res.datasets,
        outputs: res.outputs,
        actions: res.actions,
        elapsed_sec: Math.round(res.elapsedMs / 1000),
      }
    : { status: r.ok ? 'done' : 'not_run' };
  const log = r.transcript.length > 6000 ? `…${r.transcript.slice(-6000)}` : r.transcript;
  return `${JSON.stringify(head, null, 1)}\n\n--- Dogent 진행 기록 ---\n${log}`;
}

export class DogentMcp {
  private busy = false;
  /** initialize의 clientInfo.name (예: claude-code, opencode) */
  caller = 'MCP 클라이언트';

  constructor(private runner: DogentRunner) {}

  async handle(msg: RpcMessage): Promise<Json | null> {
    const reply = (body: Json) => ({ jsonrpc: '2.0', id: msg.id ?? null, ...body });
    if (msg.id === undefined || msg.id === null) return null;
    try {
      switch (msg.method) {
        case 'initialize': {
          const asked = String(msg.params?.protocolVersion ?? '');
          const info = msg.params?.clientInfo as { name?: string } | undefined;
          if (info?.name) this.caller = info.name;
          return reply({
            result: {
              protocolVersion: PROTOCOLS.includes(asked) ? asked : PROTOCOLS[0],
              capabilities: { tools: { listChanged: false } },
              serverInfo: SERVE_INFO,
              instructions:
                '사내 웹 시스템 업무는 Dogent에 맡긴다 (dogent_request). Dogent가 스킬·사내 모델·브라우저 확장으로 화면을 다루고, 저장·상신은 사람이 승인한다. ' +
                '맡길 때는 필요한 값을 요청에 모두 적는다. 결과 파일 경로를 받아 이어서 분석할 수 있다.',
            },
          });
        }
        case 'ping':
          return reply({ result: {} });
        case 'tools/list':
          return reply({ result: { tools: TOOLS } });
        case 'tools/call': {
          const name = String(msg.params?.name ?? '');
          const args = (msg.params?.arguments ?? {}) as Json;
          const { text, isError } = await this.call(name, args);
          return reply({ result: { content: [{ type: 'text', text }], isError } });
        }
        default:
          return reply({ error: { code: -32601, message: `모르는 요청: ${msg.method}` } });
      }
    } catch (e) {
      return reply({ error: { code: -32603, message: (e as Error).message } });
    }
  }

  async call(name: string, args: Json): Promise<{ text: string; isError: boolean }> {
    const ok = (v: unknown) => ({ text: typeof v === 'string' ? v : JSON.stringify(v, null, 1), isError: false });
    const fail = (m: string) => ({ text: m, isError: true });
    if (name === 'dogent_skills') return ok(await this.runner.skills(args.query ? String(args.query) : undefined));
    if (name === 'dogent_systems') return ok(this.runner.systems(args.query ? String(args.query) : undefined));
    if (name === 'dogent_new_conversation') {
      this.runner.newConversation();
      return ok('새 대화를 시작했습니다');
    }
    if (name !== 'dogent_request' && name !== 'dogent_run_skill') return fail(`모르는 도구: ${name}`);
    if (this.busy) return fail('Dogent가 다른 일을 하는 중입니다. 끝난 뒤에 다시 부르세요');
    this.busy = true;
    try {
      let r: RunReport;
      if (name === 'dogent_request') {
        const text = String(args.request ?? '').trim();
        if (!text) return fail('request가 비어 있습니다');
        r = await this.runner.request(text, { allowWrite: args.allow_write === true, dryRun: args.dry_run === true, caller: this.caller });
      } else {
        const id = String(args.skill_id ?? '').trim();
        if (!id) return fail('skill_id가 필요합니다');
        const inputs = Object.fromEntries(Object.entries((args.inputs ?? {}) as Json).map(([k, v]) => [k, String(v)]));
        r = await this.runner.runSkill(id, inputs, { dryRun: args.dry_run === true, caller: this.caller });
      }
      return { text: reportText(r), isError: !r.ok };
    } finally {
      this.busy = false;
    }
  }
}

/**
 * 실행 중 세션이 남기는 글과 결과를 모은다. 사람이 없는 곳(dogent serve)에서는 이것이 세션의 Ui이고,
 * 앱에서는 창의 Ui가 이쪽으로도 흘려보낸다 (사람이 앱에서 보고 답한다).
 */
export class Collector implements Ui {
  private lines: string[] = [];
  private last: { result: RunResult; saved: string[] } | undefined;

  begin(): void {
    this.lines = [];
    this.last = undefined;
  }

  end(ok: boolean): RunReport {
    return { ok, transcript: this.lines.join('\n').trim(), result: this.last?.result, saved: this.last?.saved ?? [] };
  }

  print(text: string): void {
    this.lines.push(text);
  }

  /** 사람이 없으니 되묻는 말에는 답하지 못한다. 부른 쪽이 요청에 값을 모두 적어야 한다 */
  async ask(question: string): Promise<string | null> {
    this.lines.push(`${question.trim()} (외부 호출이라 답하지 못했습니다. 필요한 값을 요청에 적어 다시 부르세요)`);
    return null;
  }

  /** 확인은 안전한 쪽(아니오)으로. 실행 확인은 --yes로 건너뛰고, 그 밖의 것(엑셀 쓰기, 스크립트, 바꾸는 도구)은 하지 않는다 */
  async confirm(question: string, _fallback: boolean): Promise<boolean> {
    this.lines.push(`${question.trim()} → 아니오 (외부 호출에서는 사람이 확인할 수 없어 하지 않습니다)`);
    return false;
  }

  async askDefault(question: string, fallback: string): Promise<string> {
    this.lines.push(`${question.trim()} → ${fallback || '(빈 값)'}`);
    return fallback;
  }

  started(skill: string, page: string): void {
    this.lines.push(`${skill} 실행 — ${page}`);
  }

  runEvent(e: RunEvent): void {
    const line = describeEvent(e);
    if (line) this.lines.push(line);
  }

  approval(request: ApprovalRequest): void {
    this.lines.push(describeApproval(request));
  }

  result(result: RunResult, saved: string[]): void {
    this.last = { result, saved };
    this.lines.push(describeResult(result, saved));
  }

  connected?(_b: BrowserLink[], _via: string | null): void {}
}

/**
 * 세션 하나로 DogentRunner를 만든다. flags는 세션이 쓰는 것과 같은 객체여야 한다 (호출마다 allow_write·dry_run을 바꾼다).
 * collector는 세션이 남기는 글을 받는 곳 (serve: 세션의 Ui 자체, 앱: 창 Ui가 흘려보내는 곳).
 */
export function sessionRunner(get: () => Session, flags: SessionOptions, collector: Collector, hooks: { before?: (what: string, caller: string) => void } = {}): DogentRunner {
  const run = async (what: string, caller: string, allowWrite: boolean, dryRun: boolean, work: (s: Session) => Promise<boolean>): Promise<RunReport> => {
    const saved = { allowWrite: flags.allowWrite, dryRun: flags.dryRun };
    flags.allowWrite = allowWrite;
    flags.dryRun = dryRun;
    collector.begin();
    hooks.before?.(what, caller);
    try {
      const ok = await work(get());
      return collector.end(ok);
    } catch (e) {
      collector.print(`오류: ${(e as Error).message}`);
      return collector.end(false);
    } finally {
      flags.allowWrite = saved.allowWrite;
      flags.dryRun = saved.dryRun;
    }
  };
  return {
    request: (text, o) => run(text, o.caller, o.allowWrite, o.dryRun, (s) => s.request(text)),
    runSkill: (id, inputs, o) =>
      run(
        `스킬 ${id}`,
        o.caller,
        false,
        o.dryRun,
        (s) => s.runSkillById(id, Object.entries(inputs).map(([k, v]) => `${k}=${v}`)),
      ),
    async skills(query) {
      const s = get();
      const entries = query?.trim() ? (await s.searchSkills(query)).map((h) => h.item) : s.skillList();
      return entries.map((e) => ({
        id: e.skill.id,
        name: e.skill.name,
        description: e.skill.description,
        source: e.source,
        risk: e.skill.risk,
        inputs: e.skill.inputs.map((i) => ({ name: i.name, label: i.label ?? i.name, type: i.type, required: i.required })),
      }));
    },
    systems(query) {
      const all = get().systemList().map((e) => e.system);
      const picked = query?.trim() ? searchSystems(all, query, 10) : all;
      return picked.map((s) => ({ id: s.id, name: s.name, description: s.description, url: s.url, status: s.status }));
    },
    newConversation: () => get().newConversation(),
  };
}

/** stdio로 MCP를 받는다 (Claude Code가 dogent serve를 띄울 때). stdout은 통신에만 쓴다 */
export function serveStdio(mcp: DogentMcp): Promise<void> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin });
    rl.on('line', (line) => {
      if (!line.trim()) return;
      let msg: RpcMessage;
      try {
        msg = JSON.parse(line) as RpcMessage;
      } catch {
        process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'JSON이 아닙니다' } })}\n`);
        return;
      }
      void mcp.handle(msg).then((out) => {
        if (out) process.stdout.write(`${JSON.stringify(out)}\n`);
      });
    });
    rl.on('close', () => resolve());
  });
}

/** HTTP(Streamable HTTP, 답은 JSON)로 MCP를 받는다. 이 PC 안(127.0.0.1)에서만, 토큰이 맞을 때만 */
export function serveHttp(mcp: DogentMcp, opts: { port: number; token: string; host?: string; log?: (line: string) => void }): Promise<Server> {
  const server = createServer((req, res) => {
    const path = (req.url ?? '/').split('?')[0];
    const send = (status: number, body?: unknown) => {
      res.writeHead(status, body === undefined ? {} : { 'content-type': 'application/json; charset=utf-8' });
      res.end(body === undefined ? undefined : JSON.stringify(body));
    };
    if (req.method === 'GET' && path === '/health') return send(200, { ok: true, name: SERVE_INFO.name });
    if (path !== '/mcp') return send(404, { error: '주소는 /mcp 입니다' });
    if (req.headers.authorization !== `Bearer ${opts.token}`) return send(401, { error: '인증이 필요합니다 (Authorization: Bearer <dogent token>)' });
    // 웹페이지가 이 주소로 요청을 보내는 것을 막는다 (브라우저는 Origin을 붙인다)
    if (req.headers.origin) return send(403, { error: '브라우저에서 온 요청은 받지 않습니다' });
    if (req.method === 'DELETE') return send(204);
    if (req.method !== 'POST') return send(405, { error: 'POST만 받습니다' });
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (c: string) => {
      body += c;
      if (body.length > 1_000_000) req.destroy();
    });
    req.on('end', async () => {
      let parsed: RpcMessage | RpcMessage[];
      try {
        parsed = JSON.parse(body) as RpcMessage | RpcMessage[];
      } catch {
        return send(400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'JSON이 아닙니다' } });
      }
      const list = Array.isArray(parsed) ? parsed : [parsed];
      const out = (await Promise.all(list.map((m) => mcp.handle(m)))).filter((x) => x !== null);
      if (out.length === 0) return send(202);
      send(200, Array.isArray(parsed) ? out : out[0]);
    });
  });
  // 요청 하나가 몇 분 걸린다 (화면 조작, 승인 대기)
  server.requestTimeout = 0;
  server.headersTimeout = 60_000;
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port, opts.host ?? '127.0.0.1', () => {
      opts.log?.(`Dogent MCP: http://${opts.host ?? '127.0.0.1'}:${opts.port}/mcp`);
      resolve(server);
    });
  });
}
