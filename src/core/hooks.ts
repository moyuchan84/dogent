import { z } from 'zod';
import { extractJson } from './actions';
import type { LlmPort } from './types';

/**
 * 훅: 에이전트가 일하는 중 정해진 때에 사용자의 명령을 실행한다 (Claude Code의 hooks와 같은 생각).
 * 감사 기록, 사내 정책 검사, 알림에 쓴다. 이 파일은 브라우저·Node 어느 쪽에도 기대지 않는다.
 * 명령을 실제로 돌리는 일은 클라이언트가 `HookExec`로 주입한다 (client/src/hooks.ts).
 */
export const HOOK_EVENTS = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop'] as const;
export type HookEvent = (typeof HOOK_EVENTS)[number];

export const HOOK_EVENT_HELP: Record<HookEvent, string> = {
  SessionStart: '대화(세션)에서 첫 요청을 받을 때',
  UserPromptSubmit: '사용자가 요청을 보낸 직후, 처리 전 (막을 수 있음)',
  PreToolUse: '도구(클릭·입력·엑셀 쓰기 등)를 쓰기 직전 (막을 수 있음)',
  PostToolUse: '도구를 쓴 직후 (결과를 볼 수 있음)',
  Stop: '요청 하나가 끝났을 때 (성공·실패 무관)',
};

export interface HookEntry {
  event: HookEvent;
  /** 도구 이름 정규식 (PreToolUse·PostToolUse). 비면 모든 도구. 예: "excel_write|excel_save" */
  matcher?: string;
  /** 셸 명령. 표준입력으로 JSON(HookPayload)을 받는다 */
  command: string;
  /** 기본 10초 */
  timeoutSec?: number;
  /** 목록에 보일 이름 */
  name?: string;
}

export interface HookPayload {
  event: HookEvent;
  tool_name?: string;
  tool_input?: unknown;
  /** PostToolUse: 도구 결과 글 */
  tool_response?: string;
  ok?: boolean;
  skill?: string;
  /** UserPromptSubmit */
  prompt?: string;
  /** Stop */
  status?: string;
  message?: string;
  files?: string[];
}

/** 훅 명령이 끝난 모양 */
export interface HookExecResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut?: boolean;
  /** 실행 자체가 안 됨 (명령을 못 찾음 등) */
  error?: string;
}
export type HookExec = (entry: HookEntry, payload: HookPayload) => Promise<HookExecResult>;

/** 훅들을 돌린 뒤 판정 */
export interface HookDecision {
  block: boolean;
  reason?: string;
  /** 모델이나 사용자에게 보여 줄 덧붙임 (훅 stdout의 additionalContext, 일반 stdout) */
  context: string[];
  /** 사람이 볼 알림 (실패·시간 초과 등). 막지는 않는다 */
  notes: string[];
}

export interface HookPort {
  run(payload: HookPayload): Promise<HookDecision>;
  /** 이 이벤트에 걸린 훅이 있는지 (없으면 부르지 않아 빠르다) */
  has(event: HookEvent, tool?: string): boolean;
}

const EntrySchema = z.object({
  matcher: z.string().optional(),
  command: z.string().min(1),
  timeoutSec: z.number().positive().max(300).optional(),
  name: z.string().optional(),
});
const NestedSchema = z.object({
  matcher: z.string().optional(),
  hooks: z.array(z.object({ type: z.string().optional(), command: z.string().min(1), timeout: z.number().positive().max(300).optional() })),
});

/**
 * hooks.json을 읽는다. 두 모양을 받는다.
 *  1) {"hooks": {"PreToolUse": [{"matcher": "excel_write", "command": "…"}]}}
 *  2) Claude Code 모양 {"hooks": {"PreToolUse": [{"matcher": "…", "hooks": [{"type": "command", "command": "…"}]}]}}
 * 잘못된 항목은 건너뛰고 errors에 이유를 남긴다.
 */
export function parseHooksConfig(raw: unknown): { entries: HookEntry[]; errors: string[] } {
  const entries: HookEntry[] = [];
  const errors: string[] = [];
  const root = (raw as { hooks?: unknown } | null)?.hooks;
  if (!root || typeof root !== 'object') return { entries, errors: raw == null ? [] : ['"hooks" 항목이 없습니다'] };
  for (const [event, list] of Object.entries(root as Record<string, unknown>)) {
    if (!(HOOK_EVENTS as readonly string[]).includes(event)) {
      errors.push(`알 수 없는 이벤트 "${event}" (${HOOK_EVENTS.join(', ')})`);
      continue;
    }
    if (!Array.isArray(list)) {
      errors.push(`${event}: 목록이어야 합니다`);
      continue;
    }
    list.forEach((item, i) => {
      const nested = NestedSchema.safeParse(item);
      if (nested.success) {
        for (const h of nested.data.hooks) entries.push({ event: event as HookEvent, matcher: nested.data.matcher, command: h.command, timeoutSec: h.timeout });
        return;
      }
      const flat = EntrySchema.safeParse(item);
      if (!flat.success) {
        errors.push(`${event}[${i}]: command가 필요합니다`);
        return;
      }
      if (flat.data.matcher && !validRegex(flat.data.matcher)) {
        errors.push(`${event}[${i}]: matcher가 올바른 정규식이 아닙니다 (${flat.data.matcher})`);
        return;
      }
      entries.push({ event: event as HookEvent, ...flat.data });
    });
  }
  return { entries, errors };
}

/** 항목들을 hooks.json 글로 (사람이 고치기 쉽게 평평한 모양) */
export function serializeHooks(entries: HookEntry[]): string {
  const hooks: Record<string, Omit<HookEntry, 'event'>[]> = {};
  for (const { event, ...rest } of entries) (hooks[event] ??= []).push(rest);
  return `${JSON.stringify({ hooks }, null, 2)}\n`;
}

function validRegex(s: string): boolean {
  try {
    new RegExp(s);
    return true;
  } catch {
    return false;
  }
}

/** matcher가 이 도구에 맞는지. 이벤트가 도구와 상관없으면(PreToolUse·PostToolUse가 아니면) 항상 맞다 */
export function hookMatches(entry: HookEntry, event: HookEvent, tool?: string): boolean {
  if (entry.event !== event) return false;
  if (event !== 'PreToolUse' && event !== 'PostToolUse') return true;
  if (!entry.matcher || entry.matcher === '*') return true;
  if (!tool) return false;
  try {
    return new RegExp(`^(?:${entry.matcher})$`).test(tool);
  } catch {
    return false;
  }
}

const clip = (s: string, n = 400) => (s.length > n ? `${s.slice(0, n)}…` : s);

/**
 * 훅 하나의 결과를 해석한다.
 *  - 종료 코드 2: 막는다. 이유는 stderr (없으면 stdout).
 *  - 종료 코드 0: stdout이 JSON이면 {"decision":"block","reason":"…"} 또는 {"additionalContext":"…"}를 따른다. 아니면 그냥 알림 글.
 *  - 그 밖의 종료 코드·시간 초과·실행 실패: 막지 않고 알림만 (훅이 고장 났다고 업무가 멈추면 안 된다).
 */
export function interpretHook(entry: HookEntry, r: HookExecResult): { block?: string; context?: string; note?: string } {
  const label = entry.name ?? clip(entry.command, 40);
  if (r.error) return { note: `훅 "${label}"을(를) 실행하지 못했습니다: ${r.error}` };
  if (r.timedOut) return { note: `훅 "${label}"이(가) 시간 안에 끝나지 않아 무시했습니다` };
  if (r.code === 2) return { block: clip((r.stderr.trim() || r.stdout.trim() || `훅 "${label}"이(가) 막았습니다`)) };
  if (r.code !== 0) return { note: `훅 "${label}"이(가) 종료 코드 ${r.code}로 끝났습니다${r.stderr.trim() ? `: ${clip(r.stderr.trim(), 200)}` : ''}` };
  const out = r.stdout.trim();
  if (!out) return {};
  if (out.startsWith('{')) {
    try {
      const j = JSON.parse(out) as { decision?: string; reason?: string; additionalContext?: string; message?: string };
      if (j.decision === 'block') return { block: clip(j.reason || `훅 "${label}"이(가) 막았습니다`) };
      const ctx = j.additionalContext ?? j.message;
      return ctx ? { context: clip(String(ctx), 1000) } : {};
    } catch {
      /* JSON이 아니면 글로 */
    }
  }
  return { context: clip(out, 1000) };
}

/** 이벤트에 걸린 훅들을 차례로 돌려 하나로 합친다. 하나라도 막으면 거기서 멈춘다. */
export function createHooks(entries: HookEntry[], exec: HookExec): HookPort {
  return {
    has: (event, tool) => entries.some((e) => hookMatches(e, event, tool)),
    async run(payload) {
      const decision: HookDecision = { block: false, context: [], notes: [] };
      for (const entry of entries) {
        if (!hookMatches(entry, payload.event, payload.tool_name)) continue;
        const r = interpretHook(entry, await exec(entry, payload));
        if (r.note) decision.notes.push(r.note);
        if (r.context) decision.context.push(r.context);
        if (r.block) {
          decision.block = true;
          decision.reason = r.block;
          break;
        }
      }
      return decision;
    },
  };
}

const Drafted = z.object({
  event: z.enum(HOOK_EVENTS),
  matcher: z.string().optional(),
  command: z.string().min(1),
  name: z.string().optional(),
  reason: z.string().optional(),
});

export const HOOK_COMPOSE_PROMPT = `당신은 Dogent의 훅 작성기입니다. 사용자가 말로 한 부탁을 훅 하나로 바꿉니다.

이벤트: ${HOOK_EVENTS.map((e) => `${e}(${HOOK_EVENT_HELP[e]})`).join(' / ')}
도구 이름 예: click, type, select, navigate, excel_write, excel_save, word_write, ppt_write, write_excel, download_table, fill_table, call_tool, run_script, upload_file

명령은 Windows 셸(cmd)에서 돈다. 표준입력으로 JSON(event, tool_name, tool_input, tool_response, prompt, status, message 등)을 받는다.
- 막으려면 종료 코드 2로 끝내고 이유를 stderr에 쓴다.
- 기록은 파일에 덧붙이는 명령으로 쓴다 (예: type con >> %USERPROFILE%\\.dogent\\audit.log).
- 명령은 짧고 안전하게. 파일을 지우거나 네트워크로 보내는 명령은 쓰지 않는다.

JSON 객체 하나로만 답한다.
{"event": "<이벤트>", "matcher": "<도구 이름 정규식 또는 생략>", "command": "<셸 명령>", "name": "<짧은 이름>", "reason": "<한 문장>"}`;

/** 말로 한 부탁("엑셀 저장할 때마다 기록 남겨줘")을 훅 항목으로 바꾼다. 저장은 호출한 쪽이 사용자 확인 뒤에 한다. */
export async function composeHook(request: string, llm: LlmPort, signal?: AbortSignal): Promise<{ entry: HookEntry; reason: string }> {
  const reply = await llm.complete(
    [
      { role: 'system', content: HOOK_COMPOSE_PROMPT },
      { role: 'user', content: request },
    ],
    signal,
  );
  const json = extractJson(reply);
  if (!json) throw new Error('모델이 훅을 JSON으로 주지 않았습니다');
  const d = Drafted.parse(JSON.parse(json));
  if (d.matcher && !validRegex(d.matcher)) throw new Error(`matcher가 올바른 정규식이 아닙니다: ${d.matcher}`);
  return { entry: { event: d.event, ...(d.matcher ? { matcher: d.matcher } : {}), command: d.command, ...(d.name ? { name: d.name } : {}) }, reason: d.reason ?? '' };
}

/** 사용자가 훅을 말하는 문장인지 ("훅", "hook"이 들어 있고 만들기·보기·지우기 뜻이 있을 때만) */
export function hookRequestKind(text: string): 'list' | 'add' | 'remove' | null {
  if (!/(훅|\bhooks?\b)/i.test(text)) return null;
  if (/(지워|삭제|없애|빼|끄|remove|delete)/i.test(text)) return 'remove';
  if (/(보여|목록|뭐가|무슨|알려|list|show|있어|있나)/i.test(text) && !/(만들|추가|걸어\s*줘|넣어\s*줘|등록|add)/i.test(text)) return 'list';
  if (/(만들|추가|걸어\s*(줘|놔)|넣어\s*줘|등록|해\s*줘|하게|add|create)/i.test(text)) return 'add';
  return null;
}

/** 계획 먼저 보이기 (plan mode) */
export const PLAN_PROMPT = `당신은 업무 에이전트의 계획 수립기입니다. 사용자의 요청을 실행하기 전에 할 일을 3~7개의 짧은 단계로 나눕니다.

- 한 줄에 한 단계, "1. ", "2. " 번호로 시작합니다.
- 각 단계는 목표 문장입니다 (어떻게 클릭할지가 아니라 무엇을 이룰지).
- 저장·상신·전송처럼 되돌리기 어려운 단계는 "(확인 필요)"를 뒤에 붙입니다.
- 계획만 쓰고 다른 설명은 하지 않습니다.`;

export async function draftPlan(request: string, llm: LlmPort, context?: string, signal?: AbortSignal): Promise<string[]> {
  const reply = await llm.complete(
    [
      { role: 'system', content: PLAN_PROMPT },
      { role: 'user', content: `${context ? `${context}\n\n` : ''}## 요청\n${request}` },
    ],
    signal,
  );
  return reply
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => /^\d+[.)]\s/.test(l))
    .map((l) => l.replace(/^\d+[.)]\s*/, ''))
    .slice(0, 8);
}
