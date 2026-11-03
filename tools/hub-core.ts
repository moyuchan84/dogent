// Dogent Hub 최소안의 핵심: 저장소 인터페이스, 파일 저장소, 실행 요약 걸러내기, 요청 처리.
// 서버를 띄우는 부분은 tools/hub.ts. 여기는 Node 내장 모듈만 쓴다 (docs/20 5-3, 7-1).
//
// 원칙: 개인정보·업무 데이터를 받지 않는다. 실행 요약은 아래 화이트리스트 필드만 저장하고 나머지는 버린다.
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { join } from 'node:path';

// ---------- 자료 모양 ----------

export type Risk = 'R1' | 'R2' | 'R3';
export type RunOutcome = 'ok' | 'fail' | 'aborted' | 'blocked';

/** 실행 요약. 이 밖의 필드는 저장하지 않는다 (표 값, 화면 글자, 입력값, 요청 문장 등). */
export interface RunSummary {
  runId: string;
  userId: string;
  skillId: string;
  skillVersion?: string;
  risk: Risk;
  result: RunOutcome;
  startedAt: string;
  durationMs?: number;
  modelCalls?: number;
  errorClass?: string;
  approved?: boolean;
  clientVersion?: string;
}

export interface KillSwitch {
  id: string;
  scope: 'skill' | 'system' | 'all';
  /** scope가 all이면 '*' */
  target: string;
  reason: string;
  since: string;
}

export interface PolicyState {
  /** 정책이나 중지 스위치가 바뀔 때마다 1씩 올라간다 (ETag) */
  version: number;
  ttlSec: number;
  notice?: string;
}

export interface AuditEntry {
  at: string;
  actor: string;
  action: string;
  detail: Record<string, unknown>;
}

export interface SkillStat {
  skillId: string;
  runs: number;
  ok: number;
  successRate: number;
  avgDurationMs: number;
  consecutiveFailures: number;
  lastRunAt: string;
}

export interface Stats {
  days: number;
  since: string;
  users: number;
  runs: number;
  skills: SkillStat[];
}

/**
 * 저장소 인터페이스. 기본 구현은 파일(FileStore). PostgreSQL로 바꿀 때는 이 인터페이스를 구현하고
 * 테이블은 templates/dogent-hub/schema.sql 을 쓴다 (구현은 아직 없다).
 */
export interface Store {
  getPolicy(): Promise<PolicyState>;
  setPolicy(patch: { ttlSec?: number; notice?: string | null }): Promise<PolicyState>;
  listKillSwitches(): Promise<KillSwitch[]>;
  addKillSwitch(k: Omit<KillSwitch, 'id' | 'since'>): Promise<KillSwitch>;
  removeKillSwitch(id: string): Promise<KillSwitch | null>;
  /** runId로 멱등하게 저장한다. 이미 있는 runId는 duplicates로 센다 */
  addRuns(runs: RunSummary[]): Promise<{ accepted: number; duplicates: number }>;
  stats(days: number, now?: number): Promise<Stats>;
  addAudit(entry: Omit<AuditEntry, 'at'>): Promise<void>;
  listAudit(limit: number): Promise<AuditEntry[]>;
}

// ---------- 파일 저장소 ----------

interface StateFile {
  policy: PolicyState;
  killSwitches: KillSwitch[];
}

/** 파일을 임시 이름으로 쓴 뒤 바꿔치기해 중간에 끊겨도 깨지지 않게 한다 */
export function writeAtomic(file: string, text: string): void {
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, text);
  renameSync(tmp, file);
}

function readJsonl<T>(file: string): T[] {
  if (!existsSync(file)) return [];
  const out: T[] = [];
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as T);
    } catch {
      /* 끊긴 줄 */
    }
  }
  return out;
}

/**
 * 파일 기반 저장소: state.json(정책·중지 스위치, 원자적 쓰기), runs.jsonl·audit.jsonl(추가만).
 * 한 프로세스만 쓴다 (복제 1). 여러 대로 늘리려면 PostgreSQL 구현으로 바꾼다.
 */
export class FileStore implements Store {
  private state: StateFile;
  private runs: RunSummary[];
  private ids: Set<string>;
  private audit: AuditEntry[];
  private files: { state: string; runs: string; audit: string };

  constructor(dir: string) {
    mkdirSync(dir, { recursive: true });
    this.files = { state: join(dir, 'state.json'), runs: join(dir, 'runs.jsonl'), audit: join(dir, 'audit.jsonl') };
    this.state = { policy: { version: 1, ttlSec: 600 }, killSwitches: [] };
    if (existsSync(this.files.state)) {
      try {
        const s = JSON.parse(readFileSync(this.files.state, 'utf8')) as Partial<StateFile>;
        this.state = { policy: { ...this.state.policy, ...s.policy }, killSwitches: s.killSwitches ?? [] };
      } catch (e) {
        throw new Error(`${this.files.state}을(를) 읽지 못했습니다: ${(e as Error).message}`);
      }
    }
    this.runs = readJsonl<RunSummary>(this.files.runs);
    this.ids = new Set(this.runs.map((r) => r.runId));
    this.audit = readJsonl<AuditEntry>(this.files.audit);
  }

  private save(): void {
    writeAtomic(this.files.state, JSON.stringify(this.state, null, 2));
  }

  async getPolicy() {
    return { ...this.state.policy };
  }

  async setPolicy(patch: { ttlSec?: number; notice?: string | null }) {
    const p = this.state.policy;
    if (patch.ttlSec !== undefined) p.ttlSec = patch.ttlSec;
    if (patch.notice !== undefined) {
      if (patch.notice) p.notice = patch.notice;
      else delete p.notice;
    }
    p.version++;
    this.save();
    return { ...p };
  }

  async listKillSwitches() {
    return this.state.killSwitches.map((k) => ({ ...k }));
  }

  async addKillSwitch(k: Omit<KillSwitch, 'id' | 'since'>) {
    const item: KillSwitch = { id: randomUUID().slice(0, 8), ...k, since: new Date().toISOString() };
    this.state.killSwitches.push(item);
    this.state.policy.version++;
    this.save();
    return item;
  }

  async removeKillSwitch(id: string) {
    const i = this.state.killSwitches.findIndex((k) => k.id === id);
    if (i < 0) return null;
    const [gone] = this.state.killSwitches.splice(i, 1);
    this.state.policy.version++;
    this.save();
    return gone;
  }

  async addRuns(runs: RunSummary[]) {
    let accepted = 0;
    let duplicates = 0;
    const lines: string[] = [];
    for (const r of runs) {
      if (this.ids.has(r.runId)) {
        duplicates++;
        continue;
      }
      this.ids.add(r.runId);
      this.runs.push(r);
      lines.push(JSON.stringify(r));
      accepted++;
    }
    if (lines.length) appendFileSync(this.files.runs, `${lines.join('\n')}\n`);
    return { accepted, duplicates };
  }

  async stats(days: number, now = Date.now()) {
    return computeStats(this.runs, days, now);
  }

  async addAudit(entry: Omit<AuditEntry, 'at'>) {
    const e: AuditEntry = { at: new Date().toISOString(), ...entry };
    this.audit.push(e);
    appendFileSync(this.files.audit, `${JSON.stringify(e)}\n`);
  }

  async listAudit(limit: number) {
    return this.audit.slice(-limit).reverse();
  }
}

/** 최근 days일 실행으로 스킬별 통계를 낸다. 성공률의 분모는 취소·차단을 뺀 실행이다 */
export function computeStats(all: RunSummary[], days: number, now = Date.now()): Stats {
  const since = now - days * 86_400_000;
  const runs = all.filter((r) => Date.parse(r.startedAt) >= since).sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt));
  const bySkill = new Map<string, RunSummary[]>();
  for (const r of runs) bySkill.set(r.skillId, [...(bySkill.get(r.skillId) ?? []), r]);
  const skills: SkillStat[] = [...bySkill].map(([skillId, list]) => {
    const ok = list.filter((r) => r.result === 'ok').length;
    const fail = list.filter((r) => r.result === 'fail').length;
    const timed = list.filter((r) => r.durationMs !== undefined);
    let consecutive = 0;
    for (const r of [...list].reverse()) {
      if (r.result === 'fail') consecutive++;
      else if (r.result === 'ok') break;
    }
    return {
      skillId,
      runs: list.length,
      ok,
      successRate: ok + fail ? Math.round((ok / (ok + fail)) * 1000) / 1000 : 0,
      avgDurationMs: timed.length ? Math.round(timed.reduce((s, r) => s + (r.durationMs ?? 0), 0) / timed.length) : 0,
      consecutiveFailures: consecutive,
      lastRunAt: list[list.length - 1].startedAt,
    };
  });
  skills.sort((a, b) => b.runs - a.runs || a.skillId.localeCompare(b.skillId));
  return { days, since: new Date(since).toISOString(), users: new Set(runs.map((r) => r.userId)).size, runs: runs.length, skills };
}

// ---------- 실행 요약 걸러내기 ----------

const RISKS = new Set(['R1', 'R2', 'R3']);
const RESULTS = new Set(['ok', 'fail', 'aborted', 'blocked']);
const ID = /^[\w.@:\-가-힣]{1,64}$/u;
const WORD = /^[\w.:\-가-힣]{1,40}$/u;

/**
 * 실행 요약 하나를 화이트리스트로 걸러낸다. 틀렸으면 null.
 * 허용 필드가 아닌 것은 그대로 버리고, 허용 필드도 모양이 맞지 않으면 (필수가 아닌 것은) 버린다.
 */
export function sanitizeRun(raw: unknown): RunSummary | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  const str = (v: unknown, re: RegExp) => (typeof v === 'string' && re.test(v) ? v : undefined);
  const int = (v: unknown, max: number) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= max ? Math.round(v) : undefined);
  const runId = str(o.runId, ID);
  const userId = str(o.userId, ID);
  const skillId = str(o.skillId, ID);
  const risk = typeof o.risk === 'string' && RISKS.has(o.risk) ? (o.risk as Risk) : undefined;
  const result = typeof o.result === 'string' && RESULTS.has(o.result) ? (o.result as RunOutcome) : undefined;
  const t = typeof o.startedAt === 'string' ? Date.parse(o.startedAt) : NaN;
  if (!runId || !userId || !skillId || !risk || !result || !Number.isFinite(t)) return null;
  const out: RunSummary = { runId, userId, skillId, risk, result, startedAt: new Date(t).toISOString() };
  const skillVersion = str(o.skillVersion, /^[\w.+\-]{1,32}$/);
  const durationMs = int(o.durationMs, 7 * 86_400_000);
  const modelCalls = int(o.modelCalls, 100_000);
  const errorClass = str(o.errorClass, WORD);
  const clientVersion = str(o.clientVersion, /^[\w.+\-]{1,32}$/);
  if (skillVersion) out.skillVersion = skillVersion;
  if (durationMs !== undefined) out.durationMs = durationMs;
  if (modelCalls !== undefined) out.modelCalls = modelCalls;
  if (errorClass) out.errorClass = errorClass;
  if (typeof o.approved === 'boolean') out.approved = o.approved;
  if (clientVersion) out.clientVersion = clientVersion;
  return out;
}

// ---------- 인증 ----------

const digest = (s: string) => createHash('sha256').update(s).digest();

/** 길이가 달라도 같은 시간이 걸리게 해시한 뒤 비교한다 */
export function tokenEquals(given: string | undefined, expected: string): boolean {
  if (!given) return false;
  return timingSafeEqual(digest(given), digest(expected));
}

function bearer(req: IncomingMessage): string | undefined {
  const h = req.headers.authorization;
  const m = h ? /^Bearer\s+(.+)$/i.exec(h) : null;
  return m?.[1].trim();
}

// ---------- 요청 처리 ----------

export interface HubOptions {
  store: Store;
  /** 클라이언트용 토큰: 정책 읽기, 실행 요약 보내기 */
  token: string;
  /** 관리용 토큰 */
  adminToken: string;
  log?: (line: string) => void;
}

export const MAX_BODY = 1_000_000;
export const MAX_RUNS_PER_POST = 200;
const MIN_TOKEN = 16;

/** 토큰이 없거나 너무 짧거나 둘이 같으면 서버를 시작하지 않는다 */
export function checkTokens(token: string | undefined, adminToken: string | undefined): string | null {
  if (!token || !adminToken) return 'HUB_TOKEN(클라이언트용)과 HUB_ADMIN_TOKEN(관리용) 환경 변수가 모두 있어야 시작합니다';
  if (token.length < MIN_TOKEN || adminToken.length < MIN_TOKEN) return `토큰은 ${MIN_TOKEN}자 이상이어야 합니다 (예: node -e "console.log(require('crypto').randomBytes(24).toString('hex'))")`;
  if (token === adminToken) return 'HUB_TOKEN과 HUB_ADMIN_TOKEN은 서로 달라야 합니다';
  return null;
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

async function readBody(req: IncomingMessage): Promise<string> {
  const declared = Number(req.headers['content-length']);
  if (declared > MAX_BODY) throw new HttpError(413, `본문이 너무 큽니다 (최대 ${MAX_BODY}바이트)`);
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > MAX_BODY) throw new HttpError(413, `본문이 너무 큽니다 (최대 ${MAX_BODY}바이트)`);
    chunks.push(c as Buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const text = await readBody(req);
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(400, 'JSON이 아닙니다');
  }
}

/** Node http 서버에 바로 꽂는 처리기를 만든다 */
export function createHubHandler(opts: HubOptions) {
  const { store } = opts;
  const log = opts.log ?? (() => {});

  async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://hub');
    const path = url.pathname.replace(/\/+$/, '') || '/';
    const method = req.method ?? 'GET';
    const send = (status: number, body?: unknown, headers: Record<string, string> = {}) => {
      res.writeHead(status, body === undefined ? headers : { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers });
      res.end(body === undefined ? undefined : JSON.stringify(body));
    };

    if (method === 'GET' && path === '/health') return send(200, { ok: true });

    const given = bearer(req);
    const isAdmin = tokenEquals(given, opts.adminToken);
    const isClient = isAdmin || tokenEquals(given, opts.token);
    const need = (admin: boolean) => {
      if (admin ? isAdmin : isClient) return;
      throw new HttpError(given ? 403 : 401, given ? '이 토큰으로는 할 수 없습니다' : '인증이 필요합니다 (Authorization: Bearer <토큰>)');
    };

    if (method === 'GET' && path === '/v1/policy') {
      need(false);
      const policy = await store.getPolicy();
      const etag = `"${policy.version}"`;
      if (req.headers['if-none-match'] === etag) return send(304, undefined, { etag });
      const killSwitches = (await store.listKillSwitches()).map((k) => ({ id: k.id, scope: k.scope, target: k.target, reason: k.reason, since: k.since }));
      return send(200, { version: policy.version, issuedAt: new Date().toISOString(), ttlSec: policy.ttlSec, killSwitches, ...(policy.notice ? { notice: policy.notice } : {}) }, { etag });
    }

    if (method === 'POST' && path === '/v1/runs') {
      need(false);
      const body = await readJson(req);
      const list = Array.isArray(body) ? body : [body];
      if (list.length > MAX_RUNS_PER_POST) throw new HttpError(413, `한 번에 ${MAX_RUNS_PER_POST}건까지 보낼 수 있습니다`);
      const good: RunSummary[] = [];
      let rejected = 0;
      for (const item of list) {
        const run = sanitizeRun(item);
        if (run) good.push(run);
        else rejected++;
      }
      const saved = await store.addRuns(good);
      return send(200, { ...saved, rejected });
    }

    if (method === 'PUT' && path === '/v1/admin/policy') {
      need(true);
      const b = (await readJson(req)) as { ttlSec?: unknown; notice?: unknown };
      if (!b || typeof b !== 'object') throw new HttpError(400, '객체가 필요합니다');
      const patch: { ttlSec?: number; notice?: string | null } = {};
      if (b.ttlSec !== undefined) {
        if (typeof b.ttlSec !== 'number' || !Number.isInteger(b.ttlSec) || b.ttlSec < 30 || b.ttlSec > 7 * 86_400) throw new HttpError(400, 'ttlSec은 30 이상 604800 이하의 정수(초)입니다');
        patch.ttlSec = b.ttlSec;
      }
      if (b.notice !== undefined) {
        if (b.notice !== null && (typeof b.notice !== 'string' || b.notice.length > 500)) throw new HttpError(400, 'notice는 500자 이하의 글이거나 null(지우기)입니다');
        patch.notice = b.notice as string | null;
      }
      const policy = await store.setPolicy(patch);
      await store.addAudit({ actor: 'admin', action: 'policy.update', detail: { ...patch, version: policy.version } });
      return send(200, policy);
    }

    if (method === 'POST' && path === '/v1/admin/killswitch') {
      need(true);
      const b = (await readJson(req)) as { scope?: unknown; target?: unknown; reason?: unknown };
      if (!b || typeof b !== 'object') throw new HttpError(400, '객체가 필요합니다');
      if (b.scope !== 'skill' && b.scope !== 'system' && b.scope !== 'all') throw new HttpError(400, 'scope는 skill, system, all 중 하나입니다');
      const target = b.scope === 'all' ? '*' : typeof b.target === 'string' && ID.test(b.target) ? b.target : '';
      if (!target) throw new HttpError(400, 'target(스킬 id 또는 시스템 id)이 필요합니다');
      if (typeof b.reason !== 'string' || !b.reason.trim() || b.reason.length > 300) throw new HttpError(400, 'reason(사유)은 1~300자입니다');
      const item = await store.addKillSwitch({ scope: b.scope, target, reason: b.reason.trim() });
      await store.addAudit({ actor: 'admin', action: 'killswitch.set', detail: { ...item } });
      return send(201, item);
    }

    const del = method === 'DELETE' ? /^\/v1\/admin\/killswitch\/([\w-]{1,40})$/.exec(path) : null;
    if (del) {
      need(true);
      const gone = await store.removeKillSwitch(del[1]);
      if (!gone) throw new HttpError(404, '그런 중지 스위치가 없습니다');
      await store.addAudit({ actor: 'admin', action: 'killswitch.clear', detail: { ...gone } });
      return send(204);
    }

    if (method === 'GET' && path === '/v1/admin/stats') {
      need(true);
      const days = Math.min(365, Math.max(1, Number(url.searchParams.get('days')) || 7));
      return send(200, await store.stats(days));
    }

    if (method === 'GET' && path === '/v1/admin/audit') {
      need(true);
      const limit = Math.min(1000, Math.max(1, Number(url.searchParams.get('limit')) || 100));
      return send(200, { entries: await store.listAudit(limit) });
    }

    throw new HttpError(404, '없는 주소입니다');
  }

  return (req: IncomingMessage, res: ServerResponse): void => {
    route(req, res).catch((e) => {
      const status = e instanceof HttpError ? e.status : 500;
      if (status === 500) log(`오류: ${(e as Error).message}`);
      if (res.headersSent) return void res.end();
      const extra = status === 401 ? { 'www-authenticate': 'Bearer' } : {};
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', ...extra });
      res.end(JSON.stringify({ error: status === 500 ? '서버 오류' : (e as Error).message }));
      if (status === 413) req.resume();
    });
  };
}
