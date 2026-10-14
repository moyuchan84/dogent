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
        {
          baseUrl: 'http://localhost:4174/v1',
          apiKey: '',
          model: MODEL,
          jsonMode: true,
          timeoutScale: SCALE,
          // 모델의 판단 능력을 재는 것이 목적이므로 기본은 모든 동작을 모델이 정하게 한다. DIRECT=1이면 제품 기본값대로.
          skillDirect: process.env.DIRECT === '1',
          pathCache: process.env.DIRECT === '1',
        },
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
    await panel.selectOption('#skill', 'wip-check');
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

  const fwInputs = {
    src_ip: '10.10.1.15',
    dst_ip: '10.20.3.7',
    port: '1521',
    period_days: '90',
    reason: '개발 서버에서 운영 DB 조회 배치를 실행하기 위함',
  };
  const fwApi = (method = 'GET') => fetch(`${SITE}/api/fw`, { method }).then((r) => r.json());

  /** 방화벽 신청 스킬을 고르고 입력값을 채운다. */
  async function fillFirewall(panel, overrides = {}) {
    await fwApi('DELETE');
    await panel.selectOption('#skill', 'firewall-request');
    for (const [name, value] of Object.entries({ ...fwInputs, ...overrides })) {
      await panel.fill(`[data-input=${name}]`, value);
    }
  }

  /** 실행을 누르고 승인 대화상자가 뜰 때까지 기다린다. */
  async function runUntilApproval(panel) {
    await panel.click('#run');
    await panel.locator('#approval').waitFor({ timeout: RUN_TIMEOUT });
    return panel.locator('#approval').innerText();
  }

  async function result(panel) {
    const el = panel.locator('#result');
    await el.waitFor({ timeout: RUN_TIMEOUT });
    return { status: await el.getAttribute('data-status'), text: await el.innerText() };
  }

  await scenario('방화벽 신청: 승인하면 입력값 그대로 한 번 상신', async (openPages) => {
    const { target, panel } = await openPages('/fw.html');
    await fillFirewall(panel);
    const dialog = await runUntilApproval(panel);
    for (const value of Object.values(fwInputs)) assert.ok(dialog.includes(value), `승인 대화상자에 ${value} 없음`);
    assert.deepEqual(await fwApi(), [], '승인 전에는 상신되면 안 됨');
    await panel.click('#approve');
    const r = await result(panel);
    assert.equal(r.status, 'done', r.text);
    assert.match(r.text, /FW-000001/);
    assert.deepEqual(await fwApi(), [
      { id: 'FW-000001', src: '10.10.1.15', dst: '10.20.3.7', port: '1521', protocol: 'TCP', days: '90', reason: fwInputs.reason },
    ]);
    assert.match(await target.locator('#done').innerText(), /FW-000001/);
    await panel.screenshot({ path: join(ROOT, 'test-results/panel-firewall.png'), fullPage: true });
  });

  await scenario('방화벽 신청: 승인하지 않으면 상신하지 않음', async (openPages) => {
    const { target, panel } = await openPages('/fw.html');
    await fillFirewall(panel);
    await runUntilApproval(panel);
    await panel.screenshot({ path: join(ROOT, 'test-results/panel-approval.png'), fullPage: true });
    // 업무 화면에는 에이전트가 조작 중이라는 테두리와 마지막으로 가리킨 요소가 표시된다.
    await target.screenshot({ path: join(ROOT, 'test-results/page-pointer.png') });
    await panel.click('#decline');
    const r = await result(panel);
    assert.equal(r.status, 'aborted', r.text);
    assert.deepEqual(await fwApi(), []);
    assert.equal(await target.locator('#src').inputValue(), '10.10.1.15');
  });

  await scenario('방화벽 신청: 시험 실행은 상신 직전에 멈춤', async (openPages) => {
    const { panel } = await openPages('/fw.html');
    await fillFirewall(panel);
    await panel.check('#dryrun');
    await panel.click('#run');
    const r = await result(panel);
    assert.equal(r.status, 'dryrun', r.text);
    assert.equal(await panel.locator('#approval').count(), 0);
    assert.deepEqual(await fwApi(), []);
  });

  await scenario('방화벽 신청: 넓은 대역은 실행 전에 거부', async (openPages) => {
    const { target, panel } = await openPages('/fw.html');
    await fillFirewall(panel, { src_ip: '10.10.0.0/16' });
    await panel.click('#run');
    await panel.locator('.notice').waitFor();
    assert.match(await panel.locator('.notice').innerText(), /\/24보다 넓은 대역/);
    assert.equal(await panel.locator('#result').count(), 0);
    assert.equal(await target.locator('#src').inputValue(), '');
    assert.deepEqual(await fwApi(), []);
  });

  const adjustColumns = ['Lot ID', '공정', '조정수량', '사유'];
  const adjustRows = [
    ['P7-00012', 'PHOTO', -25, '검사 불량 폐기'],
    ['P7-00031', 'ETCH', 100, '재작업 투입'],
    ['P7-00044', 'CMP', -3, '샘플 반출'],
    ['P7-00058', 'IMP', 12, '수량 정정'],
    ['P7-00071', 'DIFF', -8, '파손'],
  ];
  const adjustApi = (method = 'GET') => fetch(`${SITE}/api/adjust`, { method }).then((r) => r.json());

  /** 조정 내역 엑셀 파일을 만들어 경로를 돌려준다. */
  async function adjustFile(name, rows) {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('조정');
    ws.addRow(adjustColumns);
    for (const r of rows) ws.addRow(r);
    const path = join(profile, name);
    await wb.xlsx.writeFile(path);
    return path;
  }

  await scenario('엑셀 → 웹 입력: 5행을 표에 채우고 승인 후 저장', async (openPages) => {
    const { target, panel } = await openPages('/adjust.html');
    await adjustApi('DELETE');
    await panel.selectOption('#skill', 'wip-adjust');
    await panel.setInputFiles('[data-input=source]', await adjustFile('adjust.xlsx', adjustRows));
    const dialog = await runUntilApproval(panel);
    assert.match(dialog, /조정 목록/);
    assert.match(dialog, /5행/);
    assert.ok(dialog.includes('P7-00071'), '승인 대화상자에 마지막 행이 보여야 함');
    assert.deepEqual(await adjustApi(), [], '승인 전에는 저장되면 안 됨');
    assert.equal(await target.locator('#adjGrid tbody tr').count(), 5, '빈 행 3개에 2개가 추가되어야 함');
    await panel.screenshot({ path: join(ROOT, 'test-results/panel-adjust-approval.png'), fullPage: true });
    await target.screenshot({ path: join(ROOT, 'test-results/page-adjust.png') });
    await panel.click('#approve');
    const r = await result(panel);
    assert.equal(r.status, 'done', r.text);
    assert.match(r.text, /5건을 저장했습니다/);
    assert.deepEqual(await adjustApi(), [adjustRows.map((row) => row.map(String))]);
  });

  await scenario('엑셀 → 웹 입력: 화면에서 고를 수 없는 값이 있으면 저장하지 않음', async (openPages) => {
    const { panel } = await openPages('/adjust.html');
    await adjustApi('DELETE');
    await panel.selectOption('#skill', 'wip-adjust');
    const rows = adjustRows.map((row) => [...row]);
    rows[1][1] = 'WET';
    await panel.setInputFiles('[data-input=source]', await adjustFile('adjust-bad.xlsx', rows));
    await panel.click('#run');
    const r = await result(panel);
    assert.equal(r.status, 'aborted', r.text);
    assert.match(r.text, /2행 "공정"/);
    assert.equal(await panel.locator('#approval').count(), 0);
    assert.deepEqual(await adjustApi(), []);
  });

  await scenario('자유 요청: 스킬 없이 선택·조회하고 결과를 답함', async (openPages) => {
    const { target, panel } = await openPages('/wip.html');
    await panel.selectOption('#skill', 'free');
    await panel.fill('[data-input=request]', '8라인을 선택하고 조회해서 총 몇 건인지 알려줘');
    const r = await run(panel);
    check(r, () => {
      assert.equal(r.status, 'done');
      assert.match(r.text, /173/);
    });
    assert.equal(await target.locator('#total').innerText(), '총 173건');
    assert.equal(await target.locator('#line').inputValue(), '8라인');
    return `${r.sec}초`;
  });

  await scenario('자유 요청: 쓰기를 허용하지 않으면 저장 버튼을 누르지 않음', async (openPages) => {
    const { target, panel } = await openPages('/wip.html');
    await panel.selectOption('#skill', 'free');
    await panel.fill('[data-input=request]', '지금 조건을 저장해줘');
    const r = await run(panel);
    assert.equal(await panel.locator('#approval').count(), 0);
    assert.equal(await target.locator('#msg').innerText(), '', `저장 버튼이 눌림 (${r.status})`);
    return `${r.status}, ${r.sec}초`;
  });

  await scenario('스킬 만들기: 한 번 해 보이면 초안이 나오고, 시험 실행을 통과하면 배포 요청 가능', async (openPages) => {
    const { target, panel } = await openPages('/fw.html');
    await fwApi('DELETE');
    await panel.click('#tab-author');
    await panel.fill('#a-id', 'fw-recorded');
    await panel.fill('#a-name', '방화벽 신청 녹화');
    await panel.fill('#a-desc', '녹화로 만든 방화벽 해제 신청');
    await panel.fill('#a-owner', '인프라운영');
    await panel.click('#rec-start');
    await panel.locator('#rec').waitFor();

    // 사람이 업무 화면에서 한 번 해 보인다.
    await target.bringToFront();
    await target.fill('#src', '10.10.1.15');
    await target.fill('#dst', '10.20.3.7');
    await target.fill('#port', '1521');
    await target.selectOption('#proto', 'UDP');
    await target.fill('#days', '90');
    await target.fill('#reason', '개발 서버에서 운영 DB 조회 배치 실행');
    await target.click('#submit');
    await target.locator('#done').waitFor();
    await panel.bringToFront();
    await panel.locator('#rec[data-count="7"]').waitFor();
    await panel.getByText('"상신" 누름 → "신청이 접수되었습니다." 나타남').waitFor();
    // 프로토콜은 늘 같은 값이므로 고정한다.
    await panel.locator('.rec-list li', { hasText: '프로토콜' }).locator('input[type=checkbox]').uncheck();
    await panel.screenshot({ path: join(ROOT, 'test-results/panel-author-recording.png'), fullPage: true });
    await panel.click('#rec-stop');

    // 초안은 손대지 않아도 배포 기준(B 이상)이고, 상신 통제가 선언되어 있다.
    assert.equal(await panel.locator('#lint').getAttribute('data-grade'), 'B');
    const source = await panel.locator('#draft-src').inputValue();
    assert.match(source, /risk: R3/);
    assert.match(source, /submit_steps: \[8\]/);
    assert.match(source, /submit_labels: \["상신"\]/);
    await panel.screenshot({ path: join(ROOT, 'test-results/panel-author-lint.png'), fullPage: true });
    // 내용을 깨뜨리면 저장할 수 없다.
    await panel.fill('#draft-src', source.replace('submit_steps: [8]', 'submit_steps: [2]'));
    assert.equal(await panel.locator('#lint').getAttribute('data-grade'), 'F');
    assert.ok(await panel.locator('#draft-save').isDisabled());
    await panel.fill('#draft-src', source);
    await panel.click('#draft-save');
    const draft = panel.locator('.draft[data-id="fw-recorded"]');
    assert.equal(await draft.getAttribute('data-ready'), 'false', '시험 실행 전에는 배포 요청 불가');

    // 실행 탭에서 초안을 골라 다른 값으로 시험 실행한다.
    assert.deepEqual((await fwApi()).length, 1, '녹화 중 사람이 한 상신 1건');
    await target.goto(SITE + '/fw.html');
    await panel.click('#tab-run');
    await panel.selectOption('#skill', 'fw-recorded');
    const values = ['10.10.9.9', '10.20.9.9', '443', '30', '테스트 서버 연동 확인'];
    for (const [i, value] of values.entries()) await panel.fill(`[data-input=v${i + 1}]`, value);
    await panel.check('#dryrun');
    await panel.click('#run');
    const r = await result(panel).catch(async (e) => {
      e.runLog = await panel.locator('.app').innerText();
      throw e;
    });
    assert.equal(r.status, 'dryrun', r.text);
    assert.equal(await target.locator('#src').inputValue(), '10.10.9.9');
    assert.equal(await target.locator('#proto').inputValue(), 'UDP');
    assert.equal(await target.locator('#reason').inputValue(), '테스트 서버 연동 확인');
    assert.deepEqual((await fwApi()).length, 1, '시험 실행은 상신하지 않음');
    assert.doesNotMatch(await panel.locator('.log').innerText(), /모델 응답/);

    await panel.click('#tab-author');
    assert.equal(await draft.getAttribute('data-ready'), 'true');
    await panel.screenshot({ path: join(ROOT, 'test-results/panel-author-ready.png'), fullPage: true });
    await fwApi('DELETE');
  });

  const startRecording = async (panel, id, name) => {
    await panel.click('#tab-author');
    await panel.fill('#a-id', id);
    await panel.fill('#a-name', name);
    await panel.fill('#a-desc', `녹화로 만든 ${name}`);
    await panel.fill('#a-owner', '생산관리');
    await panel.click('#rec-start');
    await panel.locator('#rec').waitFor();
  };

  await scenario('스킬 만들기: 새 창에서 행을 고르고 확인·알림 창을 거친 조작도 녹화', async (openPages) => {
    const { target, panel } = await openPages('/hold.html');
    const api = (method = 'GET') => fetch(`${SITE}/api/hold`, { method }).then((r) => r.json());
    await api('DELETE');
    // 녹화 중에는 창이 실제로 뜨고 사람이 답한다. 여기서는 모두 확인을 누른다.
    const accept = (d) => d.accept().catch(() => {});
    context.on('dialog', accept);
    try {
      await startRecording(panel, 'hold-recorded', '홀드 해제 녹화');
      await target.bringToFront();
      const [popup] = await Promise.all([context.waitForEvent('page'), target.click('#find')]);
      await popup.waitForLoadState();
      await panel.getByText('"Lot 찾기" 누름 → "홀드 Lot 찾기" 나타남').waitFor();
      // 녹화는 0.5초마다 새 화면에 다시 걸린다.
      await popup.waitForTimeout(1200);
      await popup.locator('tr', { hasText: 'P7-00031' }).locator('button').click();
      await target.bringToFront();
      await target.fill('#reason', '설비 점검이 끝나 공정을 다시 진행함');
      await target.click('#submit');
      await panel.bringToFront();
      await panel.locator('#rec[data-count="4"]').waitFor();
      await panel.getByText('알림 "접수되었습니다. 접수 번호: HR-000001"').waitFor();
      await panel.screenshot({ path: join(ROOT, 'test-results/panel-author-popup.png'), fullPage: true });
      await panel.click('#rec-stop');

      const source = await panel.locator('#draft-src').inputValue();
      assert.match(source, /\{"ref":"선택","row":"P7-00031"\}/);
      assert.match(source, /검사: did\("click"\) and dialog\("접수되었습니다"\)/);
      assert.match(source, /risk: R3/);
      assert.match(source, /submit_steps: \[5\]/);
      assert.notEqual(await panel.locator('#lint').getAttribute('data-grade'), 'F', source);
      assert.deepEqual((await api()).length, 1, '녹화 중 사람이 한 상신 1건');
    } finally {
      context.off('dialog', accept);
      await api('DELETE');
    }
  });

  await scenario('스킬 만들기: 표를 고르면 다음 페이지 버튼으로 끝까지 읽게 할 수 있음', async (openPages) => {
    const { target, panel } = await openPages('/wip.html');
    await startRecording(panel, 'wip-paged', '재공 전체 읽기');
    await target.bringToFront();
    await target.selectOption('#line', '8라인');
    await target.click('#query');
    await target.locator('#next:not([disabled])').waitFor();
    await panel.bringToFront();
    await panel.locator('#rec[data-count="2"]').waitFor();
    await panel.click('#rec-table');
    await panel.locator('[data-table]').first().click();
    await panel.locator('#rec-paging [data-next="다음"]').click();
    await panel.locator('#rec[data-count="3"]').waitFor();
    await panel.click('#rec-stop');
    const source = await panel.locator('#draft-src').inputValue();
    assert.match(source, /"dataset":"data1","next_ref":"다음"\}/);
    assert.notEqual(await panel.locator('#lint').getAttribute('data-grade'), 'F', source);
  });

  await scenario('엑셀 다운로드: 서버가 만든 파일을 한 번에 받아 정리', async (openPages) => {
    const { target, panel } = await openPages('/wip.html');
    await panel.selectOption('#skill', 'wip-download');
    await panel.fill('[data-input=line]', '8라인');
    const r = await run(panel);
    const want = generateWip('8라인');
    const book = r.files[0] ? await sheets(r.files[0].path) : {};
    check(r, () => {
      assert.equal(r.status, 'done');
      assert.equal(r.files[0]?.name, '재공내려받기_8라인.xlsx');
      assert.deepEqual(
        book['원본'].slice(1),
        want.map((row) => [row[0], row[1], row[2], num(row[3]), row[4], Number(row[5])]),
      );
      const hold = want.filter((row) => Number(row[5]) >= 24 || row[4] === 'HOLD').map((row) => row[0]);
      assert.deepEqual(book['정체Lot'].slice(1).map((row) => row[0]).sort(), hold.sort());
      assert.match(r.log, /재공_8라인\.xlsx 내려받음/);
    });
    assert.equal(await target.locator('#pageinfo').innerText(), '1 / 4 페이지', '페이지를 넘기지 않아야 함');
    return `${r.sec}초`;
  });

  await scenario('CSV 내려받기: 화면이 만들고 바로 지운 파일도 읽음', async (openPages) => {
    const { target, panel } = await openPages('/wip.html');
    const source = `---
id: csv-download
name: CSV 내려받기 시험
description: 화면이 만든 CSV 파일을 받아 엑셀로 저장한다
version: 0.1.0
owner: 시험
risk: R1
domains:
  - localhost:4173
limits:
  max_steps: 20
  timeout_sec: 120
---

## 단계

1. select로 "라인"에서 값을 선택한다. args는 다음을 그대로 쓴다.
   \`{"ref": "라인", "value": "6라인"}\`
   - 검사: value("라인") == "6라인"
2. click으로 "조회" 버튼을 한 번 누른다. args는 다음을 그대로 쓴다.
   \`{"ref": "조회"}\`
   - 검사: did("click") and no_text("조회 중") and text("총")
3. download_table로 "CSV 내려받기" 버튼을 눌러 받은 파일을 데이터셋 \`d\`에 담는다. args는 다음을 그대로 쓴다.
   \`{"ref": "CSV 내려받기", "dataset": "d"}\`
   - 검사: rows("d") == page_number("총 ([\\d,]+)건")
4. write_excel로 엑셀 파일을 저장한다. args는 다음을 그대로 쓴다.
   \`{"filename": "csv시험", "sheets": [{"name": "표", "dataset": "d"}]}\`
   - 검사: did("write_excel")
5. finish로 결과를 보고한다. args는 다음을 그대로 쓴다.
   \`{"summary": "{rows.d}행을 받았습니다."}\`

## 예외

- 화면에 오류 메시지가 나오면 abort로 메시지 원문을 그대로 알린다.
`;
    const before = await panel.evaluate(async () => (await chrome.storage.local.get('draftSkills')).draftSkills ?? []);
    await panel.evaluate(
      (draftSkills) => chrome.storage.local.set({ draftSkills }),
      [...before, { id: 'csv-download', source, savedAt: new Date().toISOString() }],
    );
    try {
      await panel.reload();
      await panel.selectOption('#skill', 'csv-download');
      const r = await run(panel);
      const want = generateWip('6라인');
      const book = r.files[0] ? await sheets(r.files[0].path) : {};
      check(r, () => {
        assert.equal(r.status, 'done');
        assert.match(r.text, new RegExp(`${want.length}행을 받았습니다`));
        assert.deepEqual(
          book['표'].slice(1),
          want.map((row) => [row[0], row[1], row[2], num(row[3]), row[4], Number(row[5])]),
        );
        assert.doesNotMatch(r.log, /모델 응답/);
      });
      // 페이지의 URL.createObjectURL은 원래대로 돌아가 있어야 한다.
      assert.equal(await target.evaluate(() => '__dogentBlobs' in window), false);
      return `${r.sec}초`;
    } finally {
      await panel.evaluate((draftSkills) => chrome.storage.local.set({ draftSkills }), before);
    }
  });

  const holdApi = (method = 'GET') => fetch(`${SITE}/api/hold`, { method }).then((r) => r.json());

  await scenario('새 창과 알림 창: 팝업에서 Lot을 고르고 확인·알림 창을 거쳐 상신', async (openPages) => {
    const { target, panel } = await openPages('/hold.html');
    await holdApi('DELETE');
    // 브라우저의 창이 실제로 뜨면 실패로 본다 (에이전트가 대신 받아야 한다).
    const native = [];
    context.on('dialog', (d) => {
      native.push(d.message());
      d.dismiss().catch(() => {});
    });
    await panel.selectOption('#skill', 'hold-release');
    await panel.fill('[data-input=lot]', 'P7-00031');
    await panel.fill('[data-input=reason]', '설비 점검이 끝나 공정을 다시 진행함');
    const dialog = await runUntilApproval(panel);
    assert.ok(dialog.includes('P7-00031'), '승인 대화상자에 팝업에서 고른 Lot이 보여야 함');
    assert.deepEqual(await holdApi(), [], '승인 전에는 상신되면 안 됨');
    assert.equal(context.pages().filter((p) => p.url().includes('lot-popup')).length, 0, '팝업은 닫혀 있어야 함');
    await panel.click('#approve');
    const r = await result(panel);
    const log = await panel.locator('.log').innerText();
    assert.equal(r.status, 'done', `${r.text}\n${log}`);
    assert.match(r.text, /HR-000001/);
    assert.deepEqual(await holdApi(), [{ id: 'HR-000001', lot: 'P7-00031', reason: '설비 점검이 끝나 공정을 다시 진행함' }]);
    assert.match(log, /새 창이 열려/);
    assert.match(log, /원래 창으로 돌아왔습니다/);
    assert.doesNotMatch(log, /모델 응답/);
    assert.deepEqual(native, [], '브라우저의 알림 창이 실제로 떴음');
    // 실행이 끝나면 화면의 알림·확인 창은 원래대로 돌아간다.
    assert.equal(await target.evaluate(() => '__dogentDialogs' in window), false);
    await holdApi('DELETE');
  });

  await scenario('공유 스킬: 저장소에서 받은 스킬을 다시 빌드하지 않고 실행', async (openPages) => {
    const { panel } = await openPages('/wip.html');
    const setUrl = async (url) => {
      await panel.click("#open-settings");
      await panel.fill('#skills-url', url);
      await panel.click('#save-settings');
    };
    await setUrl(`${SITE}/shared/index.json`);
    try {
      const option = panel.locator('#skill option[value=wip-shared]');
      await option.waitFor({ state: 'attached', timeout: 10_000 });
      assert.equal(await option.innerText(), '[공유] 재공 내려받기(공유) (R1)');
      assert.match(await panel.locator('#shared-status').innerText(), /공유 스킬 1개/);
      // 목록의 해시와 내용이 다른 스킬은 받지 않고 이유를 보여준다.
      assert.equal(await panel.locator('#skill option[value=tampered]').count(), 0);
      assert.match(await panel.locator('body').innerText(), /tampered: .*해시와 다릅니다/);

      await panel.selectOption('#skill', 'wip-shared');
      await panel.fill('[data-input=line]', '8라인');
      const r = await run(panel);
      check(r, () => {
        assert.equal(r.status, 'done');
        assert.equal(r.files[0]?.name, '재공내려받기_8라인.xlsx');
      });
      // 패널을 다시 열어도 받아 둔 스킬이 남아 있다.
      await panel.reload();
      await panel.locator('#skill option[value=wip-shared]').waitFor({ state: 'attached', timeout: 10_000 });
      return `${r.sec}초`;
    } finally {
      await setUrl('');
    }
  });

  await scenario('로그인 화면이면 중단', async (openPages) => {
    const { panel } = await openPages('/login.html');
    await panel.selectOption('#skill', 'wip-check');
    await panel.fill('[data-input=line]', '7라인');
    const r = await run(panel);
    check(r, () => {
      assert.equal(r.status, 'aborted');
      assert.match(r.text, /로그인/);
    });
  });

  await scenario('없는 라인이면 중단하고 파일을 만들지 않음', async (openPages) => {
    const { panel } = await openPages('/wip.html');
    await panel.selectOption('#skill', 'wip-check');
    await panel.fill('[data-input=line]', '9라인');
    const r = await run(panel);
    check(r, () => {
      assert.equal(r.status, 'aborted');
      assert.equal(r.files.length, 0);
    });
    return `${r.sec}초`;
  });

  await scenario('기록: 지난 실행을 다시 열어 보고 스킬별 성공률과 연속 실패를 봄', async (openPages) => {
    const { target, panel } = await openPages('/wip.html');
    await panel.evaluate(() => chrome.storage.local.remove('runs'));
    // 같은 탭에서 화면만 바꿔 가며 여러 번 실행한다.
    const once = async (path, line) => {
      await target.goto(SITE + path);
      await panel.reload();
      await panel.selectOption('#skill', 'wip-check');
      await panel.fill('[data-input=line]', line);
      return (await run(panel)).status;
    };
    assert.equal(await once('/wip.html', '8라인'), 'done');
    // 로그인이 풀려 멈춘 실행은 스킬의 실패로 세지 않는다.
    assert.equal(await once('/login.html', '8라인'), 'aborted', '로그인 화면');
    assert.equal(await once('/wip.html', '9라인'), 'aborted', '없는 라인 1');
    assert.equal(await once('/wip.html', '9라인'), 'aborted', '없는 라인 2');

    await panel.reload();
    await panel.click('#tab-history');
    const row = panel.locator('.stats tr[data-skill=wip-check]');
    await row.waitFor();
    assert.equal(await row.locator('[data-rate]').innerText(), '33% (1/3)');
    assert.equal(await row.getAttribute('data-broken'), 'true');
    assert.match(await row.innerText(), /최근 2번 연속 실패/);
    assert.equal(await panel.locator('.runs > li').count(), 4);
    // 가장 최근 실행을 열면 그때의 동작과 결과가 보인다.
    await panel.locator('.runs > li').first().locator('.run-head').click();
    assert.match(await panel.locator('.run-body').innerText(), /line=9라인/);
    await panel.screenshot({ path: join(ROOT, 'test-results/panel-history.png'), fullPage: true });
    await panel.click('#clear-runs');
    await panel.getByText('아직 실행한 기록이 없습니다').waitFor();
  });
} finally {
  await context.close();
  site.close();
  llm.close();
  await rm(profile, { recursive: true, force: true }).catch(() => {});
}
console.log(`\n결과: 통과 ${tally.pass}, 실패 ${tally.fail}`);
process.exit(tally.fail ? 1 : 0);
