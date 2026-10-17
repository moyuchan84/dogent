import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { dogentHome } from './config';

/**
 * 예약 실행. Windows 작업 스케줄러(schtasks)에 "dogent run <스킬> …"을 등록한다.
 *
 * - 작업은 지금 사용자로, 로그인해 있을 때만 돈다 (브라우저와 확장이 떠 있어야 하고, 사내 로그인 세션을 쓰기 때문이다).
 * - 사람이 없는 시간에 도는 일이라 저장·상신은 하지 않는다. 승인 창이 뜨는 단계에서 멈춘다 (--allow-write를 주지 않는다).
 * - 실행 기록은 직접 실행과 같이 runs.jsonl에 남는다 (앱의 기록 탭).
 */
const FOLDER = 'Dogent';
const DAYS: Record<string, string> = { 월: 'MON', 화: 'TUE', 수: 'WED', 목: 'THU', 금: 'FRI', 토: 'SAT', 일: 'SUN' };

export interface ScheduleSpec {
  name: string;
  /** HH:MM (24시간) */
  at: string;
  /** 비면 매일. 월,수,금처럼 요일 글자 */
  days: string[];
  skill: string;
  /** 이름=값 */
  inputs: string[];
}

/** schtasks는 콘솔 코드 페이지(한국어 윈도우는 CP949)로 말한다. UTF-8로 읽히지 않으면 EUC-KR로 읽는다. */
function decode(b: unknown): string {
  const buf = Buffer.isBuffer(b) ? b : Buffer.from(String(b ?? ''));
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    return new TextDecoder('euc-kr').decode(buf);
  }
}

const schtasks = () => join(process.env.SystemRoot ?? 'C:/Windows', 'System32', 'schtasks.exe');
const scriptsDir = () => join(dogentHome(), 'schedules');
const safeName = (name: string) => name.replace(/[^\p{L}\p{N}_-]/gu, '_');
const taskName = (name: string) => `${FOLDER}\\${safeName(name)}`;

/** schtasks에 넘길 인자를 만든다 (실제 등록과 분리해 시험할 수 있게). */
export function createArgs(spec: ScheduleSpec, script: string): string[] {
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(spec.at)) throw new Error(`시각은 HH:MM (24시간)으로 적으세요: ${spec.at}`);
  const days = spec.days.map((d) => {
    const code = DAYS[d.trim()];
    if (!code) throw new Error(`요일은 월 화 수 목 금 토 일 중에서 적으세요: ${d}`);
    return code;
  });
  return [
    '/Create', '/F',
    '/TN', taskName(spec.name),
    '/TR', `"${script}"`,
    ...(days.length ? ['/SC', 'WEEKLY', '/D', days.join(',')] : ['/SC', 'DAILY']),
    '/ST', spec.at,
  ];
}

/** 작업이 부를 .cmd. 한글 입력값이 깨지지 않게 코드 페이지를 UTF-8로 두고, 작업 명령줄에는 이 파일 경로만 넣는다. */
export function scriptText(spec: ScheduleSpec, node: string, cli: string): string {
  const q = (s: string) => `"${s.replace(/"/g, '""')}"`;
  return `@echo off\r\nchcp 65001 >nul\r\n${[q(node), q(cli), 'run', q(spec.skill), ...spec.inputs.map(q), '--yes'].join(' ')}\r\n`;
}

export function addSchedule(spec: ScheduleSpec, node = process.execPath, cli = process.argv[1]): string {
  if (!spec.name.trim() || !spec.skill) throw new Error('예약 이름과 스킬 ID가 필요합니다');
  mkdirSync(scriptsDir(), { recursive: true });
  const script = join(scriptsDir(), `${safeName(spec.name)}.cmd`);
  writeFileSync(script, scriptText(spec, node, cli));
  try {
    execFileSync(schtasks(), createArgs(spec, script), { stdio: 'pipe' });
  } catch (e) {
    rmSync(script, { force: true });
    throw new Error(`작업 스케줄러에 등록하지 못했습니다: ${(decode((e as { stderr?: Buffer }).stderr) || (e as Error).message).trim()}`);
  }
  return taskName(spec.name);
}

export function removeSchedule(name: string): void {
  try {
    execFileSync(schtasks(), ['/Delete', '/F', '/TN', taskName(name)], { stdio: 'pipe' });
  } catch {
    throw new Error(`예약이 없습니다: ${name}`);
  } finally {
    rmSync(join(scriptsDir(), `${safeName(name)}.cmd`), { force: true });
  }
}

/** 등록된 Dogent 예약의 이름 */
export function listSchedules(): string[] {
  const dir = scriptsDir();
  return existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.cmd')).map((f) => f.replace(/\.cmd$/, '')) : [];
}

/** 작업 스케줄러가 보는 상태(다음 실행 시각, 마지막 결과)를 글로 */
export function describeSchedule(name: string): string {
  try {
    const out = decode(execFileSync(schtasks(), ['/Query', '/TN', taskName(name), '/FO', 'LIST', '/V'], { stdio: 'pipe' }));
    const pick = (label: RegExp) => out.split(/\r?\n/).find((l) => label.test(l))?.split(/:\s*/).slice(1).join(': ').trim() ?? '';
    return `${name}  다음 ${pick(/Next Run Time|다음 실행 시간/i)}  마지막 결과 ${pick(/Last Result|마지막 결과/i)}`;
  } catch {
    return `${name}  (작업 스케줄러에 없음)`;
  }
}

/** dogent schedule add 의 나머지 인자를 읽는다: <이름> --at HH:MM [--days 월,수] <스킬ID> [이름=값 …] */
export function parseSpec(rest: string[]): ScheduleSpec {
  const free: string[] = [];
  let at = '';
  let days: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === '--at') at = rest[++i] ?? '';
    else if (rest[i] === '--days') days = (rest[++i] ?? '').split(',').filter(Boolean);
    else free.push(rest[i]);
  }
  const [name, skill, ...inputs] = free;
  if (!name || !skill || !at) throw new Error('사용법: dogent schedule add <이름> --at 09:00 [--days 월,수,금] <스킬ID> [이름=값 …]');
  return { name, at, days, skill, inputs };
}
