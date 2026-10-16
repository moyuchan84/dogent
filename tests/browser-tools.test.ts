import { beforeEach, describe, expect, it } from 'vitest';
import { TOOLS } from '../bridge/tools.mjs';
import { BrowserTools, type ApprovalRequest, type ToolHost } from '../src/core';
import { JsdomBrowser, fwLog } from './helpers';

const SITE = 'http://localhost:4173';

/** 탭 하나짜리 브라우저를 흉내 낸 확장 쪽 기능 */
function hostFor(browser: JsdomBrowser, decide = false) {
  const asked: ApprovalRequest[] = [];
  const host: ToolHost = {
    tabs: async () => [{ id: 7, url: browser.document.location.href, title: browser.document.title }],
    open: async (url) => {
      await browser.navigate(url);
      return 7;
    },
    focus: async () => {},
    port: () => browser,
    sites: async () => ['http://localhost:4173/*'],
    approve: async (request) => {
      asked.push(request);
      return decide;
    },
    activeTab: async () => 7,
  };
  return { host, asked };
}

const refOf = (snap: string, pattern: RegExp) => {
  const m = snap.split('\n').find((l) => pattern.test(l))?.match(/^\[(\d+)\]/);
  if (!m) throw new Error(`화면에 ${pattern} 없음:\n${snap}`);
  return Number(m[1]);
};

describe('브라우저 도구 (MCP)', () => {
  beforeEach(() => {
    fwLog.length = 0;
  });

  it('도구 목록의 이름이 모두 실행부에 있다', async () => {
    const tools = new BrowserTools(hostFor(new JsdomBrowser()).host);
    for (const t of TOOLS) {
      const r = await tools.call(t.name, {}).catch((e: Error) => e.message);
      expect(r, t.name).not.toMatch(/모르는 도구/);
    }
  });

  it('화면을 읽고 조건을 넣어 조회한 뒤 모든 페이지의 표를 읽는다', async () => {
    const tools = new BrowserTools(hostFor(await JsdomBrowser.open('/wip.html')).host);
    expect(await tools.call('tabs_list')).toMatch(/\[7\] \(대상\) .* · 조작 가능/);
    let snap = await tools.call('snapshot');
    expect(snap).toMatch(/^\[tab 7\] \[page\]/);
    await tools.call('select', { ref: refOf(snap, /combobox "라인"/), value: '7라인' });
    await tools.call('click', { ref: refOf(snap, /button "조회"/) });
    snap = await tools.call('snapshot');
    const out = JSON.parse(await tools.call('extract_table', { ref: refOf(snap, /table "재공 목록"/), next_ref: refOf(snap, /button "다음"/), max_rows: 3 }));
    expect(out).toMatchObject({ columns: ['Lot ID', '제품', '공정', '수량', '상태', '정체시간'], total_rows: 128, pages: 3 });
    expect(out.rows).toHaveLength(3);
  });

  it('조작할 사이트 밖으로는 이동하지 않는다', async () => {
    const tools = new BrowserTools(hostFor(new JsdomBrowser()).host);
    await expect(tools.call('navigate', { url: 'https://example.com/' })).rejects.toThrow(/조작할 사이트 목록에 없습니다/);
    await expect(tools.call('tab_open', { url: 'http://127.0.0.1:4173/wip.html' })).rejects.toThrow(/목록에 없습니다/);
  });

  it('상신 버튼은 승인을 받아야 누르고, 거절하면 누르지 않는다', async () => {
    const browser = await JsdomBrowser.open('/fw.html');
    const declined = hostFor(browser, false);
    const tools = new BrowserTools(declined.host);
    let snap = await tools.call('snapshot');
    for (const [label, value] of [['출발지 IP', '10.10.1.15'], ['목적지 IP', '10.20.3.7'], ['포트', '1521'], ['기간(일)', '30'], ['사유', '개발 서버 연동 확인을 위한 신청']]) {
      await tools.call('type', { ref: refOf(snap, new RegExp(`textbox "${label.replace(/[()]/g, '\\$&')}"`)), text: value });
    }
    snap = await tools.call('snapshot');
    const submit = refOf(snap, /button "상신"/);
    await expect(tools.call('click', { ref: submit })).rejects.toThrow(/승인하지 않았습니다/);
    expect(declined.asked[0]).toMatchObject({ button: '상신', skill: '외부 클라이언트의 요청' });
    expect(declined.asked[0].fields).toContainEqual({ name: '출발지 IP', value: '10.10.1.15' });
    expect(fwLog).toHaveLength(0);

    const approved = new BrowserTools(hostFor(browser, true).host);
    snap = await approved.call('snapshot');
    await approved.call('click', { ref: refOf(snap, /button "상신"/) });
    expect(fwLog).toHaveLength(1);
    expect(await approved.call('snapshot')).toMatch(/FW-000001/);
  });

  it('클릭 전에 화면을 읽지 않았거나 없는 번호면 이유를 알린다', async () => {
    const tools = new BrowserTools(hostFor(new JsdomBrowser()).host);
    await expect(tools.call('click', { ref: 1 })).rejects.toThrow(/먼저 snapshot/);
    await tools.call('snapshot');
    await expect(tools.call('click', { ref: 999 })).rejects.toThrow(/마지막 화면에 없습니다/);
  });

  it('로그인 화면은 알리고, 사람이 로그인하면 wait_for_login이 끝난다', async () => {
    const browser = await JsdomBrowser.open('/login.html');
    const tools = new BrowserTools(hostFor(browser).host);
    const snap = await tools.call('snapshot');
    expect(snap).toMatch(/^\[login_required\]/);
    // 비밀번호 칸은 화면 읽기에 나오지 않는다.
    expect(snap).not.toMatch(/textbox "비밀번호"/);
    expect(snap).toMatch(/textbox "사번"/);
    setTimeout(() => void browser.navigate(`${SITE}/wip.html`), 300);
    expect(await tools.call('wait_for_login', { timeout_sec: 10 })).toMatch(/로그인이 끝났습니다/);
    await expect(
      new BrowserTools(hostFor(await JsdomBrowser.open('/login.html')).host).call('wait_for_login', { timeout_sec: 1 }),
    ).rejects.toThrow(/로그인하지 않았습니다/);
  });
});
