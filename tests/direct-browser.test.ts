import { mkdtempSync, readdirSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pageAgentSource } from '../client/build-env.mjs';
import { closeDirectBrowser, openDirect } from '../client/src/direct';
import { findBrowser } from '../client/src/direct/cdp';
import { createMockSite } from '../mock-site/server.mjs';
import { readDownloadedTable, type ApprovalRequest, type PageSnapshot } from '../src/core';

/**
 * 브라우저 연결 방식 "직접 제어"를 실제 크롬(headless)으로 끝까지 돌려 본다. 확장은 쓰지 않는다.
 *   pnpm e2e:direct     (vitest --mode direct. 크롬·엣지가 없으면 건너뛴다)
 */
const run = (import.meta.env.MODE === 'direct' || process.env.DOGENT_E2E_DIRECT === '1') && findBrowser() !== null;

describe.skipIf(!run)('직접 제어 (확장 없이 CDP)', () => {
  let site: ReturnType<typeof createMockSite>;
  let base = '';
  const asked: ApprovalRequest[] = [];
  let decide = true;
  const downloads = mkdtempSync(join(tmpdir(), 'dogent-direct-dl-'));
  let bridge: ReturnType<typeof openDirect>;

  const refOf = (snap: PageSnapshot, name: RegExp) => {
    const el = snap.items.find((i) => i.kind === 'el' && name.test(i.name));
    if (!el || el.kind !== 'el') throw new Error(`화면에 ${name} 없음: ${snap.title} ${snap.items.map((i) => (i.kind === 'el' ? i.name : '')).join('|')}`);
    return el.ref;
  };
  const open = async (path: string) => {
    const r = await bridge.call('tab_open', { url: `${base}${path}` });
    expect(r.isError, r.text).toBe(false);
  };

  beforeAll(async () => {
    site = createMockSite().listen(0);
    await new Promise((r) => site.once('listening', r));
    base = `http://localhost:${(site.address() as AddressInfo).port}`;
    bridge = openDirect({
      home: mkdtempSync(join(tmpdir(), 'dogent-direct-')),
      downloadsDir: downloads,
      headless: true,
      agentSource: await pageAgentSource(),
      approve: async (r) => {
        asked.push(r);
        return decide;
      },
    });
    expect(await bridge.waitForExtension(0), bridge.error()).toBe(true);
  });

  afterAll(() => {
    closeDirectBrowser();
    site?.close();
  });

  it('조회하고 여러 페이지 표를 읽는다', async () => {
    await open('/wip.html');
    const b = bridge.browser;
    let snap = await b.snapshot();
    await b.select(refOf(snap, /^라인$/), '7라인');
    await b.click(refOf(snap, /^조회$/));
    snap = await b.snapshot();
    const out = JSON.parse((await bridge.call('extract_table', { ref: refOf(snap, /재공 목록/), next_ref: refOf(snap, /^다음$/), max_rows: 2 })).text);
    expect(out).toMatchObject({ total_rows: 128, pages: 3 });
    expect(bridge.browsers()[0]).toMatchObject({ via: '직접 제어', selected: true });
  });

  it('iframe 안의 업무 화면도 읽는다', async () => {
    await open('/portal.html');
    const snap = await bridge.browser.snapshot();
    expect(snap.items.some((i) => i.kind === 'el' && i.name === '조회')).toBe(true);
  });

  it('메뉴의 새 탭(noopener) → 확인 창 + POST 엑셀을 받아 읽고 내려받기 폴더에 남긴다', async () => {
    await open('/menu.html');
    const b = bridge.browser;
    const menu = await b.snapshot();
    const r = await b.click(refOf(menu, /새 탭/));
    expect(r.message).toMatch(/새 창이 열려 그 창으로 옮겼습니다/);
    const page = await b.snapshot();
    expect(page.title).toBe('재공 내보내기');
    expect((await b.tabs!()).find((t) => t.current)?.url).toMatch(/export\.html/);
    const file = await b.download!(refOf(page, /엑셀 내려받기/), 15_000, () => true);
    expect(file.filename).toBe('내보내기_7라인.xlsx');
    const table = await readDownloadedTable(file.data);
    expect(table.rows.length).toBeGreaterThan(0);
    expect(readdirSync(downloads)).toContain('내보내기_7라인.xlsx');
  });

  it('같은 창에서 늦게 이동하는 메뉴', async () => {
    await open('/menu.html?same');
    const b = bridge.browser;
    await b.click(refOf(await b.snapshot(), /같은 창/));
    expect((await b.snapshot()).title).toBe('재공 내보내기');
  });

  it('누른 뒤 늦게 뜨는 팝업은 다음 화면 읽기에서 옮긴 사실을 알린다', async () => {
    await open('/menu.html?popup');
    const b = bridge.browser;
    const r = await b.click(refOf(await b.snapshot(), /팝업/));
    expect(r.message).not.toMatch(/새 창/);
    await new Promise((res) => setTimeout(res, 2500));
    const snap = await b.snapshot();
    expect(snap.moved).toMatch(/새 창이 열려/);
    expect(snap.title).toBe('재공 내보내기');
  });

  it('상신은 앱의 승인을 받아야 누른다', async () => {
    await fetch(`${base}/api/fw`, { method: 'DELETE' });
    await open('/fw.html');
    const b = bridge.browser;
    const snap = await b.snapshot();
    decide = false;
    asked.length = 0;
    const r = await bridge.call('click', { ref: refOf(snap, /^상신$/) });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/승인하지 않았습니다/);
    expect(asked).toHaveLength(1);
    expect(await (await fetch(`${base}/api/fw`)).json()).toEqual([]);
    decide = true;
  });

  it('목록 방식 빌드의 사이트 목록을 지킨다 (같은 브라우저를 이어 써도 바뀐 목록을 따른다)', async () => {
    const listed = openDirect({
      home: mkdtempSync(join(tmpdir(), 'dogent-direct-')),
      downloadsDir: downloads,
      headless: true,
      agentSource: await pageAgentSource(),
      sites: [`${base}/*`],
      approve: async () => true,
    });
    try {
      expect((await listed.call('tab_open', { url: `${base}/wip.html` })).isError).toBe(false);
      // localhost와 127.0.0.1은 다른 사이트다
      const other = await listed.call('tab_open', { url: base.replace('localhost', '127.0.0.1') + '/wip.html' });
      expect(other.isError).toBe(true);
      expect(other.text).toMatch(/조작할 사이트 목록에 없습니다/);
    } finally {
      listed.close();
      // 다음 시험이 모든 사이트로 돌도록 원래 연결로 되돌린다
      await bridge.waitForExtension(0);
    }
  });
});
