import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildFreeSkill, planRequest, type LlmPort } from '../src/core';
import { Conversation, addInstruction, contextNote, describeInstructions, loadInstructions } from '../client/src/conversation';
import { AgentPeer, agentPrompt, invocation, mentionedAgents, parseReply, runAgent, type AgentSpec } from '../client/src/agents';
import { McpHub } from '../client/src/mcp-hub';
import { Collector, DogentMcp, reportText, serveHttp, type DogentRunner } from '../client/src/mcp-serve';
import type { ClientConfig } from '../client/src/config';
import type { Session as SessionType } from '../client/src/session';

const tmp = (p: string) => mkdtempSync(join(tmpdir(), p));

describe('대화 맥락 (Conversation)', () => {
  it('최근 차례를 요청·처리·파일·데이터셋으로 보여 주고, 파일에서 이어 간다', () => {
    const file = join(tmp('dogent-conv-'), 'conversation.json');
    const c = new Conversation(file);
    expect(c.context()).toBeUndefined();
    c.add({ request: '7라인 재공 확인해 줘', skill: '재공 확인', status: 'done', summary: '정체 Lot 3건', files: ['D:\\out\\재공확인_7라인.xlsx'], datasets: [{ name: 'wip', rows: 12, columns: ['Lot ID', '공정'] }] });
    const ctx = c.context()!;
    expect(ctx).toMatch(/1\. 요청: 7라인 재공 확인해 줘/);
    expect(ctx).toMatch(/재공 확인 · 완료 — 정체 Lot 3건/);
    expect(ctx).toMatch(/파일: 재공확인_7라인\.xlsx/);
    expect(ctx).toMatch(/wip\(12행, 컬럼 Lot ID·공정\)/);
    const again = Conversation.resume(file);
    expect(again.turns).toHaveLength(1);
    expect(again.stale()).toBe(false);
    expect(again.stale(Date.now() + 7 * 3600_000)).toBe(true);
    again.clear();
    expect(Conversation.resume(file).empty).toBe(true);
  });

  it('모델에는 최근 5차례만 보인다', () => {
    const c = new Conversation();
    for (let i = 1; i <= 7; i++) c.add({ request: `요청${i}`, skill: '자유 요청', status: 'done', summary: '', files: [], datasets: [] });
    const ctx = c.context()!;
    expect(ctx).not.toMatch(/요청2\b/);
    expect(ctx).toMatch(/3\. 요청: 요청3/);
    expect(ctx).toMatch(/7\. 요청: 요청7/);
  });
});

describe('지침 파일 (DOGENT.md)', () => {
  it('개인·팀 지침을 읽고, "기억해"로 한 줄 더한다', () => {
    const home = tmp('dogent-mem-');
    const team = tmp('dogent-team-');
    expect(describeInstructions(loadInstructions(home, team))).toBeUndefined();
    writeFileSync(join(team, 'DOGENT.md'), '\uFEFF라인 이름은 "7라인"처럼 쓴다');
    addInstruction(home, '결과 엑셀은   라인별로 시트를 나눈다');
    const text = describeInstructions(loadInstructions(home, team))!;
    expect(text).toMatch(/### 팀 지침\n라인 이름은/);
    expect(text).toMatch(/### 내 지침[\s\S]*- 결과 엑셀은 라인별로 시트를 나눈다/);
    expect(contextNote({ instructions: text, conversation: '1. 요청: x' })).toMatch(/## 지침 \(늘 지킨다\)[\s\S]*## 앞선 대화/);
    expect(contextNote({})).toBeUndefined();
  });

  it('요청 해석과 자유 요청 둘 다 맥락을 모델에 보인다', async () => {
    const seen: string[] = [];
    const llm: LlmPort = {
      complete: async (messages) => {
        seen.push(messages.map((m) => m.content).join('\n'));
        return '{"skill_id": null, "inputs": {}, "reason": "없음"}';
      },
    };
    await planRequest('그거 엑셀로도 만들어 줘', [], llm, undefined, undefined, '## 앞선 대화\n1. 요청: 7라인 재공');
    expect(seen[0]).toMatch(/## 앞선 대화\n1\. 요청: 7라인 재공[\s\S]*## 사용자 요청\n그거 엑셀로도/);
    const free = buildFreeSkill('https://mes.example/', false, undefined, false, false, [], false, '## 앞선 대화\n1. 요청: 7라인 재공');
    expect(free.body).toMatch(/## 대화 맥락[\s\S]*### 앞선 대화\n1\. 요청: 7라인 재공/);
    // 맥락의 번호 목록이 단계로 읽히지 않는다
    expect(free.steps).toHaveLength(1);
  });
});

describe('외부 에이전트 (Claude Code, opencode)', () => {
  it('claude -p JSON 답에서 결과를 꺼내고, 그 밖에는 글 그대로', () => {
    const r = parseReply('claude', '{"type":"result","result":"요약 끝","is_error":false,"total_cost_usd":0.01,"session_id":"s1","permission_denials":[{}]}');
    expect(r).toMatchObject({ ok: true, costUsd: 0.01, sessionId: 's1' });
    expect(r.text).toMatch(/요약 끝\n\(권한이 없어 하지 못한 동작 1개\)/);
    expect(parseReply('claude', '{"result":"x","is_error":true}').ok).toBe(false);
    expect(parseReply('opencode', '\x1b[32m완료\x1b[0m').text).toBe('완료');
  });

  it('요청에 에이전트 이름이나 정해 둔 말이 나오면 그 에이전트를 쓴다', () => {
    const cfg = { agents: { claude: { kind: 'claude' } as AgentSpec, glm: { kind: 'opencode' } as AgentSpec, off: { kind: 'claude', disabled: true } as AgentSpec } };
    expect(mentionedAgents(cfg, '클로드코드로 이 csv 분석해 줘')).toEqual(['claude']);
    expect(mentionedAgents(cfg, '오픈코드한테 스크립트 짜 달라고 해')).toEqual(['glm']);
    expect(mentionedAgents(cfg, '재공 확인해 줘')).toEqual([]);
  });

  it('claude는 -p --output-format json, opencode는 run. 할 일은 인자로 넘기지 않는다', () => {
    const claude = invocation({ kind: 'claude', command: process.execPath });
    expect(claude.args).toEqual(['-p', '--output-format', 'json', '--permission-mode', 'acceptEdits']);
    expect(invocation({ kind: 'opencode', command: process.execPath, args: ['-m', 'corp/glm-5.3'] }).args).toEqual(['run', '-m', 'corp/glm-5.3']);
    expect(() => invocation({ kind: 'command', command: join(tmpdir(), 'no-such-agent.exe') })).toThrow(/찾지 못했습니다/);
    expect(agentPrompt('표를 요약', 'D:\\work')).toMatch(/표를 요약\n\n---\n일할 폴더: D:\\work/);
  });

  // 할 일을 stdin으로 받아 그대로 돌려주는 가짜 에이전트 (node -e)
  const echo: AgentSpec = {
    kind: 'command',
    command: process.execPath,
    args: ['-e', "let s='';process.stdin.on('data',c=>s+=c).on('end',()=>console.log('받음:'+s.split('\\n')[0]+' @'+process.cwd()))"],
  };

  it('할 일을 stdin으로 넘기고 일할 폴더에서 돌린다', async () => {
    const dir = tmp('dogent-agent-');
    const r = await runAgent(echo, '재공.xlsx를 "라인별" & 요약', { workdir: dir });
    expect(r.ok).toBe(true);
    expect(r.text).toContain('받음:재공.xlsx를 "라인별" & 요약');
    expect(r.text).toContain(dir);
  });

  it('제한 시간이 넘으면 끝내고 알린다', async () => {
    const slow: AgentSpec = { kind: 'command', command: process.execPath, args: ['-e', 'setTimeout(()=>{},60000)'], timeoutSec: 0.5 };
    await expect(runAgent(slow, 'x', { workdir: tmp('dogent-agent-') })).rejects.toThrow(/초 안에 끝나지 않았습니다/);
  });

  it('McpHub에 서버 하나처럼 들어가 call_tool로 부른다 (기본 권한 ask)', async () => {
    const hub = await McpHub.open({ servers: {} }, undefined, { config: { agents: { fake: echo } }, workdir: tmp('dogent-agent-') });
    const tool = hub.list().find((t) => t.name === 'fake.ask')!;
    expect(tool).toMatchObject({ readOnly: false, permission: 'ask' });
    const r = await hub.call('fake.ask', { task: '분석해 줘' });
    expect(r).toMatchObject({ isError: false });
    expect(r.text).toContain('받음:분석해 줘');
    const empty = await new AgentPeer('fake', echo, tmpdir()).ask('  ');
    expect(empty.ok).toBe(false);
    await hub.close();
  });
});

describe('Dogent를 MCP 서버로 (dogent serve, 앱의 MCP 주소)', () => {
  const report = { ok: true, transcript: '스킬: 재공 확인\n완료', saved: ['D:\\out\\a.xlsx'], result: { status: 'done' as const, message: '정체 3건', lastStep: 2, actions: 5, files: [], datasets: [{ name: 'wip', columns: ['Lot'], rowCount: 3 }], outputs: {}, elapsedMs: 4200 } };
  function runner(calls: string[], wait?: Promise<void>): DogentRunner {
    return {
      request: async (text, o) => {
        calls.push(`request:${text}:${o.allowWrite}:${o.caller}`);
        await wait;
        return report;
      },
      runSkill: async (id, inputs) => (calls.push(`skill:${id}:${JSON.stringify(inputs)}`), report),
      skills: async (q) => [{ id: 'wip-check', name: '재공 확인', description: q ?? '', source: '기본', risk: 'R1', inputs: [] }],
      systems: () => [{ id: 'gsams', name: 'GSAMS', description: '', url: 'https://gsams/', status: 'draft' }],
      newConversation: () => calls.push('new'),
    };
  }
  const call = (mcp: DogentMcp, name: string, args: Record<string, unknown> = {}) =>
    mcp.handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) as Promise<{ result: { content: { text: string }[]; isError: boolean } }>;

  it('initialize에서 부른 쪽 이름을 받고, 도구 다섯 개를 내놓는다', async () => {
    const calls: string[] = [];
    const mcp = new DogentMcp(runner(calls));
    const init = (await mcp.handle({ jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: '2025-06-18', clientInfo: { name: 'claude-code' } } })) as { result: { serverInfo: { name: string } } };
    expect(init.result.serverInfo.name).toBe('dogent');
    expect(await mcp.handle({ jsonrpc: '2.0', method: 'notifications/initialized' })).toBeNull();
    const list = (await mcp.handle({ jsonrpc: '2.0', id: 2, method: 'tools/list' })) as { result: { tools: { name: string }[] } };
    expect(list.result.tools.map((t) => t.name)).toEqual(['dogent_request', 'dogent_run_skill', 'dogent_skills', 'dogent_systems', 'dogent_new_conversation']);
    const r = await call(mcp, 'dogent_request', { request: '7라인 재공', allow_write: true });
    expect(calls[0]).toBe('request:7라인 재공:true:claude-code');
    expect(r.result.isError).toBe(false);
    const head = JSON.parse(r.result.content[0].text.split('\n\n---')[0]);
    expect(head).toMatchObject({ status: 'done', message: '정체 3건', files: ['D:\\out\\a.xlsx'], elapsed_sec: 4 });
    await call(mcp, 'dogent_run_skill', { skill_id: 'wip-check', inputs: { line: '7라인' } });
    expect(calls[1]).toBe('skill:wip-check:{"line":"7라인"}');
    expect((await call(mcp, 'dogent_request', {})).result.isError).toBe(true);
    expect((await call(mcp, 'dogent_systems', { query: '지삼스' })).result.content[0].text).toMatch(/gsams/);
  });

  it('한 번에 한 일만 받는다', async () => {
    let release!: () => void;
    const mcp = new DogentMcp(runner([], new Promise<void>((r) => (release = r))));
    const first = call(mcp, 'dogent_request', { request: 'a' });
    const second = await call(mcp, 'dogent_request', { request: 'b' });
    expect(second.result.isError).toBe(true);
    expect(second.result.content[0].text).toMatch(/다른 일을 하는 중/);
    release();
    expect((await first).result.isError).toBe(false);
  });

  it('사람이 없는 곳의 Ui는 확인에 "아니오", 질문에는 답하지 않고 기록에 남긴다', async () => {
    const c = new Collector();
    c.begin();
    expect(await c.confirm('엑셀에 씁니다. 진행할까요?', true)).toBe(false);
    expect(await c.ask('라인은?')).toBeNull();
    expect(await c.askDefault('담당 부서', '제조')).toBe('제조');
    c.result(report.result, ['D:\\out\\a.xlsx']);
    const r = c.end(true);
    expect(r.transcript).toMatch(/진행할까요\? → 아니오[\s\S]*라인은\? \(외부 호출이라/);
    expect(r.saved).toEqual(['D:\\out\\a.xlsx']);
    expect(reportText({ ...r, transcript: 'x'.repeat(7000) })).toMatch(/진행 기록 ---\n…x{6000}$/);
  });

  let server: Awaited<ReturnType<typeof serveHttp>> | null = null;
  afterEach(() => {
    server?.closeAllConnections();
    server?.close();
    server = null;
  });

  it('HTTP는 토큰이 맞고 브라우저에서 온 요청이 아닐 때만 받는다', async () => {
    server = await serveHttp(new DogentMcp(runner([])), { port: 0, token: 't0k' });
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
    expect((await fetch(`${url}/mcp`, { method: 'POST', body })).status).toBe(401);
    expect((await fetch(`${url}/mcp`, { method: 'POST', body, headers: { authorization: 'Bearer t0k', origin: 'https://evil.example' } })).status).toBe(403);
    const ok = await fetch(`${url}/mcp`, { method: 'POST', body, headers: { authorization: 'Bearer t0k', 'content-type': 'application/json' } });
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as { result: { tools: unknown[] } }).result.tools).toHaveLength(5);
    const note = await fetch(`${url}/mcp`, { method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }), headers: { authorization: 'Bearer t0k' } });
    expect(note.status).toBe(202);
    expect((await fetch(`${url}/health`)).status).toBe(200);
  });
});

describe('세션의 새 대화·기억 명령', () => {
  let Session: typeof SessionType;
  beforeAll(async () => {
    vi.stubGlobal('__DOGENT_SKILLS__', {});
    vi.stubGlobal('__DOGENT_BUILD__', { mode: 'home', version: 'test' });
    ({ Session } = await import('../client/src/session'));
  });

  it('"기억해: …"는 지침에 더하고, "새 대화"는 앞선 대화를 지운다', async () => {
    const home = tmp('dogent-sess-');
    const cfg: ClientConfig = { home, llm: { baseUrl: 'http://127.0.0.1:9/v1', model: 'm' } as ClientConfig['llm'], personalSkills: join(home, 'skills'), outputDir: join(home, 'out'), saveThroughExcel: false, file: join(home, 'config.json') };
    const lines: string[] = [];
    const s = new Session({ print: (t) => lines.push(t), ask: async () => null, confirm: async () => false, askDefault: async (_q, f) => f }, cfg, { yes: true, allowWrite: false, dryRun: false, waitSec: 1 });
    await s.handle('기억해: 라인은 늘 7라인부터 본다');
    expect(readFileSync(join(home, 'DOGENT.md'), 'utf8')).toMatch(/- 라인은 늘 7라인부터 본다/);
    s.conversation.add({ request: 'a', skill: '자유 요청', status: 'done', summary: '', files: [], datasets: [] });
    const ctx = (s as unknown as { context(): string }).context();
    expect(ctx).not.toMatch(/# 내 지침 \(Dogent/);
    expect(ctx).toMatch(/## 지침[\s\S]*7라인부터[\s\S]*## 앞선 대화[^\n]*\n1\. 요청: a/);
    await s.handle('새 대화');
    expect(s.conversation.empty).toBe(true);
    // 앱처럼 recent면 저장한 대화를 이어 간다
    s.conversation.add({ request: 'b', skill: '자유 요청', status: 'done', summary: '', files: [], datasets: [] });
    const next = new Session({ print: () => {}, ask: async () => null, confirm: async () => false, askDefault: async (_q, f) => f }, cfg, { yes: true, allowWrite: false, dryRun: false, waitSec: 1, conversation: 'recent' });
    expect(next.conversation.turns.map((t) => t.request)).toEqual(['b']);
    expect(new Session({ print: () => {}, ask: async () => null, confirm: async () => false, askDefault: async (_q, f) => f }, cfg, { yes: true, allowWrite: false, dryRun: false, waitSec: 1 }).conversation.empty).toBe(true);
    await s.close();
  });
});

