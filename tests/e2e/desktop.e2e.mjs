// Dogent 데스크탑 앱(Electron) + 확장 + 모의 사이트를 끝까지 돌려 본다.
//
//   pnpm build && pnpm desktop:build && pnpm e2e:desktop
//
// 앱은 Playwright의 Electron 드라이버로 띄우고, 확장은 따로 띄운 Chromium에 올린다.
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { _electron as electron, chromium } from 'playwright';
import { generateWip } from '../../mock-site/data.mjs';
import { createMockSite } from '../../mock-site/server.mjs';
import { createMockLlm } from '../../tools/mock-llm.mjs';

const ROOT = join(import.meta.dirname, '../..');
const EXT = join(ROOT, '.output/chrome-mv3');
const MAIN = join(ROOT, 'desktop/dist/main.mjs');
const SITE = 'http://localhost:4173';
const TOKEN = 'desktop-e2e-token-0123456789';
const PORT = 39315;
const HEADED = !!process.env.HEADED;
const RUN_TIMEOUT = 60_000;

for (const [path, how] of [[EXT, 'pnpm build'], [MAIN, 'pnpm desktop:build']]) {
  if (!existsSync(path)) throw new Error(`${path}가 없습니다. 먼저 ${how}`);
}

const site = createMockSite().listen(4173);
const llm = createMockLlm().listen(4174);
const home = mkdtempSync(join(tmpdir(), 'dogent-desktop-'));
const tally = { pass: 0, fail: 0 };

const browserCtx = await chromium.launchPersistentContext(await mkdtemp(join(tmpdir(), 'dogent-desktop-ext-')), {
  channel: 'chromium',
  headless: !HEADED,
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
});
const app = await electron.launch({
  args: [MAIN],
  env: {
    ...process.env,
    DOGENT_HOME: home,
    DOGENT_BRIDGE_TOKEN: TOKEN,
    DOGENT_BRIDGE_PORT: String(PORT),
    DOGENT_BRIDGE_PIPE: `\\\\.\\pipe\\dogent-desktop-e2e-${process.pid}`,
  },
});

async function scenario(name, fn) {
  try {
    const note = await fn();
    tally.pass++;
    console.log(`통과  ${name}${note ? `  (${note})` : ''}`);
  } catch (e) {
    tally.fail++;
    console.log(`실패  ${name}\n${e.stack ?? e.message}`);
  }
}

try {
  const win = await app.firstWindow();
  await win.waitForLoadState('domcontentloaded');
  await win.setViewportSize({ width: 1200, height: 820 }).catch(() => {});

  // 확장을 앱의 브리지에 잇는다.
  const worker = browserCtx.serviceWorkers()[0] ?? (await browserCtx.waitForEvent('serviceworker'));
  const panel = await browserCtx.newPage();
  await panel.goto(`chrome-extension://${new URL(worker.url()).host}/sidepanel.html`);
  await panel.evaluate((v) => chrome.storage.local.set({ bridgeSettings: v }), { mode: 'ws', port: PORT, token: TOKEN });
  const target = await browserCtx.newPage();
  const open = async (path) => {
    await target.goto(SITE + path);
    await target.bringToFront();
  };

  /** 새 실행 카드(지금까지 before개였음)가 생기고 결과가 나오기를 기다린다. */
  let runs = 0;
  const lastResult = async () => {
    const card = win.locator('.run').nth(runs);
    await card.waitFor({ timeout: RUN_TIMEOUT });
    runs++;
    const r = card.locator('#result');
    await r.waitFor({ timeout: RUN_TIMEOUT });
    return { status: await r.getAttribute('data-status'), text: await r.innerText() };
  };
  /** 아직 답하지 않은 질문 카드에 답한다. */
  const answer = async (value) => {
    const card = win.locator('.card.ask').first();
    await card.waitFor({ timeout: RUN_TIMEOUT });
    if (value === true) await card.locator('[data-yes]').click();
    else if (value === false) await card.locator('[data-no]').click();
    else {
      await card.locator('[data-answer]').fill(value);
      await card.locator('[data-answer]').press('Enter');
    }
  };
  const say = async (text) => {
    await win.locator('#composer').fill(text);
    await win.locator('#composer').press('Enter');
  };

  await scenario('앱이 뜨고 확장이 붙으면 브라우저를 보여 줌, 기본 스킬 목록', async () => {
    // 확장이 붙고 브라우저 이름을 알리면 위쪽에 보인다.
    await win.locator('#browser-select option', { hasText: /Chromium \d+ \(WebSocket\)/ }).waitFor({ state: 'attached', timeout: 45_000 });
    assert.match(await win.locator('#skill-list').innerText(), /기본[\s\S]*재공 확인/);
    await win.screenshot({ path: join(ROOT, 'test-results/desktop-home.png') });
  });

  await scenario('말로 요청 → 스킬과 입력값 확인 → 실행 → 결과 카드와 저장한 파일', async () => {
    await open('/wip.html');
    await say('7라인 재공 확인해줘');
    await answer(true); // 실행할까요?
    const r = await lastResult();
    assert.equal(r.status, 'done', r.text);
    assert.match(r.text, /재공확인_7라인\.xlsx/);
    assert.match(await win.locator('.run').last().innerText(), /단계 5 · extract_table[\s\S]*3페이지 추출/);
    await win.screenshot({ path: join(ROOT, 'test-results/desktop-run.png') });
  });

  await scenario('왼쪽 스킬을 눌러 입력값을 넣고 실행', async () => {
    await open('/wip.html');
    await win.locator('[data-skill=wip-check]').click();
    const form = win.locator('[data-form=wip-check]').last();
    await form.locator('[data-input=line]').selectOption('8라인').catch(() => form.locator('[data-input=line]').fill('8라인'));
    await form.getByRole('button', { name: '실행' }).click();
    const r = await lastResult();
    assert.equal(r.status, 'done', r.text);
    assert.match(r.text, /재공확인_8라인\.xlsx/);
  });

  await scenario('저장·상신: 앱에 승인 안내, 브라우저 승인 창에서 승인하면 상신', async () => {
    await fetch(`${SITE}/api/fw`, { method: 'DELETE' });
    await open('/fw.html');
    await win.locator('[data-skill=firewall-request]').click();
    const form = win.locator('[data-form=firewall-request]').last();
    for (const [k, v] of Object.entries({ src_ip: '10.10.1.15', dst_ip: '10.20.3.7', port: '1521', period_days: '90', reason: '개발 서버에서 운영 DB 조회 배치를 실행하기 위함' })) {
      await form.locator(`[data-input=${k}]`).fill(v);
    }
    const popup = browserCtx.waitForEvent('page', { predicate: (p) => p.url().includes('approve.html'), timeout: RUN_TIMEOUT });
    await form.getByRole('button', { name: '실행' }).click();
    const page = await popup;
    await win.locator('#approval-notice').waitFor({ timeout: RUN_TIMEOUT });
    assert.match(await win.locator('#approval-notice').innerText(), /10\.10\.1\.15/);
    await win.screenshot({ path: join(ROOT, 'test-results/desktop-approval.png') });
    await page.locator('#approve').click();
    const r = await lastResult();
    assert.equal(r.status, 'done', r.text);
    assert.equal((await fetch(`${SITE}/api/fw`).then((x) => x.json())).length, 1);
  });

  await scenario('자유 요청 → 스킬로 저장 (질문 카드에 답) → 왼쪽 목록에 개인 스킬', async () => {
    await open('/wip.html');
    await say('8라인을 선택하고 조회해서 총 몇 건인지 알려줘');
    await answer(true); // 진행할까요?
    const r = await lastResult();
    assert.equal(r.status, 'done', r.text);
    assert.match(r.text, /173건/);
    await answer(true); // 스킬로 저장할까요?
    await answer(''); // 이름 [line]
    await answer('조회할 라인 (예: 7라인)');
    await answer('wip-count-app');
    await answer('라인 재공 건수');
    await answer(''); // 설명
    await answer('생산관리');
    await win.locator('[data-skill=wip-count-app]').waitFor({ timeout: 10_000 });
    assert.match(await win.locator('#skill-list').innerText(), /개인[\s\S]*라인 재공 건수/);
    await win.screenshot({ path: join(ROOT, 'test-results/desktop-saved.png') });
  });

  await scenario('말로 스킬 만들기: 버튼 → 업무 설명 → 말로 고치기 → 시험 → 저장 → 왼쪽 목록', async () => {
    await open('/wip.html');
    await win.locator('#compose-skill').click();
    await answer('라인을 골라 재공을 조회하고 총 몇 건인지 알려줘. 라인은 매번 다름');
    await win.locator('.msg-text', { hasText: '라인 재공 건수 (wip-count' }).waitFor({ timeout: RUN_TIMEOUT });
    await answer('이름을 라인별 재공 건수로 바꿔 줘');
    await win.locator('.msg-text', { hasText: '라인별 재공 건수 (wip-count' }).waitFor({ timeout: RUN_TIMEOUT });
    await win.screenshot({ path: join(ROOT, 'test-results/desktop-compose.png') });
    await win.locator('.card.ask [data-quick=시험]').first().click();
    const r = await lastResult();
    assert.equal(r.status, 'done', r.text);
    await win.locator('.card.ask [data-quick=저장]').first().click();
    await answer('생산관리'); // 담당 부서
    await answer('wip-count-desk'); // 스킬 ID
    await win.locator('[data-skill=wip-count-desk]').waitFor({ timeout: 10_000 });
    assert.match(await win.locator('#skill-list').innerText(), /개인[\s\S]*라인별 재공 건수/);
  });

  await scenario('설정: 확장 연결 토큰과 지금 설정을 보여 줌', async () => {
    await win.locator('#open-settings').click();
    await win.locator('#settings').waitFor();
    assert.equal(await win.locator('#token').inputValue(), TOKEN);
    assert.match(await win.locator('#config').innerText(), /개인 스킬/);
    await win.screenshot({ path: join(ROOT, 'test-results/desktop-settings.png') });
    await win.keyboard.press('Escape');
    await win.locator('#settings').getByRole('button', { name: '닫기' }).click();
  });

  await scenario('결과 확인용: 7라인 건수가 모의 사이트와 같음', async () => {
    await open('/wip.html');
    await win.locator('[data-skill=wip-count-app]').click();
    const form = win.locator('[data-form=wip-count-app]').last();
    // 녹화한 고르기 칸이라 보기 중에서 고른다.
    await form.locator('[data-input=line]').selectOption('7라인');
    await form.getByRole('button', { name: '실행' }).click();
    const r = await lastResult();
    assert.match(r.text, new RegExp(`총 ${generateWip('7라인').length}건`));
  });
} finally {
  await app.close().catch(() => {});
  await browserCtx.close();
  site.close();
  llm.close();
  console.log(`\n결과: 통과 ${tally.pass}, 실패 ${tally.fail}`);
  process.exitCode = tally.fail ? 1 : 0;
}
