import { z } from 'zod';
import type { Cell } from './types';

/**
 * 스킬에 딸린 스크립트 (run_script). transform으로 못 하는 가공(복잡한 계산, 여러 표 병합, 정규식 파싱, 통계)을
 * 스킬 폴더의 Node·Python 스크립트로 한다.
 *
 *   skills/<id>/SKILL.md          선언부의 scripts: 에 이름·파일·설명을 적는다
 *   skills/<id>/scripts/<이름>.mjs  (또는 .py)
 *
 * 주고받기는 표준 입출력의 JSON 한 덩이다.
 *   입력  {"args": {...}, "datasets": {"이름": {"columns": [...], "rows": [[...]]}}}
 *   출력  {"datasets": {"이름": {"columns", "rows"}}, "text": "보고에 넣을 글", "files": [{"name", "text" | "base64"}]}
 *
 * 통제
 * - 선언한 스크립트만, 스킬 폴더에 있는 내용 그대로 실행한다. 모델이 코드를 지어 실행하지 않는다.
 * - 처음 실행할 때와 내용이 바뀌었을 때 코드를 보여 주고 사용자의 승인을 받는다 (내용의 해시로 기억).
 * - Node는 권한 모드로 돌려 파일 읽기·쓰기, 다른 프로그램 실행, 워커를 막는다. Python은 막을 수 없어 PC 권한 그대로 돈다고 알린다.
 * - 시간 제한과 출력 크기 제한이 있다. 실행은 데스크탑 앱과 터미널 클라이언트에서만 된다 (확장은 프로그램을 실행할 수 없다).
 */

export const SCRIPT_NAME = /^[a-z][a-z0-9_-]*$/;

export const ScriptDecl = z.object({
  name: z.string().regex(SCRIPT_NAME, '영문 소문자로 시작하고 소문자·숫자·_·-만 씁니다'),
  file: z
    .string()
    .regex(/^scripts\/[A-Za-z0-9_.-]+\.(mjs|js|py)$/, 'scripts/ 아래의 .mjs, .js, .py 파일이어야 합니다')
    .refine((f) => !f.includes('..'), '상위 폴더를 가리킬 수 없습니다'),
  /** 무엇을 받아 무엇을 돌려주는지. 모델이 언제 부를지 정하는 근거가 된다 */
  description: z.string().min(1),
  /** 사내 API 등 네트워크를 쓰는지. 승인 창에 보여 준다 (Node 권한 모드는 네트워크를 막지 못한다) */
  network: z.boolean().default(false),
  timeout_sec: z.number().int().positive().max(300).default(60),
});
export type ScriptDecl = z.infer<typeof ScriptDecl>;

export type ScriptLang = 'node' | 'python';
export const scriptLang = (file: string): ScriptLang => (/\.py$/i.test(file) ? 'python' : 'node');

/** 스크립트 출력의 최대 크기 (글자) */
export const SCRIPT_OUTPUT_MAX = 20_000_000;

const TableOut = z.object({
  columns: z.array(z.string()),
  rows: z.array(z.array(z.union([z.string(), z.number(), z.boolean(), z.null()]))),
});
export const ScriptOutput = z.object({
  datasets: z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/, '데이터셋 이름은 영문·숫자·_'), TableOut).default({}),
  text: z.string().optional(),
  files: z
    .array(
      z.union([
        z.object({ name: z.string().min(1), text: z.string() }),
        z.object({ name: z.string().min(1), base64: z.string() }),
      ]),
    )
    .max(20)
    .default([]),
});
export type ScriptOutput = z.infer<typeof ScriptOutput>;

export interface ScriptRequest {
  skill: string;
  name: string;
  file: string;
  lang: ScriptLang;
  code: string;
  /** 표준 입력으로 줄 JSON */
  input: string;
  timeoutMs: number;
  signal?: AbortSignal;
}

export interface ScriptRun {
  stdout: string;
  stderr: string;
  /** 종료 코드. 시간이 지나 끊었으면 null */
  code: number | null;
  timedOut?: boolean;
}

/** 스크립트를 실행하는 통로. 데스크탑 앱과 터미널 클라이언트가 준다 */
export interface ScriptPort {
  run(req: ScriptRequest): Promise<ScriptRun>;
  /** 이 내용(해시)을 사용자가 이미 승인했는지 */
  approved(hash: string): Promise<boolean>;
  /** 승인을 기억한다 */
  remember(hash: string, info: { skill: string; file: string }): Promise<void>;
  /** 이 환경의 실행 방식 설명 (승인 창에 보여 준다). 예: "Node 권한 모드 (파일·프로그램 실행 막힘)" */
  sandbox(lang: ScriptLang): string;
}

/** 스킬·파일·내용을 묶은 SHA-256. 내용이 한 글자라도 바뀌면 다시 승인받는다 */
export async function scriptHash(skill: string, file: string, code: string): Promise<string> {
  const data = new TextEncoder().encode(`${skill}\n${file}\n${code.replace(/\r\n/g, '\n')}`);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

const PREVIEW_LINES = 40;

/** 승인 창에 보여 줄 글 */
export function approvalText(skill: string, decl: ScriptDecl, code: string, sandbox: string, hash: string): string {
  const lines = code.replace(/\r\n/g, '\n').split('\n');
  const shown = lines.slice(0, PREVIEW_LINES).join('\n');
  return [
    `스킬 "${skill}"의 스크립트 ${decl.file}을(를) 이 PC에서 실행합니다.`,
    `- 하는 일: ${decl.description}`,
    `- 실행 방식: ${sandbox}`,
    `- 네트워크: ${decl.network ? '씀 (스킬이 선언함)' : '쓰지 않는다고 선언함'}`,
    `- 내용 ${lines.length}줄, 해시 ${hash.slice(0, 12)}`,
    '',
    shown,
    ...(lines.length > PREVIEW_LINES ? [`… (나머지 ${lines.length - PREVIEW_LINES}줄은 스킬 폴더의 파일에서 보세요)`] : []),
    '',
    '처음 실행하거나 내용이 바뀐 스크립트라 확인을 받습니다. 승인하면 같은 내용은 다시 묻지 않습니다',
  ].join('\n');
}

/** 스크립트의 표준 출력을 읽는다. 마지막 JSON 줄이나 출력 전체를 결과로 본다 (앞에 찍은 로그는 건너뛴다) */
export function parseScriptOutput(stdout: string): ScriptOutput {
  const text = stdout.trim();
  if (!text) return ScriptOutput.parse({});
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    const last = text.split(/\r?\n/).reverse().find((l) => l.trim().startsWith('{'));
    if (!last) throw new Error(`스크립트 출력이 JSON이 아닙니다: ${text.slice(0, 200)}`);
    try {
      raw = JSON.parse(last);
    } catch {
      throw new Error(`스크립트 출력의 마지막 줄이 JSON이 아닙니다: ${last.slice(0, 200)}`);
    }
  }
  const parsed = ScriptOutput.safeParse(raw);
  if (!parsed.success) throw new Error(`스크립트 출력의 모양이 맞지 않습니다: ${parsed.error.issues.map((i) => `${i.path.join('.')} ${i.message}`).join('; ')}`);
  return parsed.data;
}

/** 출력 표의 칸을 데이터셋 칸으로 (null은 빈칸, 참/거짓은 글자) */
export const toCell = (v: string | number | boolean | null): Cell => (v === null ? '' : typeof v === 'boolean' ? String(v) : v);

/** 모델에 보여 줄 스크립트 목록 */
export function scriptsPrompt(scripts: ScriptDecl[] = []): string {
  if (scripts.length === 0) return '';
  return [
    '',
    '## 이 스킬의 스크립트 (run_script로 부름)',
    ...scripts.map((s) => `- ${s.name}: ${s.description}`),
    '',
  ].join('\n');
}

/** 스크립트를 쓴 사람에게 보여 줄 입출력 약속 (스킬 문서·만들기 프롬프트에 쓴다) */
export const SCRIPT_CONTRACT = `표준 입력으로 JSON 하나를 받습니다: {"args": {...}, "datasets": {"이름": {"columns": ["열", ...], "rows": [[값, ...], ...]}}}
표준 출력에 JSON 하나를 씁니다: {"datasets": {"새이름": {"columns": [...], "rows": [...]}}, "text": "보고에 넣을 글(선택)", "files": [{"name": "결과.csv", "text": "..."}](선택)}
파일을 읽거나 쓰지 않고, 다른 프로그램을 실행하지 않습니다 (Node는 권한 모드라 막힙니다). 표준 라이브러리만 씁니다.`;
