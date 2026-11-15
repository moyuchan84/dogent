import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readDownloadedFile, DOWNLOAD_MAX_BYTES } from '../client/src/download';
import { BrowserTools, McpBrowser, renderSnapshot, type BrowserPort, type McpCall, type PageSnapshot, type ToolHost } from '../src/core';

const SITE = 'http://localhost:4173';

/** 누르면 새 창(9번 탭)을 따라가는 탭 담당을 흉내 낸다 (확장의 ChromeBrowser처럼). */
function followingPort() {
  let tab = 3;
  const page = (id: number): PageSnapshot => ({
    url: `${SITE}/${id === 3 ? 'menu' : 'export'}.html`,
    title: id === 3 ? '업무 메뉴' : '재공 내보내기',
    hasPassword: false,
    items: [{ kind: 'el', ref: 1, role: 'link', name: id === 3 ? '재공 내보내기 (새 탭)' : '엑셀 내려받기' }],
  });
  const port: BrowserPort = {
    currentTab: () => tab,
    snapshot: async () => page(tab),
    navigate: async () => ({ ok: true, message: '' }),
    click: async () => {
      tab = 9;
      return { ok: true, message: '클릭함. 새 창이 열려 그 창으로 옮겼습니다' };
    },
    type: async () => ({ ok: true, message: '' }),
    select: async () => ({ ok: true, message: '' }),
    waitFor: async () => true,
    extractTable: async () => ({ columns: [], rows: [] }),
    fillTable: async () => ({ ok: true, message: '' }),
  };
  const host: ToolHost = {
    tabs: async () => [
      { id: 3, url: `${SITE}/menu.html`, title: '업무 메뉴' },
      { id: 9, url: `${SITE}/export.html`, title: '재공 내보내기' },
    ],
    open: async () => 3,
    focus: async () => {},
    port: () => port,
    sites: async () => [`${SITE}/*`],
    approve: async () => true,
    activeTab: async () => 3,
  };
  return new BrowserTools(host);
}

describe('새 창을 따라간 뒤의 대상 탭', () => {
  it('탭 담당이 새 창으로 옮겨 가면 대상 표시와 사이트 검사도 새 창을 따른다', async () => {
    const tools = followingPort();
    await tools.call('snapshot');
    expect(await tools.call('tabs_list')).toMatch(/\[3\] \(대상\)/);
    await tools.call('click', { ref: 1 });
    const list = await tools.call('tabs_list');
    expect(list).toMatch(/\[9\] \(대상\) 재공 내보내기/);
    expect(list).not.toMatch(/\[3\] \(대상\)/);
    expect(await tools.call('snapshot')).toMatch(/^\[tab 9\] .*재공 내보내기/);
  });

  it('dogent_port의 target도 옮겨 간 탭을 돌려준다', async () => {
    const tools = followingPort();
    await tools.call('dogent_port', { method: 'snapshot', args: [] });
    await tools.call('dogent_port', { method: 'click', args: [1, null] });
    expect(JSON.parse(await tools.call('dogent_port', { method: 'target', args: [] }))).toMatchObject({ id: 9, allowed: true });
  });

  it('화면 읽기 결과에 창을 옮긴 사실을 먼저 적는다', () => {
    const text = renderSnapshot({ url: `${SITE}/export.html`, title: '재공 내보내기', hasPassword: false, items: [], moved: '새 창이 열려 그 창으로 옮겼습니다' });
    expect(text.split('\n')[0]).toBe('(새 창이 열려 그 창으로 옮겼습니다. 아래는 지금 대상 창의 화면입니다)');
  });
});

describe('내려받은 파일 읽기 (앱·터미널)', () => {
  const allowAll = () => true;

  it('파일을 읽을 수 있으면 확장에 경로를 달라고 하고 저장된 파일을 읽는다', async () => {
    const seen: unknown[][] = [];
    const call: McpCall = async (_name, args) => {
      seen.push(args.args as unknown[]);
      return { text: JSON.stringify({ filename: '내보내기.xlsx', url: `${SITE}/api/export.xlsx`, path: 'C:\\Users\\me\\Downloads\\내보내기.xlsx' }), isError: false };
    };
    const read: string[] = [];
    const mcp = new McpBrowser(call, undefined, async (path) => {
      read.push(path);
      return new Uint8Array([0x50, 0x4b, 3, 4]);
    });
    const file = await mcp.download(5, 10_000, allowAll);
    expect(seen[0]).toEqual([5, 10_000, { localPath: true }]);
    expect(read).toEqual(['C:\\Users\\me\\Downloads\\내보내기.xlsx']);
    expect(new Uint8Array(file.data)).toEqual(new Uint8Array([0x50, 0x4b, 3, 4]));
    expect(file.filename).toBe('내보내기.xlsx');
  });

  it('예전 확장처럼 내용(base64)을 보내 오면 그것을 쓴다', async () => {
    const call: McpCall = async () => ({ text: JSON.stringify({ filename: 'a.csv', url: `${SITE}/a.csv`, base64: btoa('a,b\n1,2') }), isError: false });
    const mcp = new McpBrowser(call, undefined, async () => {
      throw new Error('읽으면 안 됨');
    });
    const file = await mcp.download(1, 1000, allowAll);
    expect(new TextDecoder().decode(file.data)).toBe('a,b\n1,2');
  });

  it('파일을 읽을 수 없는 클라이언트는 경로를 달라고 하지 않는다', async () => {
    const seen: unknown[][] = [];
    const call: McpCall = async (_n, args) => {
      seen.push(args.args as unknown[]);
      return { text: JSON.stringify({ filename: 'a.csv', url: `${SITE}/a.csv`, base64: btoa('x') }), isError: false };
    };
    await new McpBrowser(call).download(1, 1000, allowAll);
    expect(seen[0]).toEqual([1, 1000, null]);
  });

  const fakeFs = (size: number, file = true) => ({
    realpath: async (p: string) => p,
    stat: async () => ({ isFile: () => file, size }),
    readFile: async () => new Uint8Array([1, 2, 3]),
  });

  it('절대 경로의 일반 파일만, 크기 상한 안에서 읽는다', async () => {
    await expect(readDownloadedFile('Downloads/a.xlsx', fakeFs(3))).rejects.toThrow(/경로가 올바르지/);
    const abs = join(tmpdir(), 'a.xlsx');
    await expect(readDownloadedFile(abs, fakeFs(3, false))).rejects.toThrow(/파일이 아닙니다/);
    await expect(readDownloadedFile(abs, fakeFs(DOWNLOAD_MAX_BYTES + 1))).rejects.toThrow(/너무 큽니다/);
    expect(await readDownloadedFile(abs, fakeFs(3))).toEqual(new Uint8Array([1, 2, 3]));
  });
});
