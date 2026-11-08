import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createHooks, parseHooksConfig, serializeHooks, type HookEntry, type HookExec, type HookPort } from '../../src/core';

/**
 * 훅 설정 파일: ~/.dogent/hooks.json (개인 것만 읽는다).
 * 팀 저장소에서 받은 파일은 읽지 않는다 — 동기화만으로 이 PC에서 명령이 실행되면 안 되기 때문이다.
 */
export function hooksFile(home: string): string {
  return join(home, 'hooks.json');
}

export function loadHookEntries(home: string): { entries: HookEntry[]; errors: string[] } {
  const file = hooksFile(home);
  if (!existsSync(file)) return { entries: [], errors: [] };
  try {
    return parseHooksConfig(JSON.parse(readFileSync(file, 'utf8')));
  } catch (e) {
    return { entries: [], errors: [`${file}을(를) 읽지 못했습니다: ${(e as Error).message}`] };
  }
}

export function saveHookEntries(home: string, entries: HookEntry[]): string {
  const file = hooksFile(home);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, serializeHooks(entries));
  return file;
}

const OUTPUT_MAX = 64 * 1024;

/** 셸 명령을 돌린다. 표준입력으로 payload JSON을 주고, 시간이 지나면 끊는다. */
export const execHook: HookExec = (entry, payload) =>
  new Promise((resolve) => {
    let out = '';
    let err = '';
    let done = false;
    const finish = (r: Parameters<typeof resolve>[0]) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(r);
    };
    const child = spawn(entry.command, { shell: true, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, DOGENT_HOOK_EVENT: payload.event, ...(payload.tool_name ? { DOGENT_TOOL: payload.tool_name } : {}) } });
    const timer = setTimeout(() => {
      child.kill();
      finish({ code: null, stdout: out, stderr: err, timedOut: true });
    }, (entry.timeoutSec ?? 10) * 1000);
    child.stdout.on('data', (d) => (out = (out + d).slice(0, OUTPUT_MAX)));
    child.stderr.on('data', (d) => (err = (err + d).slice(0, OUTPUT_MAX)));
    child.on('error', (e) => finish({ code: null, stdout: out, stderr: err, error: e.message }));
    child.on('close', (code) => finish({ code, stdout: out, stderr: err }));
    child.stdin.on('error', () => {});
    child.stdin.end(JSON.stringify(payload));
  });

/** 지금 설정으로 훅 통로를 만든다. 설정이 없으면 null (루프는 훅을 부르지 않는다) */
export function loadHooks(home: string, exec: HookExec = execHook): { port: HookPort | null; entries: HookEntry[]; errors: string[] } {
  const { entries, errors } = loadHookEntries(home);
  return { port: entries.length ? createHooks(entries, exec) : null, entries, errors };
}

export function describeHookEntries(entries: HookEntry[]): string {
  if (!entries.length) return '걸어 둔 훅이 없습니다. 예: "엑셀에 쓰기 전에 기록 남기는 훅 만들어줘"';
  return entries.map((e, i) => `${i + 1}. [${e.event}${e.matcher ? ` · ${e.matcher}` : ''}] ${e.name ? `${e.name} — ` : ''}${e.command}`).join('\n');
}
