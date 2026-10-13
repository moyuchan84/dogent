// 빌드된 확장을 실제 Chromium에 올려 재공 확인을 끝까지 돌려 본다.
// 모의 사이트와 모델 서버는 이 스크립트가 띄운다.
//
//   pnpm build && pnpm e2e           모의 모델 (배관 검증, 항상 같은 결과)
//   pnpm build && pnpm e2e:ollama    로컬 Ollama의 실제 모델 (모델 판단 능력 검증)
//
// Ollama 모드 환경 변수
//   OLLAMA_MODEL    모델 이름 (기본 llama3)
//   OLLAMA_NUM_CTX  컨텍스트 길이 (기본 8192)
//   RUNS            첫 시나리오 반복 횟수 (기본 1)
//   TIMEOUT_SCALE   제한 시간 배율. GPU 없이 도는 느린 환경에서 올린다 (기본 1)
//   ONLY            이름에 이 글자가 들어간 시나리오만 실행
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ExcelJS from 'exceljs';
import { chromium } from 'playwright';
import { generateWip } from '../../mock-site/data.mjs';
import { createMockSite } from '../../mock-site/server.mjs';
import { createMockLlm } from '../../tools/mock-llm.mjs';
import { createOllamaProxy } from '../../tools/ollama-proxy.mjs';

const ROOT = join(import.meta.dirname, '../..');
const EXT = join(ROOT, '.output/chrome-mv3');
const SITE = 'http://localhost:4173';
const OLLAMA = process.argv.includes('--ollama');
const MODEL = process.env.OLLAMA_MODEL ?? 'llama3';
const RUNS = OLLAMA ? Number(process.env.RUNS ?? 1) : 1;
const SCALE = OLLAMA ? Number(process.env.TIMEOUT_SCALE ?? 1) : 1;
const ONLY = process.env.ONLY;
// HEADED=1 이면 브라우저 창을 띄워 에이전트가 화면을 조작하는 모습을 볼 수 있다.
const HEADED = !!process.env.HEADED;
const RUN_TIMEOUT = (OLLAMA ? 330_000 : 60_000) * SCALE;
const num = (s) => Number(s.replace(/,/g, ''));

async function sheets(file) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(await readFile(file));
  const out = {};
  wb.eachSheet((ws) => {
    out[ws.name] = [];
    ws.eachRow((row) => out[ws.name].push(row.values.slice(1)));
  });
  return out;
}

const site = createMockSite().listen(4173);
const llm = (OLLAMA ? createOllamaProxy({ model: MODEL, log: (line) => console.log(`      ${line}`) }) : createMockLlm()).listen(4174);
const profile = await mkdtemp(join(tmpdir(), 'dogent-e2e-'));
const context = await chromium.launchPersistentContext(profile, {
  channel: 'chromium',
  headless: !HEADED,
  viewport: HEADED ? null : undefined,
  acceptDownloads: true,
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
});
console.log(OLLAMA ? `모델: Ollama ${MODEL}` : '모델: 모의 모델');

const tally = { pass: 0, fail: 0 };
try {
  const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
  const extId = new URL(worker.url()).host;

  /** 대상 페이지와 그 탭을 조작하는 패널 페이지를 연다. */
  async function open(path) {
    let target;
    if (HEADED) {
      // 눈으로 볼 때는 업무 화면을 별도 창으로 띄워 패널과 나란히 보이게 한다.
      const cdp = await context.newCDPSession(context.pages()[0]);
      [target] = await Promise.all([
        context.waitForEvent('page'),
        cdp.send('Target.createTarget', { url: SITE + path, newWindow: true }),
      ]);
      await target.waitForLoadState();
    } else {
      target = await context.newPage();
      await target.goto(SITE + path);
    }
    const panel = await context.newPage();
    await panel.goto(`chrome-extension://${extId}/sidepanel.html`);
    const tabId = await panel.evaluate(
      async (prefix) => (await chrome.tabs.query({})).find((t) => t.url?.startsWith(prefix))?.id,
      SITE,
    );
    assert.ok(tabId, '대상 탭을 찾지 못함');
    if (OLLAMA) {
      await panel.evaluate(
        (llmSettings) => chrome.storage.local.set({ llmSettings }),
        { baseUrl: 'http://localhost:4174/v1', apiKey: '', model: MODEL, jsonMode: true, timeoutScale: SCALE },
      );
    }
    const panelUrl = `chrome-extension://${extId}/sidepanel.html?tabId=${tabId}`;
    await panel.goto(panelUrl);
    return { target, panel };
  }

  /** 실행을 누르고 끝날 때까지 기다린다. 저장된 파일이 있으면 내려받아 경로를 돌려준다. */
  async function run(panel) {
    const downloads = [];
    panel.on('download', (d) => downloads.push(d));
    const started = Date.now();
    await panel.click('#run');
    const result = panel.locator('#result');
    await result.waitFor({ timeout: RUN_TIMEOUT }).catch(async () => {
      const e = new Error(`${RUN_TIMEOUT / 1000}초 안에 끝나지 않음`);
      e.runLog = await panel.locator('.log').innerText().catch(() => '(기록 없음)');
      throw e;
    });
    const files = [];
    for (const d of downloads) {
      const path = join(profile, `${Date.now()}-${files.length}.xlsx`);
      await d.saveAs(path);
      files.push({ name: d.suggestedFilename(), path });
    }
    return {
      status: await result.getAttribute('data-status'),
      text: await result.innerText(),
      log: await panel.locator('.log').innerText().catch(() => ''),
      files,
      sec: ((Date.now() - started) / 1000).toFixed(1),
    };
  }

  async function scenario(name, fn) {
    if (ONLY && !name.includes(ONLY)) return;
    const pages = [];
    try {
      const detail = await fn(async (path) => {
        const opened = await open(path);
        pages.push(opened.target, opened.panel);
        return opened;
      });
      tally.pass++;
      console.log(`통과  ${name}${detail ? `  (${detail})` : ''}`);
    } catch (e) {
      tally.fail++;
      console.log(`실패  ${name}\n${e.message}${e.runLog ? `\n--- 동작 기록 ---\n${e.runLog}` : ''}`);
    } finally {
      for (const p of pages) await p.close().catch(() => {});
    }
  }

  /** 실패했을 때 모델이 무엇을 했는지 보이도록 동작 기록을 붙인다. */
  function check(r, fn) {
    try {
      fn();
    } catch (e) {
      e.runLog = `${r.log}\n[${r.status}] ${r.text}`;
      throw e;
    }
  }

  for (let i = 1; i <= RUNS; i++) {
    await scenario(`자연어 요청 → 3페이지 추출 → 엑셀${RUNS > 1 ? ` #${i}` : ''}`, async (openPages) => {
      const { target, panel } = await openPages('/wip.html');
      await panel.fill('#request', '7라인 재공 확인해줘');
      await panel.click('#plan');
      await panel
        .locator('[data-input=line]')
        .and(panel.locator('[value="7라인"]'))
        .waitFor({ timeout: RUN_TIMEOUT })
        .catch(async () => {
          const line = await panel.locator('[data-input=line]').inputValue();
          const notice = await panel.locator('.notice').innerText().catch(() => '(안내 없음)');
          throw new Error(`요청 해석 실패: 라인 입력값이 "${line}" (기대 "7라인"). 안내: ${notice}`);
        });
      const r = await run(panel);
      const want = generateWip('7라인');
      const book = r.files[0] ? await sheets(r.files[0].path) : {};
      check(r, () => {
        assert.equal(r.status, 'done');
        assert.equal(r.files[0]?.name, '재공확인_7라인.xlsx');
        assert.deepEqual(Object.keys(book), ['원본', '정체Lot', '공정별집계']);
        assert.deepEqual(
          book['원본'].slice(1),
          want.map((row) => [row[0], row[1], row[2], num(row[3]), row[4], Number(row[5])]),
        );
        const hold = want.filter((row) => Number(row[5]) >= 24 || row[4] === 'HOLD').map((row) => row[0]);
        assert.deepEqual(book['정체Lot'].slice(1).map((row) => row[0]).sort(), hold.sort());
        assert.equal(book['공정별집계'].length - 1, new Set(want.map((row) => row[2])).size);
      });
      assert.equal(await target.locator('#pageinfo').innerText(), '3 / 3 페이지');
      if (i === 1) await panel.screenshot({ path: join(ROOT, 'test-results/panel-done.png'), fullPage: true });
      return `${r.sec}초`;
    });
  }

  await scenario('iframe 안의 업무 화면 + 공정 조건', async (openPages) => {
    const { target, panel } = await openPages('/portal.html');
    await panel.fill('[data-input=line]', '8라인');
    await panel.fill('[data-input=step]', 'PHOTO');
    const r = await run(panel);
    const want = generateWip('8라인', 'PHOTO');
    const book = r.files[0] ? await sheets(r.files[0].path) : {};
    check(r, () => {
      assert.equal(r.status, 'done');
      assert.deepEqual(book['원본']?.slice(1).map((row) => row[0]), want.map((row) => row[0]));
    });
    assert.ok(target.url().endsWith('/portal.html'), '포털 화면을 벗어나면 안 됨');
    return `${r.sec}초`;
  });

  await scenario('로그인 화면이면 중단', async (openPages) => {
    const { panel } = await openPages('/login.html');
    await panel.fill('[data-input=line]', '7라인');
    const r = await run(panel);
    check(r, () => {
      assert.equal(r.status, 'aborted');
      assert.match(r.text, /로그인/);
    });
  });

  await scenario('없는 라인이면 중단하고 파일을 만들지 않음', async (openPages) => {
    const { panel } = await openPages('/wip.html');
    await panel.fill('[data-input=line]', '9라인');
    const r = await run(panel);
    check(r, () => {
      assert.equal(r.status, 'aborted');
      assert.equal(r.files.length, 0);
    });
    return `${r.sec}초`;
  });
} finally {
  await context.close();
  site.close();
  llm.close();
  await rm(profile, { recursive: true, force: true }).catch(() => {});
}
console.log(`\n결과: 통과 ${tally.pass}, 실패 ${tally.fail}`);
process.exit(tally.fail ? 1 : 0);
