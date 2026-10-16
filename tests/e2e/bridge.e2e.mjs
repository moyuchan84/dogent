// 브리지(MCP) ↔ 확장 ↔ 모의 사이트를 실제 Chromium으로 끝까지 돌려 본다.
//
//   pnpm build && pnpm e2e:bridge             WebSocket 연결
//   pnpm build && pnpm e2e:bridge --native    Native Messaging도 (레지스트리 HKCU\Software\Chromium에 잠시 등록했다가 지움)
//
// MCP 클라이언트 자리에는 이 스크립트가 서서 브리지의 handleMcp를 직접 부른다.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { createHub } from '../../bridge/hub.mjs';
import { pipePath } from '../../bridge/protocol.mjs';
import { createMockSite } from '../../mock-site/server.mjs';

const ROOT = join(import.meta.dirname, '../..');
const EXT = join(ROOT, '.output/chrome-mv3');
const SITE = 'http://localhost:4173';
const TOKEN = 'e2e-token-0123456789';
const PORT = 39311;
const NATIVE = process.argv.includes('--native');
const HEADED = !!process.env.HEADED;

const site = createMockSite().listen(4173);
const logs = [];
const hub = createHub({ token: TOKEN, port: PORT, pipe: pipePath(userInfo().username), log: (l) => logs.push(l) });
await hub.ready;

const context = await chromium.launchPersistentContext(await mkdtemp(join(tmpdir(), 'dogent-bridge-')), {
  channel: 'chromium',
  headless: !HEADED,
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
});
const tally = { pass: 0, fail: 0 };
let rpc = 1;

/** MCP tools/call. 오류면 isError와 함께 글을 돌려준다. */
async function call(name, args = {}) {
  const res = await hub.handleMcp({ jsonrpc: '2.0', id: rpc++, method: 'tools/call', params: { name, arguments: args } });
  return { text: res.result.content[0].text, error: !!res.result.isError };
}
const ok = async (name, args) => {
  const r = await call(name, args);
  assert.equal(r.error, false, `${name} 실패: ${r.text}`);
  return r.text;
};
const refOf = (snap, pattern) => {
  const m = snap.split('\n').find((l) => pattern.test(l))?.match(/^\[(\d+)\]/);
  assert.ok(m, `화면에 ${pattern} 없음:\n${snap}`);
  return Number(m[1]);
};
async function until(fn, ms = 15_000, what = '조건') {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`${ms / 1000}초 안에 ${what}이(가) 되지 않음. 브리지 기록: ${logs.slice(-5).join(' / ')}`);
}

async function scenario(name, fn) {
  try {
    await fn();
    tally.pass++;
    console.log(`통과  ${name}`);
  } catch (e) {
    tally.fail++;
    console.log(`실패  ${name}\n${e.message}`);
  }
}

try {
  const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
  const extId = new URL(worker.url()).host;
  const panel = await context.newPage();
  await panel.goto(`chrome-extension://${extId}/sidepanel.html`);
  const setBridge = (s) => panel.evaluate((v) => chrome.storage.local.set({ bridgeSettings: v }), s);
  const status = () => panel.evaluate(async () => (await chrome.storage.local.get('bridgeStatus')).bridgeStatus);

  await scenario('MCP 도구 목록', async () => {
    const res = await hub.handleMcp({ jsonrpc: '2.0', id: rpc++, method: 'tools/list' });
    const names = res.result.tools.map((t) => t.name);
    for (const n of ['snapshot', 'click', 'extract_table', 'wait_for_login', 'read_text']) assert.ok(names.includes(n), n);
  });

  await scenario('확장이 연결되지 않았으면 무엇을 해야 하는지 알려 줌', async () => {
    const r = await call('tabs_list');
    assert.equal(r.error, true);
    assert.match(r.text, /클라이언트 연결을 켜고 토큰을 넣으세요/);
  });

  await scenario('토큰이 다르면 연결하지 않음', async () => {
    await setBridge({ mode: 'ws', port: PORT, token: 'wrong-token' });
    await until(async () => (await status())?.state === 'error', 15_000, '연결 거부');
    assert.equal(hub.connected(), null);
    assert.match((await status()).detail, /토큰/);
  });

  await scenario('WebSocket으로 연결하고 조회 → 여러 페이지 표 읽기', async () => {
    await setBridge({ mode: 'ws', port: PORT, token: TOKEN });
    await until(() => hub.connected() === 'WebSocket', 15_000, 'WebSocket 연결');
    await until(async () => (await status())?.state === 'connected', 5_000, '상태 표시');
    await ok('tab_open', { url: `${SITE}/wip.html` });
    let snap = await ok('snapshot');
    await ok('select', { ref: refOf(snap, /combobox "라인"/), value: '7라인' });
    await ok('click', { ref: refOf(snap, /button "조회"/) });
    snap = await ok('snapshot');
    const table = JSON.parse(await ok('extract_table', { ref: refOf(snap, /table "재공 목록"/), next_ref: refOf(snap, /button "다음"/), max_rows: 2 }));
    assert.equal(table.total_rows, 128);
    assert.equal(table.pages, 3);
    assert.match(await ok('read_text'), /재공 현황 조회/);
    assert.match(await ok('inspect'), /# Dogent 화면 점검/);
    assert.match(await ok('tabs_list'), /\(대상\) .*wip\.html · 조작 가능/);
  });

  await scenario('조작할 사이트 밖으로는 가지 않음', async () => {
    const r = await call('navigate', { url: 'http://127.0.0.1:4173/wip.html' });
    assert.equal(r.error, true);
    assert.match(r.text, /조작할 사이트 목록에 없습니다/);
  });

  const fillFirewall = async () => {
    await fetch(`${SITE}/api/fw`, { method: 'DELETE' });
    await ok('tab_open', { url: `${SITE}/fw.html` });
    const snap = await ok('snapshot');
    for (const [label, value] of [['출발지 IP', '10.10.1.15'], ['목적지 IP', '10.20.3.7'], ['포트', '1521'], ['기간\\(일\\)', '30'], ['사유', '외부 클라이언트 연동 확인']]) {
      await ok('type', { ref: refOf(snap, new RegExp(`textbox "${label}"`)), text: value });
    }
    return ok('snapshot');
  };

  await scenario('상신은 승인 창에서 승인해야 누름', async () => {
    const snap = await fillFirewall();
    const opened = context.waitForEvent('page', { predicate: (p) => p.url().includes('approve.html') });
    const pending = call('click', { ref: refOf(snap, /button "상신"/) });
    const popup = await opened;
    await popup.locator('#approval').waitFor();
    const text = await popup.locator('#approval').innerText();
    assert.match(text, /"상신" 전에 확인해 주세요/);
    assert.match(text, /10\.10\.1\.15/);
    // 승인 전에는 상신되지 않았다.
    assert.deepEqual(await (await fetch(`${SITE}/api/fw`)).json(), []);
    if (process.env.SHOT) await popup.screenshot({ path: join(ROOT, 'test-results/bridge-approval.png') });
    await popup.click('#approve');
    const r = await pending;
    assert.equal(r.error, false, r.text);
    assert.equal((await (await fetch(`${SITE}/api/fw`)).json()).length, 1);
    assert.match(await ok('snapshot'), /FW-000001/);
  });

  await scenario('승인 창을 닫으면 누르지 않음', async () => {
    const snap = await fillFirewall();
    const pending = call('click', { ref: refOf(snap, /button "상신"/) });
    const popup = await context.waitForEvent('page', { predicate: (p) => p.url().includes('approve.html') });
    await popup.locator('#approval').waitFor();
    await popup.close();
    const r = await pending;
    assert.equal(r.error, true);
    assert.match(r.text, /승인하지 않았습니다/);
    assert.deepEqual(await (await fetch(`${SITE}/api/fw`)).json(), []);
  });

  await scenario('로그인 화면은 알리고, 사람이 로그인하면 이어 감', async () => {
    await ok('tab_open', { url: `${SITE}/login.html` });
    assert.match(await ok('snapshot'), /^\[login_required\]/);
    const waiting = call('wait_for_login', { timeout_sec: 30 });
    const page = context.pages().find((p) => p.url().includes('login.html'));
    await page.fill('#user', 'hong');
    await page.fill('#pw', 'secret');
    await page.click('button');
    const r = await waiting;
    assert.equal(r.error, false, r.text);
    assert.match(r.text, /로그인이 끝났습니다/);
  });

  if (NATIVE) {
    await scenario('Native Messaging으로 연결', async () => {
      execFileSync(process.execPath, [join(ROOT, 'bridge/install.mjs'), '--browser', 'chromium', '--id', extId], {
        env: { ...process.env, DOGENT_BRIDGE_TOKEN: TOKEN },
        stdio: 'ignore',
      });
      try {
        await setBridge({ mode: 'native', port: PORT, token: TOKEN });
        await until(() => hub.connected() === 'Native Messaging', 20_000, 'Native Messaging 연결');
        await ok('tab_open', { url: `${SITE}/wip.html` });
        assert.match(await ok('snapshot'), /재공 현황 조회/);
      } finally {
        execFileSync(process.execPath, [join(ROOT, 'bridge/install.mjs'), '--browser', 'chromium', '--remove'], { stdio: 'ignore' });
      }
    });
  }

  await scenario('연결을 끄면 끊음', async () => {
    await setBridge({ mode: 'off', port: PORT, token: TOKEN });
    await until(() => hub.connected() === null, 10_000, '연결 끊기');
  });
} finally {
  await context.close();
  hub.close();
  site.close();
}
console.log(`\n결과: 통과 ${tally.pass}, 실패 ${tally.fail}`);
process.exit(tally.fail ? 1 : 0);
