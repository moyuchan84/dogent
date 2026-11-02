// 공용 시스템 사전 MCP 서버의 본체 (전송 방식과 무관한 부분). systems-mcp.ts가 HTTP·stdio로 띄운다.
//
// 도구
//   find_system(query, limit?)  말·키워드로 시스템 찾기 (Dogent의 요청 해석과 같은 규칙: 별칭·이름 → 글자 검색)
//   get_system(id)              시스템 하나의 전부 (주소·사이트·화면·용어·주의사항)와 모델에 보여 줄 설명
//   list_systems()              목록과 판 번호
//   report_issue(id, problem)   "주소가 틀려요" 같은 신고를 남긴다 (담당자가 저장소에서 고친다)
//
// 원본은 git 저장소의 SYSTEM.md들이다. 파일이 바뀌면 다음 요청 때 다시 읽는다 (판 번호가 바뀐다).
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { describeSystem, searchSystems, type System } from '../src/core/systems';
import { loadRegistry, registryStamp, type Registry } from './systems-registry';

export const SERVER_INFO = { name: 'dogent-systems', version: '0.1.0' };
const PROTOCOLS = ['2025-06-18', '2025-03-26', '2024-11-05'];
/** 파일이 바뀌었는지 이만큼마다 본다 */
const CHECK_MS = 3000;

type Json = Record<string, unknown>;
export interface RpcMessage {
  jsonrpc?: '2.0';
  id?: number | string | null;
  method?: string;
  params?: Json;
}

const TOOLS = [
  {
    name: 'find_system',
    title: '시스템 찾기',
    description:
      '사내 시스템을 이름·별칭·키워드로 찾는다 (예: "GSAMS", "방화벽 신청", "재공 시스템"). 요청 문장을 그대로 줘도 된다. ' +
      '맞는 순서로 id·이름·주소·검증 상태를 돌려준다. 자세한 화면과 용어는 get_system으로 본다. status가 draft면 검증 전이다.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '시스템 이름, 별칭, 또는 요청 문장' },
        limit: { type: 'number', description: '돌려줄 개수 (1~10, 기본 3)' },
      },
      required: ['query'],
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'get_system',
    title: '시스템 자세히',
    description: '시스템 하나의 주소, 사이트(domains), 로그인, 화면(메뉴 경로), 용어, 주의사항을 돌려준다. prompt는 모델에 그대로 보여 줄 설명이다.',
    inputSchema: { type: 'object', properties: { id: { type: 'string', description: 'find_system이 돌려준 id' } }, required: ['id'] },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'list_systems',
    title: '시스템 목록',
    description: '공용 시스템 사전의 전체 목록과 판 번호(version). 판 번호가 같으면 내용도 같다.',
    inputSchema: { type: 'object', properties: {} },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'report_issue',
    title: '사전 오류 신고',
    description: '사전 내용이 틀렸거나(주소가 바뀜, 화면이 없어짐) 없는 시스템을 알린다. 사전을 직접 고치지는 않고, 담당자가 확인해 저장소에서 고친다.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '시스템 id (없는 시스템이면 부르는 이름)' },
        problem: { type: 'string', description: '무엇이 틀렸는지, 맞는 값을 알면 그 값' },
        reporter: { type: 'string', description: '알린 사람 (선택)' },
      },
      required: ['id', 'problem'],
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
];

/** find_system·list_systems가 돌려주는 짧은 모양 */
const brief = (s: System) => ({ id: s.id, name: s.name, aliases: s.aliases, description: s.description, url: s.url, domains: s.domains, owner: s.owner, status: s.status, ...(s.updated ? { updated: s.updated } : {}) });

export interface SystemsMcpOptions {
  root: string;
  /** report_issue를 쌓을 파일 (JSON 줄). 없으면 신고를 받지 않는다 */
  reportsFile?: string;
  log?: (line: string) => void;
}

export class SystemsMcp {
  private reg: Registry;
  private stamp: string;
  private checkedAt = 0;

  constructor(private opts: SystemsMcpOptions) {
    this.reg = loadRegistry(opts.root);
    this.stamp = registryStamp(opts.root);
    this.logLoad();
  }

  private logLoad(): void {
    const errors = this.reg.problems.filter((p) => p.level === 'error');
    this.opts.log?.(`시스템 ${this.reg.systems.length}개를 읽었습니다 (판 ${this.reg.version})${errors.length ? ` · 오류로 뺀 파일: ${[...new Set(errors.map((e) => e.file))].join(', ')}` : ''}`);
  }

  /** 파일이 바뀌었으면 다시 읽는다 */
  registry(): Registry {
    const now = Date.now();
    if (now - this.checkedAt >= CHECK_MS) {
      this.checkedAt = now;
      const stamp = registryStamp(this.opts.root);
      if (stamp !== this.stamp) {
        this.stamp = stamp;
        this.reg = loadRegistry(this.opts.root);
        this.logLoad();
      }
    }
    return this.reg;
  }

  /**
   * 사전 전체의 원문. Dogent 클라이언트가 GET /systems.json 으로 받아 로컬 사전(systems-cache)으로 쓴다.
   * MCP 도구로는 내놓지 않는다 (모델이 부르면 토큰만 쓰므로). 오류로 뺀 시스템은 들어 있지 않다.
   */
  exportAll(): { version: string; count: number; systems: { id: string; source: string }[] } {
    const reg = this.registry();
    return { version: reg.version, count: reg.systems.length, systems: reg.systems.map((s) => ({ id: s.system.id, source: s.source })) };
  }

  /** JSON-RPC 메시지 하나를 처리한다. 알림(id 없음)이면 null */
  handle(msg: RpcMessage): Json | null {
    const reply = (body: Json) => ({ jsonrpc: '2.0', id: msg.id ?? null, ...body });
    if (msg.id === undefined || msg.id === null) return null;
    try {
      switch (msg.method) {
        case 'initialize': {
          const asked = String(msg.params?.protocolVersion ?? '');
          return reply({
            result: {
              protocolVersion: PROTOCOLS.includes(asked) ? asked : PROTOCOLS[0],
              capabilities: { tools: { listChanged: false } },
              serverInfo: SERVER_INFO,
              instructions: '사내 시스템 사전. 요청에 시스템 이름이 나오면 find_system으로 찾고, 화면·용어가 필요하면 get_system을 부른다. status가 draft인 항목은 검증 전이니 사용자에게 확인한다.',
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
          const { text, isError } = this.call(name, args);
          return reply({ result: { content: [{ type: 'text', text }], isError } });
        }
        default:
          return reply({ error: { code: -32601, message: `모르는 요청: ${msg.method}` } });
      }
    } catch (e) {
      return reply({ error: { code: -32603, message: (e as Error).message } });
    }
  }

  /** 도구 하나를 부른다 */
  call(name: string, args: Json): { text: string; isError: boolean } {
    const reg = this.registry();
    const systems = reg.systems.map((s) => s.system);
    const ok = (v: unknown) => ({ text: JSON.stringify(v, null, 1), isError: false });
    const fail = (m: string) => ({ text: m, isError: true });
    switch (name) {
      case 'find_system': {
        const query = String(args.query ?? '').trim();
        if (!query) return fail('query가 필요합니다');
        const limit = Math.min(10, Math.max(1, Number(args.limit) || 3));
        return ok({ version: reg.version, results: searchSystems(systems, query, limit).map(brief) });
      }
      case 'get_system': {
        const id = String(args.id ?? '').trim();
        const s = systems.find((x) => x.id === id);
        if (!s) {
          const near = searchSystems(systems, id, 3).map((x) => x.id);
          return fail(`"${id}" 시스템이 없습니다${near.length ? `. 비슷한 것: ${near.join(', ')}` : ''}. find_system으로 찾으세요`);
        }
        return ok({ version: reg.version, system: s, prompt: describeSystem(s) });
      }
      case 'list_systems':
        return ok({ version: reg.version, loaded_at: reg.loadedAt, count: systems.length, systems: systems.map(brief) });
      case 'report_issue': {
        if (!this.opts.reportsFile) return fail('이 서버는 신고를 받지 않습니다 (--reports 로 켭니다). 사전 저장소에 직접 알려 주세요');
        const id = String(args.id ?? '').trim();
        const problem = String(args.problem ?? '').trim();
        if (!id || !problem) return fail('id와 problem이 필요합니다');
        const known = systems.some((s) => s.id === id);
        const row = { at: new Date().toISOString(), id, known, problem: problem.slice(0, 2000), reporter: String(args.reporter ?? '').slice(0, 100) || undefined, version: reg.version };
        mkdirSync(dirname(this.opts.reportsFile), { recursive: true });
        appendFileSync(this.opts.reportsFile, `${JSON.stringify(row)}\n`);
        this.opts.log?.(`신고: ${id} — ${row.problem.slice(0, 80)}`);
        return { text: known ? `"${id}"에 대한 신고를 남겼습니다. 담당자가 확인해 사전을 고칩니다` : `사전에 없는 시스템 "${id}"으로 남겼습니다. 담당자가 확인해 새로 넣습니다`, isError: false };
      }
      default:
        return fail(`모르는 도구: ${name}`);
    }
  }
}
