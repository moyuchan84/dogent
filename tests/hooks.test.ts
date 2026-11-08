import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { composeHook, createHooks, draftPlan, hookMatches, hookRequestKind, interpretHook, parseHooksConfig, type HookEntry, type HookExec, type LlmPort } from '../src/core';
import { execHook, loadHookEntries, saveHookEntries } from '../client/src/hooks';

const entry = (o: Partial<HookEntry> = {}): HookEntry => ({ event: 'PreToolUse', command: 'x', ...o });
const llm = (reply: string): LlmPort => ({ complete: async () => reply });

describe('훅 설정 읽기', () => {
  it('평평한 모양과 Claude Code 모양을 둘 다 읽는다', () => {
    const { entries, errors } = parseHooksConfig({
      hooks: {
        PreToolUse: [{ matcher: 'excel_write', command: 'a' }, { matcher: 'click', hooks: [{ type: 'command', command: 'b', timeout: 5 }] }],
        Stop: [{ command: 'c' }],
      },
    });
    expect(errors).toEqual([]);
    expect(entries.map((e) => [e.event, e.command])).toEqual([['PreToolUse', 'a'], ['PreToolUse', 'b'], ['Stop', 'c']]);
    expect(entries[1].timeoutSec).toBe(5);
  });
  it('잘못된 이벤트·정규식·빈 명령은 건너뛰고 이유를 남긴다', () => {
    const { entries, errors } = parseHooksConfig({ hooks: { Nope: [{ command: 'a' }], PreToolUse: [{ matcher: '(', command: 'b' }, {}] } });
    expect(entries).toEqual([]);
    expect(errors).toHaveLength(3);
  });
});

describe('matcher', () => {
  it('도구 이름 전체에 맞아야 한다', () => {
    expect(hookMatches(entry({ matcher: 'excel_write|excel_save' }), 'PreToolUse', 'excel_save')).toBe(true);
    expect(hookMatches(entry({ matcher: 'click' }), 'PreToolUse', 'double_click')).toBe(false);
    expect(hookMatches(entry(), 'PreToolUse', 'anything')).toBe(true);
    expect(hookMatches(entry({ event: 'Stop', matcher: 'click' }), 'Stop')).toBe(true);
    expect(hookMatches(entry(), 'PostToolUse', 'click')).toBe(false);
  });
});

describe('훅 결과 해석', () => {
  const r = (o: object) => ({ code: 0, stdout: '', stderr: '', ...o });
  it('종료 코드 2는 막고 이유는 stderr', () => {
    expect(interpretHook(entry(), r({ code: 2, stderr: '운영 서버는 안 됩니다' })).block).toBe('운영 서버는 안 됩니다');
  });
  it('JSON decision=block도 막는다', () => {
    expect(interpretHook(entry(), r({ stdout: '{"decision":"block","reason":"금지"}' })).block).toBe('금지');
  });
  it('고장 난 훅은 막지 않고 알린다', () => {
    expect(interpretHook(entry(), r({ code: 1, stderr: 'boom' })).block).toBeUndefined();
    expect(interpretHook(entry(), r({ code: null, timedOut: true })).note).toMatch(/시간/);
    expect(interpretHook(entry(), r({ code: null, error: 'ENOENT' })).note).toMatch(/ENOENT/);
  });
  it('stdout은 덧붙임 글', () => {
    expect(interpretHook(entry(), r({ stdout: '{"additionalContext":"주의"}' })).context).toBe('주의');
    expect(interpretHook(entry(), r({ stdout: '기록함' })).context).toBe('기록함');
  });
});

describe('훅 통로', () => {
  it('맞는 훅만 돌리고 막으면 거기서 멈춘다', async () => {
    const calls: string[] = [];
    const exec: HookExec = async (e) => {
      calls.push(e.command);
      return { code: e.command === 'deny' ? 2 : 0, stdout: '', stderr: '안 됨' };
    };
    const port = createHooks([entry({ matcher: 'click', command: 'deny' }), entry({ matcher: 'click', command: 'after' }), entry({ matcher: 'type', command: 'other' })], exec);
    expect(port.has('PreToolUse', 'click')).toBe(true);
    expect(port.has('PreToolUse', 'scroll')).toBe(false);
    const d = await port.run({ event: 'PreToolUse', tool_name: 'click' });
    expect(d.block).toBe(true);
    expect(d.reason).toBe('안 됨');
    expect(calls).toEqual(['deny']);
  });
});

describe('실제 명령 실행', () => {
  const dirs: string[] = [];
  afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));
  const node = (code: string) => `node -e "${code}"`;
  it('표준입력으로 payload를 받고 종료 코드 2로 막는다', async () => {
    const e = entry({ command: node("let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const p=JSON.parse(s);console.error('도구:'+p.tool_name);process.exit(2)})") });
    const r = await execHook(e, { event: 'PreToolUse', tool_name: 'excel_write' });
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('도구:excel_write');
  });
  it('시간이 지나면 끊는다', async () => {
    const r = await execHook(entry({ command: node('setTimeout(()=>{},5000)'), timeoutSec: 0.3 }), { event: 'Stop' });
    expect(r.timedOut).toBe(true);
  });
  it('저장하고 다시 읽는다', () => {
    const home = mkdtempSync(join(tmpdir(), 'dogent-hooks-'));
    dirs.push(home);
    saveHookEntries(home, [entry({ matcher: 'click', command: 'a', name: 'n' }), entry({ event: 'Stop', command: 'b' })]);
    expect(loadHookEntries(home).entries).toEqual([
      { event: 'PreToolUse', matcher: 'click', command: 'a', name: 'n' },
      { event: 'Stop', command: 'b' },
    ]);
  });
});

describe('말로 만들기', () => {
  it('훅 이야기인지 가린다', () => {
    expect(hookRequestKind('엑셀에 쓰기 전에 기록 남기는 훅 만들어줘')).toBe('add');
    expect(hookRequestKind('걸어둔 훅 보여줘')).toBe('list');
    expect(hookRequestKind('2번 훅 지워줘')).toBe('remove');
    expect(hookRequestKind('MES에서 재공 내려받아줘')).toBeNull();
  });
  it('모델 답을 훅으로 바꾼다', async () => {
    const r = await composeHook('엑셀 저장 전에 기록', llm('```json\n{"event":"PreToolUse","matcher":"excel_save","command":"type con >> audit.log","name":"감사"}\n```'));
    expect(r.entry).toEqual({ event: 'PreToolUse', matcher: 'excel_save', command: 'type con >> audit.log', name: '감사' });
  });
  it('이벤트가 틀리면 거절한다', async () => {
    await expect(composeHook('x', llm('{"event":"Whenever","command":"a"}'))).rejects.toThrow();
  });
});

describe('계획 먼저', () => {
  it('번호 붙은 줄만 단계로 읽는다', async () => {
    const steps = await draftPlan('재공 정리', llm('계획입니다\n1. MES 열기\n2) 7라인 조회\n3. 엑셀 저장 (확인 필요)\n끝'));
    expect(steps).toEqual(['MES 열기', '7라인 조회', '엑셀 저장 (확인 필요)']);
  });
});

describe('실행 루프에 꽂기', () => {
  it('PreToolUse 훅이 막으면 도구를 쓰지 않고 3번 막히면 멈춘다', async () => {
    const { runSkill } = await import('../src/core');
    const { JsdomBrowser, memoryFiles, mockLlm, wipSkill } = await import('./helpers');
    const seen: string[] = [];
    const exec: HookExec = async (e, p) => {
      seen.push(`${p.event}:${p.tool_name}`);
      return e.event === 'PreToolUse' ? { code: 2, stdout: '', stderr: '정책상 금지' } : { code: 0, stdout: '', stderr: '' };
    };
    const events: string[] = [];
    const result = await runSkill(
      wipSkill(),
      { line: '7라인', hold_hours: 24 },
      {
        llm: mockLlm,
        browser: await JsdomBrowser.open('/wip.html'),
        ui: { ask: async () => '', approve: async () => false },
        files: memoryFiles(),
        hooks: createHooks([{ event: 'PreToolUse', command: 'deny' }, { event: 'PostToolUse', command: 'log' }], exec),
        onEvent: (e) => e.type === 'blocked' && events.push(e.reason),
      },
    );
    expect(result.status).toBe('aborted');
    expect(events.some((r) => r.includes('훅이 막음: 정책상 금지'))).toBe(true);
    expect(seen.every((s) => s.startsWith('PreToolUse:'))).toBe(true);
  });

  it('PostToolUse 훅은 통과한 도구마다 불리고 결과에 의견이 붙는다', async () => {
    const { runSkill } = await import('../src/core');
    const { JsdomBrowser, memoryFiles, mockLlm, wipSkill } = await import('./helpers');
    const tools: string[] = [];
    const exec: HookExec = async (_e, p) => (tools.push(p.tool_name ?? ''), { code: 0, stdout: '', stderr: '' });
    const result = await runSkill(
      wipSkill(),
      { line: '7라인', hold_hours: 24 },
      { llm: mockLlm, browser: await JsdomBrowser.open('/wip.html'), ui: { ask: async () => '', approve: async () => false }, files: memoryFiles(), direct: true, hooks: createHooks([{ event: 'PostToolUse', command: 'log' }], exec) },
    );
    expect(result.status, result.message).toBe('done');
    expect(tools.length).toBeGreaterThan(0);
    expect(tools).not.toContain('next_step');
  });
});
