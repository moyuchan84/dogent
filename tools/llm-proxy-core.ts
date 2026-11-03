// LLM 프록시의 핵심: 개인 토큰 확인, 헤더 틀 채우기, 사용자별 속도 제한, 그대로 전달, 내용 없는 감사 기록.
// 서버를 띄우는 부분은 tools/llm-proxy.ts. Node 내장 모듈만 쓴다 (docs/20 5-4 C안).
//
// 지키는 것: 프롬프트와 응답 내용은 어디에도 남기지 않는다 (감사 기록에는 사용자·시각·모델·상태·지연·토큰 수만).
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, readFileSync, statSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { buildHeaders } from '../src/core/llm';

export interface TokenEntry {
  userId: string;
  userType?: string;
}

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

/**
 * 토큰 표(JSON 파일). 토큰 → 사용자. 값은 문자열(userId)이거나 { userId, userType }.
 * 키는 토큰 원문이거나 토큰의 sha256 16진수(64자)다 (파일에 원문을 두지 않으려면 해시로 적는다).
 * 파일이 바뀌면 다음 요청에서 다시 읽는다 (사용자를 더하거나 빼도 재시작이 필요 없다).
 */
export class TokenTable {
  private map = new Map<string, TokenEntry>();
  private mtime = -1;
  constructor(private file: string) {
    this.reload(true);
  }

  private reload(force = false): void {
    if (!existsSync(this.file)) {
      if (force) throw new Error(`토큰 표를 찾지 못했습니다: ${this.file}`);
      return;
    }
    const m = statSync(this.file).mtimeMs;
    if (!force && m === this.mtime) return;
    let raw: Record<string, unknown>;
    try {
      const parsed = JSON.parse(readFileSync(this.file, 'utf8')) as { tokens?: Record<string, unknown> } & Record<string, unknown>;
      raw = (parsed.tokens ?? parsed) as Record<string, unknown>;
    } catch (e) {
      if (force) throw new Error(`토큰 표를 읽지 못했습니다: ${(e as Error).message}`);
      return; // 고치다 만 파일이면 전에 읽은 표를 계속 쓴다
    }
    const next = new Map<string, TokenEntry>();
    for (const [token, v] of Object.entries(raw)) {
      const entry = typeof v === 'string' ? { userId: v } : v && typeof v === 'object' ? (v as TokenEntry) : null;
      if (!entry || typeof entry.userId !== 'string' || !entry.userId.trim()) continue;
      const key = /^[0-9a-f]{64}$/i.test(token) ? token.toLowerCase() : sha256(token);
      next.set(key, { userId: entry.userId.trim(), ...(entry.userType ? { userType: String(entry.userType) } : {}) });
    }
    this.map = next;
    this.mtime = m;
  }

  /** 개인 토큰으로 사용자를 찾는다. 해시로 찾으므로 비교 시간이 토큰 내용에 따라 달라지지 않는다 */
  lookup(token: string | undefined): TokenEntry | null {
    if (!token) return null;
    this.reload();
    return this.map.get(sha256(token)) ?? null;
  }

  get size(): number {
    return this.map.size;
  }
}

/** 사용자별 토큰 버킷. 분당 perMinute회까지 (0이면 제한 없음) */
export class RateLimiter {
  private buckets = new Map<string, { tokens: number; at: number }>();
  constructor(
    private perMinute: number,
    private now: () => number = Date.now,
  ) {}

  /** 쓸 수 있으면 null, 모자라면 몇 초 뒤에 다시 시도하라는 값 */
  take(userId: string): number | null {
    if (!(this.perMinute > 0)) return null;
    const t = this.now();
    const b = this.buckets.get(userId) ?? { tokens: this.perMinute, at: t };
    b.tokens = Math.min(this.perMinute, b.tokens + ((t - b.at) / 60_000) * this.perMinute);
    b.at = t;
    if (b.tokens >= 1) {
      b.tokens -= 1;
      this.buckets.set(userId, b);
      return null;
    }
    this.buckets.set(userId, b);
    return Math.max(1, Math.ceil(((1 - b.tokens) / this.perMinute) * 60));
  }
}

export interface ProxyOptions {
  /** 업스트림 기본 주소 (예: https://gateway.corp/v1). 요청 경로의 chat/completions 를 뒤에 붙인다 */
  upstream: string;
  /** 업스트림 키 (헤더 틀의 {key}) */
  upstreamKey?: string;
  /** 헤더 틀. 없으면 Authorization: Bearer <키> */
  headers?: Record<string, string>;
  systemName?: string;
  defaultUserType?: string;
  tokens: TokenTable;
  perMinute?: number;
  /** 감사 기록(JSONL) 파일. 없으면 기록하지 않는다 */
  auditFile?: string;
  /** 업스트림 응답 헤더를 기다리는 시간 (ms) */
  timeoutMs?: number;
  maxBody?: number;
  log?: (line: string) => void;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

/** 감사 기록 한 줄. 내용(프롬프트·응답)은 담지 않는다 */
export interface AuditLine {
  at: string;
  userId: string;
  model: string;
  stream: boolean;
  status: number;
  ms: number;
  outcome: 'ok' | 'upstream_error' | 'rate_limited' | 'unauthorized' | 'unreachable' | 'bad_request';
  tokens?: { prompt?: number; completion?: number; total?: number };
}

const DEFAULT_MAX_BODY = 8_000_000;

/** 응답 끝부분에서 토큰 수만 뽑는다 (내용은 보지 않고 숫자 필드만 찾는다) */
export function usageFromTail(tail: string): AuditLine['tokens'] | undefined {
  const pick = (name: string) => {
    const all = [...tail.matchAll(new RegExp(`"${name}"\\s*:\\s*(\\d+)`, 'g'))];
    return all.length ? Number(all[all.length - 1][1]) : undefined;
  };
  const prompt = pick('prompt_tokens');
  const completion = pick('completion_tokens');
  const total = pick('total_tokens');
  if (prompt === undefined && completion === undefined && total === undefined) return undefined;
  return { ...(prompt !== undefined ? { prompt } : {}), ...(completion !== undefined ? { completion } : {}), ...(total !== undefined ? { total } : {}) };
}

export function createProxyHandler(opts: ProxyOptions) {
  const log = opts.log ?? (() => {});
  const fetchImpl = opts.fetchImpl ?? fetch;
  const now = opts.now ?? Date.now;
  const limiter = new RateLimiter(opts.perMinute ?? 0, now);
  const maxBody = opts.maxBody ?? DEFAULT_MAX_BODY;
  const base = opts.upstream.replace(/\/+$/, '');

  const audit = (line: AuditLine) => {
    if (!opts.auditFile) return;
    try {
      appendFileSync(opts.auditFile, `${JSON.stringify(line)}\n`);
    } catch (e) {
      log(`감사 기록을 쓰지 못했습니다: ${(e as Error).message}`);
    }
  };

  async function readBody(req: IncomingMessage): Promise<Buffer | null> {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const c of req) {
      size += (c as Buffer).length;
      if (size > maxBody) return null;
      chunks.push(c as Buffer);
    }
    return Buffer.concat(chunks);
  }

  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const started = now();
    const path = (req.url ?? '/').split('?')[0].replace(/\/+$/, '');
    const json = (status: number, body: unknown, headers: Record<string, string> = {}) => {
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', ...headers });
      res.end(JSON.stringify(body));
    };
    const fail = (status: number, message: string, headers: Record<string, string> = {}) => json(status, { error: { message, type: 'proxy_error' } }, headers);

    if (req.method === 'GET' && path === '/health') return json(200, { ok: true, users: opts.tokens.size });
    if (!path.endsWith('/chat/completions')) return fail(404, '주소는 …/chat/completions 입니다');
    if (req.method !== 'POST') return fail(405, 'POST만 받습니다', { allow: 'POST' });

    const auth = /^Bearer\s+(.+)$/i.exec(req.headers.authorization ?? '')?.[1].trim();
    const who = opts.tokens.lookup(auth);
    if (!who) {
      audit({ at: new Date(started).toISOString(), userId: '-', model: '-', stream: false, status: 401, ms: now() - started, outcome: 'unauthorized' });
      return fail(401, '개인 토큰이 없거나 등록되지 않았습니다 (Authorization: Bearer <개인 토큰>)', { 'www-authenticate': 'Bearer' });
    }
    const line = (x: Partial<AuditLine> & Pick<AuditLine, 'status' | 'outcome'>): AuditLine => ({
      at: new Date(started).toISOString(),
      userId: who.userId,
      model: '-',
      stream: false,
      ms: now() - started,
      ...x,
    });

    const wait = limiter.take(who.userId);
    if (wait !== null) {
      audit(line({ status: 429, outcome: 'rate_limited' }));
      return fail(429, `요청이 너무 잦습니다. ${wait}초 뒤에 다시 보내세요`, { 'retry-after': String(wait) });
    }

    const body = await readBody(req);
    if (!body) {
      audit(line({ status: 413, outcome: 'bad_request' }));
      req.resume();
      return fail(413, `본문이 너무 큽니다 (최대 ${maxBody}바이트)`);
    }
    // 모델 이름과 스트리밍 여부만 읽는다 (내용은 보지 않는다)
    let model = '-';
    let stream = false;
    try {
      const parsed = JSON.parse(body.toString('utf8')) as { model?: unknown; stream?: unknown };
      if (typeof parsed.model === 'string') model = parsed.model.slice(0, 80);
      stream = parsed.stream === true;
    } catch {
      audit(line({ status: 400, outcome: 'bad_request' }));
      return fail(400, 'JSON이 아닙니다');
    }

    let headers: Record<string, string>;
    try {
      headers = buildHeaders({
        baseUrl: base,
        apiKey: opts.upstreamKey ?? '',
        model,
        jsonMode: false,
        timeoutScale: 1,
        skillDirect: false,
        pathCache: false,
        headers: opts.headers,
        userId: who.userId,
        userType: who.userType ?? opts.defaultUserType,
        systemName: opts.systemName,
      } as Parameters<typeof buildHeaders>[0]);
    } catch (e) {
      log(`업스트림 헤더를 만들지 못했습니다: ${(e as Error).message}`);
      audit(line({ model, stream, status: 500, outcome: 'bad_request' }));
      return fail(500, `프록시 설정 오류: ${(e as Error).message}`);
    }
    if (req.headers.accept) headers['accept'] ??= String(req.headers.accept);

    const ctrl = new AbortController();
    res.on('close', () => !res.writableEnded && ctrl.abort());
    let upstream: Response;
    const timer = setTimeout(() => ctrl.abort(new Error('timeout')), opts.timeoutMs ?? 120_000);
    try {
      upstream = await fetchImpl(`${base}/chat/completions`, { method: 'POST', headers, body: new Uint8Array(body), signal: ctrl.signal });
    } catch (e) {
      clearTimeout(timer);
      const reason = ctrl.signal.aborted && (ctrl.signal.reason as Error)?.message === 'timeout' ? '업스트림 응답 시간이 초과됐습니다' : `업스트림에 닿지 못했습니다 (${(e as Error).message})`;
      log(reason);
      audit(line({ model, stream, status: 502, outcome: 'unreachable' }));
      if (!res.headersSent && !res.destroyed) fail(502, `LLM 게이트웨이에 닿지 못했습니다. ${reason}`);
      return;
    }
    clearTimeout(timer);

    const out: Record<string, string> = {};
    for (const name of ['content-type', 'retry-after', 'cache-control']) {
      const v = upstream.headers.get(name);
      if (v) out[name] = v;
    }
    res.writeHead(upstream.status, out);
    // 그대로 흘려 보내면서 끝부분만 모아 토큰 수를 센다 (내용은 저장하지 않는다)
    let tail = '';
    let broken = false;
    try {
      if (upstream.body) {
        const reader = upstream.body.getReader();
        const decoder = new TextDecoder();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          res.write(value);
          tail = (tail + decoder.decode(value, { stream: true })).slice(-4096);
        }
      }
    } catch {
      broken = true;
    }
    // 응답을 끝내기 전에 기록한다 (끝낸 직후 기록을 읽는 쪽이 빠져 보이지 않게)
    audit(line({ model, stream, status: upstream.status, outcome: upstream.ok ? 'ok' : 'upstream_error', tokens: usageFromTail(tail) }));
    if (broken) res.destroy();
    else res.end();
  };
}
