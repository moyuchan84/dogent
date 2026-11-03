import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { hostAllowed, type RunEvent, type RunResult } from '../../src/core';

/**
 * Hub(정책·중지 스위치·실행 요약, templates/dogent-hub) 연결. 설정(hubUrl)이 없으면 아무 일도 하지 않는다.
 * Hub는 선택 사항이라 서버가 없거나 닿지 않아도 Dogent는 지금과 똑같이 돈다.
 *
 *   ~/.dogent/hub-policy.json   마지막으로 받은 정책 (fetchedAt과 함께). 닿지 못하면 이것을 쓴다
 *   ~/.dogent/hub-outbox.jsonl  아직 보내지 못한 실행 요약 (runId로 멱등이라 다시 보내도 중복되지 않는다)
 *
 * 실행 요약에는 화이트리스트 필드만 담는다. 표의 값, 화면 글자, 입력값, 요청 문장은 절대 넣지 않는다.
 */
export type HubRisk = 'R1' | 'R2' | 'R3';

export interface HubKillSwitch {
  id?: string;
  scope: 'skill' | 'system' | 'all';
  target: string;
  reason: string;
  since: string;
}

export interface HubPolicy {
  version: number;
  issuedAt: string;
  ttlSec: number;
  killSwitches: HubKillSwitch[];
  notice?: string;
}

export interface HubCache {
  url: string;
  /** 서버에 마지막으로 확인한 때 (304여도 갱신) */
  fetchedAt: string;
  etag?: string;
  policy: HubPolicy;
}

/** 서버로 보내는 실행 요약 (서버의 화이트리스트와 같은 필드) */
export interface HubRunSummary {
  runId: string;
  userId: string;
  skillId: string;
  skillVersion?: string;
  risk: HubRisk;
  result: 'ok' | 'fail' | 'aborted' | 'blocked';
  startedAt: string;
  durationMs?: number;
  modelCalls?: number;
  errorClass?: string;
  approved?: boolean;
  clientVersion?: string;
}

/** 스킬의 위험도(R0~R3)를 Hub의 R1~R3로 맞춘다 (R0은 읽기만 하는 R1로 센다) */
export const hubRisk = (risk: string): HubRisk => (risk === 'R3' ? 'R3' : risk === 'R2' ? 'R2' : 'R1');

const policyFile =(home: string) => join(home, 'hub-policy.json');
const outboxFile = (home: string) => join(home, 'hub-outbox.jsonl');
const MAX_OUTBOX = 1000;

/** 설정한 주소에서 쓸 서버 기준 주소를 만든다 (끝의 / 제거) */
export function hubBase(url: string): string {
  return url.trim().replace(/\/+$/, '');
}

function authHeader(token?: string): Record<string, string> {
  return token ? { authorization: /\s/.test(token) ? token : `Bearer ${token}` } : {};
}

// ---------- 정책 받기 ----------

export function loadHubCache(home: string): HubCache | null {
  try {
    const c = JSON.parse(readFileSync(policyFile(home), 'utf8')) as HubCache;
    return c?.policy && typeof c.policy.ttlSec === 'number' && Array.isArray(c.policy.killSwitches) && Number.isFinite(Date.parse(c.fetchedAt)) ? c : null;
  } catch {
    return null;
  }
}

function saveHubCache(home: string, cache: HubCache): void {
  mkdirSync(home, { recursive: true });
  const file = policyFile(home);
  writeFileSync(`${file}.tmp`, JSON.stringify(cache, null, 2));
  renameSync(`${file}.tmp`, file);
}

/** 정책이 다시 받을 때가 됐는지: 받은 적이 없거나 주소가 바뀌었거나 ttlSec의 절반이 지났다 (그래야 만료 전에 늘 새로 확인한다) */
export function hubStale(cache: HubCache | null, url: string, now = Date.now()): boolean {
  if (!cache || cache.url !== hubBase(url)) return true;
  const age = now - Date.parse(cache.fetchedAt);
  return age > Math.max(10, cache.policy.ttlSec / 2) * 1000;
}

/** GET /v1/policy (ETag). 닿지 못하거나 응답이 이상하면 던지고, 받아 둔 것은 건드리지 않는다. */
export async function fetchPolicy(home: string, url: string, opts: { token?: string; timeoutMs?: number; now?: number } = {}): Promise<{ cache: HubCache; changed: boolean }> {
  const base = hubBase(url);
  const last = loadHubCache(home);
  const headers: Record<string, string> = { ...authHeader(opts.token) };
  if (last && last.url === base && last.etag) headers['if-none-match'] = last.etag;
  const res = await fetch(`${base}/v1/policy`, { headers, signal: AbortSignal.timeout(opts.timeoutMs ?? 5_000) });
  const at = new Date(opts.now ?? Date.now()).toISOString();
  if (res.status === 304 && last) {
    const cache = { ...last, url: base, fetchedAt: at };
    saveHubCache(home, cache);
    return { cache, changed: false };
  }
  if (!res.ok) throw new Error(res.status === 401 || res.status === 403 ? `HTTP ${res.status} (토큰이 필요하거나 틀렸습니다: dogent config hubToken <토큰>)` : `HTTP ${res.status}`);
  const text = await res.text();
  if (text.length > 1_000_000) throw new Error('응답이 너무 큽니다');
  let body: Partial<HubPolicy>;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error('JSON이 아닙니다 (주소가 Hub인지 확인하세요)');
  }
  if (typeof body.version !== 'number' || typeof body.ttlSec !== 'number' || !Array.isArray(body.killSwitches)) throw new Error('Hub의 정책 응답 형식이 아닙니다 (주소가 Hub인지 확인하세요)');
  const policy: HubPolicy = {
    version: body.version,
    issuedAt: String(body.issuedAt ?? at),
    ttlSec: body.ttlSec,
    killSwitches: body.killSwitches
      .filter((k) => k && ['skill', 'system', 'all'].includes(k.scope) && typeof k.target === 'string')
      .map((k) => ({ ...(k.id ? { id: String(k.id) } : {}), scope: k.scope, target: k.target, reason: String(k.reason ?? ''), since: String(k.since ?? '') })),
    ...(typeof body.notice === 'string' && body.notice ? { notice: body.notice } : {}),
  };
  const cache: HubCache = { url: base, fetchedAt: at, etag: res.headers.get('etag') ?? undefined, policy };
  saveHubCache(home, cache);
  return { cache, changed: true };
}

// ---------- 정책 적용 (순수 함수) ----------

export interface RunTarget {
  skillId: string;
  risk: HubRisk;
  /** 이 실행이 다루는 시스템 사전 id들 */
  systemIds: string[];
}

export type HubVerdict = { allow: true; warn?: string } | { allow: false; reason: string; errorClass: 'killswitch' | 'expired' };

/** 정책이 만료됐는지 (fetchedAt + ttlSec 이후) */
export function policyExpired(cache: HubCache, now = Date.now()): boolean {
  return now > Date.parse(cache.fetchedAt) + cache.policy.ttlSec * 1000;
}

/**
 * 실행해도 되는지 가린다.
 *  (a) 중지 스위치가 이 스킬 / 이 스킬이 다루는 시스템 / all 에 걸리면 막는다. 만료돼도 마지막으로 받은 스위치는 계속 지킨다.
 *  (b) 정책이 만료됐는데(받은 뒤 ttlSec이 지남. 호출하는 쪽이 먼저 다시 받아 봤는데도) 갱신하지 못했으면 저장·상신(R3)만 막고 R1·R2는 허용한다.
 *  (c) 정책을 한 번도 받은 적이 없으면(cache가 없음) 막지 않고 경고만 한다.
 */
export function evaluatePolicy(cache: HubCache | null, target: RunTarget, now = Date.now()): HubVerdict {
  if (!cache) return { allow: true, warn: 'Hub 정책을 아직 한 번도 받지 못했습니다. 중지 스위치를 확인하지 못한 채 진행합니다' };
  for (const k of cache.policy.killSwitches) {
    const hit = k.scope === 'all' || (k.scope === 'skill' && k.target === target.skillId) || (k.scope === 'system' && target.systemIds.includes(k.target));
    if (hit) {
      const what = k.scope === 'all' ? '모든 실행' : k.scope === 'skill' ? `스킬 ${k.target}` : `시스템 ${k.target}`;
      return { allow: false, errorClass: 'killswitch', reason: `관리자가 ${what}을(를) 중지했습니다${k.reason ? `: ${k.reason}` : ''}` };
    }
  }
  if (policyExpired(cache, now)) {
    if (target.risk === 'R3') {
      return { allow: false, errorClass: 'expired', reason: `Hub 정책을 받은 지 오래되어(${cache.fetchedAt.slice(0, 16).replace('T', ' ')}) 저장·상신(R3)은 막습니다. Hub에 다시 닿으면 풀립니다. 조회(R1·R2)는 계속 쓸 수 있습니다` };
    }
    return { allow: true, warn: 'Hub 정책이 만료됐지만 Hub에 닿지 못했습니다. 조회·입력(R1·R2)은 계속 허용합니다' };
  }
  return { allow: true };
}

/** 스킬이 다루는 사이트(허용 도메인 패턴)에 걸리는 시스템 사전 id들 */
export function systemsCoveredBy(patterns: string[], systems: { id: string; domains: string[] }[]): string[] {
  if (!patterns.length) return [];
  return systems.filter((s) => s.domains.some((d) => hostAllowed(`https://${d.replace(/^\*\./, 'x.')}/`, patterns))).map((s) => s.id);
}

// ---------- 실행 요약 ----------

/** 오류 글에서 짧은 분류어만 뽑는다 (글 자체는 보내지 않는다) */
export function classifyError(message: string): string {
  if (/로그인|login/i.test(message)) return 'login';
  if (/시간|timeout|timed out/i.test(message)) return 'timeout';
  if (/모델|LLM|API|HTTP \d{3}|헤더/i.test(message)) return 'llm';
  if (/브라우저|탭|확장|bridge|연결/i.test(message)) return 'browser';
  if (/엑셀|오피스|office/i.test(message)) return 'office';
  return 'other';
}

/**
 * 실행 결과에서 화이트리스트 필드만 뽑는다. 입력값(inputs), 화면 글자(events), 결과 글(message), outputs, 파일 이름은 쓰지 않는다.
 */
export function buildRunSummary(args: {
  runId: string;
  userId: string;
  skill: { id: string; version: string; risk: HubRisk };
  result: Pick<RunResult, 'status' | 'message' | 'cause' | 'elapsedMs'>;
  events: RunEvent[];
  startedAt: string;
  clientVersion?: string;
  /** 정책에 걸려 시작하지 않았다면 그 분류 */
  blocked?: 'killswitch' | 'expired';
}): HubRunSummary {
  const { result } = args;
  const out: HubRunSummary = {
    runId: args.runId,
    userId: args.userId,
    skillId: args.skill.id,
    skillVersion: args.skill.version,
    risk: args.skill.risk,
    result: args.blocked ? 'blocked' : result.status === 'done' || result.status === 'dryrun' ? 'ok' : result.status === 'error' ? 'fail' : result.status === 'aborted' && result.cause === 'policy' ? 'blocked' : 'aborted',
    startedAt: args.startedAt,
    durationMs: Math.max(0, Math.round(result.elapsedMs)),
    modelCalls: args.events.filter((e) => e.type === 'llm_usage').length,
  };
  const errorClass = args.blocked ?? (result.status === 'error' ? classifyError(result.message) : result.cause);
  if (errorClass) out.errorClass = errorClass;
  const approvals = args.events.filter((e): e is Extract<RunEvent, { type: 'approval' }> => e.type === 'approval');
  if (approvals.length) out.approved = approvals.every((a) => a.approved && !a.dryRun);
  if (args.clientVersion) out.clientVersion = args.clientVersion;
  return out;
}

// ---------- 아웃박스 (보내지 못한 요약) ----------

export function readOutbox(home: string): HubRunSummary[] {
  const file = outboxFile(home);
  if (!existsSync(file)) return [];
  const out: HubRunSummary[] = [];
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as HubRunSummary);
    } catch {
      /* 깨진 줄 */
    }
  }
  return out;
}

function writeOutbox(home: string, runs: HubRunSummary[]): void {
  mkdirSync(home, { recursive: true });
  const file = outboxFile(home);
  const text = runs.slice(-MAX_OUTBOX).map((r) => JSON.stringify(r)).join('\n');
  writeFileSync(`${file}.tmp`, text ? `${text}\n` : '');
  renameSync(`${file}.tmp`, file);
}

/** 같은 폴더의 보내기는 한 번에 하나만 (프로세스 안에서) */
const flushing = new Map<string, Promise<{ sent: number; left: number }>>();

/** 아웃박스를 서버로 보낸다. 닿지 못하면 그대로 남겨 둔다. 서버가 받아들였거나 형식이 틀려 거절한 것(200)은 지운다. */
export function flushOutbox(home: string, url: string, opts: { token?: string; timeoutMs?: number } = {}): Promise<{ sent: number; left: number }> {
  const running = flushing.get(home);
  if (running) return running;
  const job = (async () => {
    try {
      let sent = 0;
      for (;;) {
        const batch = readOutbox(home).slice(0, 50);
        if (!batch.length) return { sent, left: 0 };
        const res = await fetch(`${hubBase(url)}/v1/runs`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...authHeader(opts.token) },
          body: JSON.stringify(batch),
          signal: AbortSignal.timeout(opts.timeoutMs ?? 4_000),
        });
        if (!res.ok) return { sent, left: readOutbox(home).length };
        const ids = new Set(batch.map((r) => r.runId));
        writeOutbox(home, readOutbox(home).filter((r) => !ids.has(r.runId)));
        sent += batch.length;
      }
    } catch {
      return { sent: 0, left: readOutbox(home).length };
    }
  })();
  flushing.set(home, job);
  void job.finally(() => flushing.delete(home));
  return job;
}

/**
 * 실행 요약을 아웃박스에 먼저 적고(프로세스가 끝나도 남도록) 보내 본다. 사용자의 흐름을 막지 않고 오류는 던지지 않는다.
 * 반환된 약속을 기다릴 필요는 없다.
 */
export async function reportRun(home: string, url: string, token: string | undefined, summary: HubRunSummary, opts: { timeoutMs?: number } = {}): Promise<void> {
  try {
    mkdirSync(home, { recursive: true });
    appendFileSync(outboxFile(home), `${JSON.stringify(summary)}\n`);
    await flushOutbox(home, url, { token, timeoutMs: opts.timeoutMs });
  } catch {
    /* 조용히: 아웃박스에 남아 다음에 다시 보낸다 */
  }
}
