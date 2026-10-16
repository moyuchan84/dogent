import { beforeEach, describe, expect, it } from 'vitest';
import { BrowserTools, McpBrowser, resolveInputs, runSkill, type ApprovalRequest, type McpCall, type ToolHost } from '../src/core';
import { JsdomBrowser, fwLog, fwSkill, memoryFiles, mockLlm, readWorkbook, wipSkill } from './helpers';

/**
 * 클라이언트 + 확장 구성을 브라우저 없이 확인한다.
 * 스킬 실행 루프 → McpBrowser → (MCP 도구 호출) → BrowserTools → JsdomBrowser
 */
function wire(browser: JsdomBrowser, decide = true) {
  const asked: ApprovalRequest[] = [];
  const host: ToolHost = {
    tabs: async () => [{ id: 3, url: browser.document.location.href, title: browser.document.title }],
    open: async (url) => {
      await browser.navigate(url);
      return 3;
    },
    focus: async () => {},
    port: () => browser,
    sites: async () => ['http://localhost:4173/*'],
    approve: async (request) => {
      asked.push(request);
      return decide;
    },
    activeTab: async () => 3,
  };
  const tools = new BrowserTools(host);
  const calls: string[] = [];
  const call: McpCall = async (name, args) => {
    calls.push(`${name}:${String(args.method ?? '')}`);
    try {
      return { text: await tools.call(name, args), isError: false };
    } catch (e) {
      return { text: (e as Error).message, isError: true };
    }
  };
  const mcp = new McpBrowser(call);
  // 클라이언트의 승인은 확장의 승인 창으로 묻는다.
  const ui = { ask: async () => '', approve: (r: ApprovalRequest) => mcp.approve(r) };
  return { mcp, ui, asked, calls };
}

const fwInputs = () => {
  const { values, errors } = resolveInputs(fwSkill(), {
    src_ip: '10.10.1.15',
    dst_ip: '10.20.3.7',
    port: '1521',
    period_days: '90',
    reason: '개발 서버에서 운영 DB 조회 배치를 실행하기 위함',
  });
  expect(errors).toEqual([]);
  return values;
};

beforeEach(() => {
  fwLog.length = 0;
});

describe('McpBrowser: 클라이언트가 확장의 브라우저 도구로 스킬을 실행', () => {
  it('재공 확인 스킬: 여러 페이지를 읽어 사이드 패널과 같은 엑셀을 만든다', async () => {
    const { mcp, ui, calls } = wire(await JsdomBrowser.open('/wip.html'));
    const files = memoryFiles();
    const r = await runSkill(wipSkill(), { line: '7라인', hold_hours: 24 }, { llm: mockLlm, browser: mcp, ui, files });
    expect(r.status, r.message).toBe('done');
    expect(r.files).toEqual(['재공확인_7라인.xlsx']);
    const book = await readWorkbook(files.saved.get('재공확인_7라인.xlsx')!);
    expect(book['원본']).toHaveLength(129);
    // 모든 조작이 MCP 도구 호출로 갔다.
    expect(calls.every((c) => c.startsWith('dogent_port:'))).toBe(true);
    expect(calls).toContain('dogent_port:extractTable');
  });

  it('저장·상신은 확장의 승인 창으로 한 번만 묻고 한 번만 상신한다', async () => {
    const { mcp, ui, asked } = wire(new JsdomBrowser());
    const r = await runSkill(fwSkill(), fwInputs(), { llm: mockLlm, browser: mcp, ui, files: memoryFiles() });
    expect(r.status, r.message).toBe('done');
    expect(asked).toHaveLength(1);
    // 루프가 화면에서 다시 읽은 값이 승인 창에 그대로 간다.
    expect(asked[0].skill).toBe('IP 방화벽 해제 신청');
    expect(asked[0].fields.find((f) => f.name.includes('출발지'))?.value).toBe('10.10.1.15');
    expect(fwLog).toHaveLength(1);
  });

  it('승인 창에서 취소하면 상신하지 않고 끝낸다', async () => {
    const { mcp, ui, asked } = wire(new JsdomBrowser(), false);
    const r = await runSkill(fwSkill(), fwInputs(), { llm: mockLlm, browser: mcp, ui, files: memoryFiles() });
    expect(r.status).toBe('aborted');
    expect(r.message).toContain('승인하지 않았습니다');
    expect(asked).toHaveLength(1);
    expect(fwLog).toEqual([]);
  });

  it('승인받지 않은 저장·상신 버튼은 클라이언트가 바로 눌러도 확장이 승인 창을 띄운다', async () => {
    const browser = await JsdomBrowser.open('/fw.html');
    const { mcp, asked } = wire(browser, false);
    const snap = await mcp.snapshot();
    const submit = snap.items.find((i) => i.kind === 'el' && i.role === 'button' && /상신|신청/.test(i.name));
    expect(submit).toBeDefined();
    const r = await mcp.click(submit!.kind === 'el' ? submit!.ref : -1, { accept: true });
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/승인하지 않았습니다/);
    expect(asked).toHaveLength(1);
    expect(fwLog).toEqual([]);
  });

  it('조작할 사이트 밖으로는 이동하지 않는다', async () => {
    const { mcp } = wire(await JsdomBrowser.open('/wip.html'));
    await expect(mcp.navigate('http://127.0.0.1:4173/wip.html')).rejects.toThrow(/조작할 사이트 목록에 없습니다/);
    expect(await mcp.target()).toMatchObject({ id: 3, url: 'http://localhost:4173/wip.html', allowed: true });
  });

  it('조작할 사이트 밖의 탭은 읽지도 조작하지도 않는다', async () => {
    // 처음 탭(https://start.example/)은 목록 밖이다. 목록 안으로 이동은 할 수 있다.
    const { mcp } = wire(new JsdomBrowser());
    expect(await mcp.target()).toMatchObject({ allowed: false });
    // 화면 글과 요소는 주지 않는다.
    expect(await mcp.snapshot()).toMatchObject({ url: 'https://start.example/', items: [] });
    await expect(mcp.readText()).rejects.toThrow(/조작할 사이트 목록에 없습니다/);
    await expect(mcp.type(1, 'x')).rejects.toThrow(/조작할 사이트 목록에 없습니다/);
    expect((await mcp.navigate('http://localhost:4173/wip.html')).ok).toBe(true);
    expect((await mcp.snapshot()).url).toBe('http://localhost:4173/wip.html');
  });
});
