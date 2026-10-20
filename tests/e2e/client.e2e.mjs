// Dogent 클라이언트(터미널) + 확장 + 모의 사이트를 실제 Chromium으로 끝까지 돌려 본다 (docs/09 2단계).
//
//   pnpm build && pnpm client:build && pnpm e2e:client
//
// 클라이언트는 별도 프로세스(client/dist/dogent.mjs)로 띄우고, 확장은 클라이언트 안의 브리지에 WebSocket으로 붙는다.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { generateWip } from '../../mock-site/data.mjs';
import { createMockSite } from '../../mock-site/server.mjs';
import { createMockLlm } from '../../tools/mock-llm.mjs';

const ROOT = join(import.meta.dirname, '../..');
const EXT = join(ROOT, '.output/chrome-mv3');
const CLIENT = join(ROOT, 'client/dist/dogent.mjs');
const SITE = 'http://localhost:4173';
const TOKEN = 'client-e2e-token-0123456789';
const PORT = 39312;
const HEADED = !!process.env.HEADED;

for (const [path, how] of [[EXT, 'pnpm build'], [CLIENT, 'pnpm client:build']]) {
  if (!existsSync(path)) throw new Error(`${path}가 없습니다. 먼저 ${how}`);
}

const site = createMockSite().listen(4173);
const llm = createMockLlm().listen(4174);
const home = mkdtempSync(join(tmpdir(), 'dogent-home-'));
const out = join(home, 'out');
writeFileSync(join(home, 'config.json'), JSON.stringify({ outputDir: out }));

const context = await chromium.launchPersistentContext(await mkdtemp(join(tmpdir(), 'dogent-client-')), {
  channel: 'chromium',
  headless: !HEADED,
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
});
const tally = { pass: 0, fail: 0 };

/**
 * 클라이언트를 한 번 실행한다. answers는 묻는 순서대로 넣을 답이다.
 * onOutput으로 출력을 보며 브라우저 쪽 동작(승인 창 누르기 등)을 할 수 있다.
 */
function client(args, { answers = [], onOutput } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLIENT, ...args, '--wait', '45'], {
      env: { ...process.env, DOGENT_HOME: home, DOGENT_BRIDGE_TOKEN: TOKEN, DOGENT_BRIDGE_PORT: String(PORT), DOGENT_BRIDGE_PIPE: `\\\\.\\pipe\\dogent-client-e2e-${process.pid}` },
    });
    let text = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`클라이언트가 90초 안에 끝나지 않음:\n${text}`));
    }, 90_000);
    child.stdout.on('data', (d) => {
      text += d;
      onOutput?.(text);
    });
    child.stderr.on('data', (d) => (text += d));
    child.stdin.end(answers.map((a) => `${a}\n`).join(''));
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, text });
    });
  });
}

async function scenario(name, fn) {
  try {
    const note = await fn();
    tally.pass++;
    console.log(`통과  ${name}${note ? `  (${note})` : ''}`);
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
  await panel.evaluate((v) => chrome.storage.local.set({ bridgeSettings: v }), { mode: 'ws', port: PORT, token: TOKEN });
  const target = await context.newPage();
  const open = async (path) => {
    await target.goto(SITE + path);
    await target.bringToFront();
  };

  await scenario('스킬 목록: 기본 스킬을 보여 줌', async () => {
    const r = await client(['skills']);
    assert.equal(r.code, 0, r.text);
    assert.match(r.text, /\[기본\] wip-check — 재공 확인/);
  });

  await scenario('dogent run: 확장으로 화면을 조작해 여러 페이지를 읽고 엑셀을 폴더에 저장', async () => {
    await open('/wip.html');
    const r = await client(['run', 'wip-check', 'line=7라인']);
    assert.equal(r.code, 0, r.text);
    assert.match(r.text, /확장 연결됨 \(WebSocket\)/);
    assert.match(r.text, /\[완료\]/);
    assert.ok(readdirSync(out).includes('재공확인_7라인.xlsx'), r.text);
    const actions = (r.text.match(/단계 \d+ /g) ?? []).length;
    return `동작 ${actions}개`;
  });

  await scenario('말로 요청: 맞는 스킬을 골라 입력값을 뽑아 실행', async () => {
    await open('/wip.html');
    const r = await client(['8라인 재공 확인해줘', '--yes']);
    assert.equal(r.code, 0, r.text);
    assert.match(r.text, /스킬: 재공 확인 \[기본\]/);
    assert.ok(readdirSync(out).includes('재공확인_8라인.xlsx'), r.text);
  });

  await scenario('저장·상신: 확장의 승인 창에서 한 번 승인하면 한 번 상신', async () => {
    await fetch(`${SITE}/api/fw`, { method: 'DELETE' });
    await open('/fw.html');
    const popup = context.waitForEvent('page', { predicate: (p) => p.url().includes('approve.html'), timeout: 60_000 });
    const run = client([
      'run',
      'firewall-request',
      'src_ip=10.10.1.15',
      'dst_ip=10.20.3.7',
      'port=1521',
      'period_days=90',
      'reason=개발 서버에서 운영 DB 조회 배치를 실행하기 위함',
    ]);
    const page = await popup;
    await page.locator('#approval').waitFor();
    assert.match(await page.locator('#approval').innerText(), /10\.10\.1\.15/);
    await page.click('#approve');
    const r = await run;
    assert.equal(r.code, 0, r.text);
    assert.match(r.text, /브라우저에 뜬 Dogent 승인 창에서 승인하거나 취소하세요/);
    const log = await fetch(`${SITE}/api/fw`).then((x) => x.json());
    assert.equal(log.length, 1, JSON.stringify(log));
    // 승인 창은 한 번만 떴다.
    assert.equal(context.pages().filter((p) => p.url().includes('approve.html')).length, 0);
  });

  await scenario('자유 요청 → 개인 스킬로 저장 → 다른 라인으로 그 스킬 실행', async () => {
    await open('/wip.html');
    const r = await client(['8라인을 선택하고 조회해서 총 몇 건인지 알려줘', '--yes'], {
      // 저장할까요 / 매개변수 이름 / 설명 / 스킬 ID / 이름 / 설명 / 담당 부서
      answers: ['y', '', '조회할 라인 (예: 7라인)', 'wip-count-cli', '라인 재공 건수', '', '생산관리'],
    });
    assert.equal(r.code, 0, r.text);
    assert.match(r.text, /맞는 스킬이 없어 지금 브라우저 화면에서 자유 요청으로 합니다/);
    assert.match(r.text, /"8라인"\(라인\)을\(를\) 실행할 때마다 받습니다/);
    const file = join(home, 'skills', 'wip-count-cli', 'SKILL.md');
    assert.ok(existsSync(file), r.text);
    const source = readFileSync(file, 'utf8');
    assert.match(source, /name: line/);
    assert.match(source, /조회할 라인/);

    await open('/wip.html');
    const again = await client(['run', 'wip-count-cli', 'line=7라인']);
    assert.equal(again.code, 0, again.text);
    assert.match(again.text, new RegExp(`총 ${generateWip('7라인').length}건`));
    assert.match((await client(['skills'])).text, /\[개인\] wip-count-cli — 라인 재공 건수/);
  });

  await scenario('말로 스킬 만들기: 화면을 보고 초안 → 말로 고치기 → 시험 → 저장 → 다른 라인으로 실행', async () => {
    await open('/wip.html');
    const r = await client(['skill', 'new', '라인을 골라 재공을 조회하고 총 몇 건인지 알려줘. 라인은 매번 다름'], {
      // 고칠 점 / 시험 / 저장 → 담당 부서 / 스킬 ID
      answers: ['이름을 라인별 재공 건수로 바꿔 줘', '시험', '저장', '생산관리', 'wip-count-talk'],
    });
    assert.equal(r.code, 0, r.text);
    assert.match(r.text, /시작 화면: /);
    assert.match(r.text, /라인별 재공 건수 \(wip-count/);
    assert.match(r.text, /시험 결과: 성공/);
    const file = join(home, 'skills', 'wip-count-talk', 'SKILL.md');
    assert.ok(existsSync(file), r.text);
    const source = readFileSync(file, 'utf8');
    assert.match(source, /owner: "생산관리"/);
    assert.match(source, /"라인"에서 \{line\}을 선택한다/);

    await open('/wip.html');
    const again = await client(['run', 'wip-count-talk', 'line=8라인']);
    assert.equal(again.code, 0, again.text);
    assert.match(again.text, new RegExp(`총 ${generateWip('8라인').length}건`));
  });

  await scenario('스킬 찾기: 말로 찾기, 지금 화면의 스킬, 자세히 보기, 팀 저장소를 주소로 받기', async () => {
    const hold = await client(['skills', 'search', '홀드', '해제해줘']);
    assert.equal(hold.code, 0, hold.text);
    assert.match(hold.text.split('\n').find((l) => l.includes('[')) ?? '', /hold-release — Lot 홀드 해제 요청/);
    const none = await client(['skills', 'search', '휴가', '신청']);
    assert.equal(none.code, 1);
    assert.match(none.text, /맞는 스킬이 없습니다\. 말로 만들려면: skill new 휴가 신청/);

    await open('/wip.html');
    const here = await client(['skills', 'search']);
    assert.match(here.text, /wip-check — 재공 확인 \(R1\) · 지금 화면/);
    const info = await client(['skills', 'info', 'wip-check']);
    assert.match(info.text, /태그 재공, WIP/);
    assert.match(info.text, /이 PC의 기록: \d+번 실행/); // 앞 시나리오에서 실행했다

    // 팀 저장소: git 없이 index.json 주소로 받는다
    const team = createServer((req, res) => {
      const skill = readFileSync(join(ROOT, 'skills/wip-check/SKILL.md'), 'utf8').replace('id: wip-check', 'id: team-wip').replace('name: 재공 확인', 'name: 팀 재공 확인');
      const body = { '/s/index.json': JSON.stringify({ skills: [{ id: 'team-wip', path: 'team-wip/SKILL.md' }] }), '/s/team-wip/SKILL.md': skill }[req.url];
      res.writeHead(body ? 200 : 404).end(body);
    }).listen(4179);
    try {
      await client(['config', 'teamSkillsUrl', 'http://127.0.0.1:4179/s/index.json']);
      const synced = await client(['sync']);
      assert.equal(synced.code, 0, synced.text);
      assert.match(synced.text, /팀 스킬 1개를 받았습니다/);
      assert.match((await client(['skills'])).text, /\[팀\] team-wip — 팀 재공 확인/);
    } finally {
      team.close();
    }
    // 닿지 않으면 받아 둔 것을 쓴다
    const offline = await client(['sync']);
    assert.match(offline.text, /팀 스킬 저장소에 닿지 못했습니다[\s\S]*받아 둔 1개를 씁니다/);
    assert.match((await client(['skills'])).text, /\[팀\] team-wip/);
    return '홀드·지금 화면·팀 저장소';
  });

  await scenario('시스템 사전: 목록·자세히, 요청에 시스템 이름이 있으면 찾아서 함께 쓰고 팀 저장소의 시스템도 받음', async () => {
    const list = await client(['systems']);
    assert.equal(list.code, 0, list.text);
    assert.match(list.text, /\[기본\] mes — 모의 MES \(생산 관리\) \(MES, 재공 시스템/);
    const info = await client(['systems', 'info', 'mes']);
    assert.match(info.text, /재공 현황 조회 \[재공 > 재공 현황\]/);
    assert.match(info.text, /HOLD: 품질 문제/);
    assert.match(info.text, /이 시스템의 스킬: .*wip-check/);
    assert.equal((await client(['systems', 'info', 'nope'])).code, 1);

    // 맞는 스킬이 없는 요청이라도 시스템 이름이 나오면 그 시스템을 찾아 자유 요청에 설명을 붙인다
    await open('/wip.html');
    const r = await client(['MES에서 8라인을 선택하고 조회해서 총 몇 건인지 알려줘', '--yes']);
    assert.equal(r.code, 0, r.text);
    assert.match(r.text, /시스템: 모의 MES \(생산 관리\)/);
    assert.match(r.text, /맞는 스킬이 없어 지금 브라우저 화면에서 자유 요청으로 합니다/);
    assert.match(r.text, new RegExp(`총 ${generateWip('8라인').length}건`));

    // 시스템 이름이 없는 요청에는 붙이지 않는다
    const plain = await client(['8라인을 선택하고 조회해서 총 몇 건인지 알려줘', '--yes']);
    assert.doesNotMatch(plain.text, /시스템:/);

    // 팀 저장소 목록의 시스템 문서를 받는다 (개인 폴더의 같은 id가 먼저)
    const sys = readFileSync(join(ROOT, 'skills/systems/mes/SYSTEM.md'), 'utf8').replace('id: mes', 'id: team-mes').replace('name: 모의 MES (생산 관리)', 'name: 팀 MES');
    const team = createServer((req, res) => {
      const body = { '/t/index.json': JSON.stringify({ systems: [{ id: 'team-mes', path: 'systems/team-mes/SYSTEM.md' }], skills: [] }), '/t/systems/team-mes/SYSTEM.md': sys }[req.url];
      res.writeHead(body ? 200 : 404).end(body);
    }).listen(4180);
    try {
      await client(['config', 'teamSkillsUrl', 'http://127.0.0.1:4180/t/index.json']);
      const synced = await client(['sync']);
      assert.equal(synced.code, 0, synced.text);
      assert.match((await client(['systems'])).text, /\[팀\] team-mes — 팀 MES/);
    } finally {
      team.close();
    }
    return '목록·자세히·요청에서 찾기·팀 저장소';
  });

  await scenario('새 탭: 요청에 주소가 있으면 열려 있는 탭을 두고 새 탭에서 진행', async () => {
    const known = new Set(context.pages());
    // 열린 새 탭은 남겨 두는 것이 동작이지만, 뒤 시나리오가 헷갈리지 않게 시나리오가 끝나면 닫는다
    const closeNew = () => Promise.all(context.pages().filter((p) => !known.has(p)).map((p) => p.close()));
    try {
      return await newTabScenario(closeNew);
    } finally {
      await closeNew();
      await target.bringToFront();
    }
  });

  async function newTabScenario(closeNew) {
    await open('/portal.html');
    const before = context.pages().length;
    const r = await client([`${SITE}/wip.html 에 들어가서 8라인을 선택하고 조회해서 총 몇 건인지 알려줘`, '--yes']);
    assert.equal(r.code, 0, r.text);
    assert.match(r.text, /새 탭에서 열었습니다: http:\/\/localhost:4173\/wip\.html/);
    assert.match(r.text, new RegExp(`총 ${generateWip('8라인').length}건`));
    assert.ok(context.pages().length > before, '새 탭이 열려야 한다');
    assert.match(target.url(), /portal\.html$/, '원래 탭은 그대로');

    // 이미 그 화면이 열려 있으면 새 탭을 열지 않는다
    await open('/wip.html');
    const same = await client([`${SITE}/wip.html 에서 8라인을 선택하고 조회해서 총 몇 건인지 알려줘`, '--yes']);
    assert.equal(same.code, 0, same.text);
    assert.doesNotMatch(same.text, /새 탭에서 열었습니다/);

    // 스킬도 지금 탭이 스킬의 사이트가 아니면(빈 탭) 시작 주소를 새 탭에서 연다
    await closeNew(); // 앞에서 연 새 탭이 남아 있으면 확장이 그 탭을 지금 탭으로 잡는다
    await target.goto('about:blank');
    await target.bringToFront();
    const skill = await client(['run', 'wip-check', 'line=7라인']);
    assert.equal(skill.code, 0, skill.text);
    assert.match(skill.text, /새 탭에서 열었습니다: http:\/\/localhost:4173\//);
    assert.equal(target.url(), 'about:blank');
    return '주소 요청·같은 화면 재사용·스킬';
  }

  await scenario('dogent doctor: 점검하고 실시간 시험에서 확장이 붙는 것을 확인', async () => {
    // 이 PC의 호스트 등록 상태는 시험과 무관하므로 종료 코드는 보지 않는다
    const r = await client(['doctor']);
    assert.match(r.text, /Dogent 연결 점검/);
    assert.match(r.text, /포트 39312/);
    assert.match(r.text, /\[통과\] 확장이 붙었습니다: .*WebSocket/);
    assert.match(r.text, /결과: /);
    return '확장 연결 확인';
  });

  await scenario('직접 못 읽는 엑셀(xls)은 오피스 도구가 Excel로 열어 화면 표에 채움', async () => {
    if (!existsSync(join(ROOT, 'office/dist/dogent-office.exe'))) return '건너뜀: pnpm office:build 필요';
    // 문서 보안 파일 대신, exceljs가 읽지 못하는 구형 xls로 같은 상황을 만든다.
    const rows = [
      ['P7-00012', 'PHOTO', -25, '검사 불량 폐기'],
      ['P7-00031', 'ETCH', 100, '재작업 투입'],
    ];
    const ExcelJS = (await import('exceljs')).default;
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('조정');
    ws.addRow(['Lot ID', '공정', '조정수량', '사유']);
    for (const r of rows) ws.addRow(r);
    const xlsx = join(home, 'adjust.xlsx');
    const xls = join(home, 'adjust.xls');
    await wb.xlsx.writeFile(xlsx);
    const resave = await client(['excel', 'resave', xlsx, xls]);
    assert.equal(resave.code, 0, resave.text);

    await fetch(`${SITE}/api/adjust`, { method: 'DELETE' });
    await open('/adjust.html');
    const popup = context.waitForEvent('page', { predicate: (p) => p.url().includes('approve.html'), timeout: 60_000 });
    const run = client(['run', 'wip-adjust', `source=${xls}`]);
    const page = await popup;
    await page.locator('#approval').waitFor();
    assert.match(await page.locator('#approval').innerText(), /P7-00031/);
    await page.click('#approve');
    const r = await run;
    assert.equal(r.code, 0, r.text);
    assert.match(r.text, /adjust\.xls: 파일을 직접 읽지 못해.*Excel로 엽니다/);
    const saved = await fetch(`${SITE}/api/adjust`).then((x) => x.json());
    assert.deepEqual(saved, [rows.map((row) => row.map(String))]);
  });

  await scenario('엑셀 요청: 맞는 스킬이 없고 엑셀만 필요하면 브라우저 없이 엑셀 도구로 자유 요청', async () => {
    if (!existsSync(join(ROOT, 'office/dist/dogent-office.exe'))) return '건너뜀: pnpm office:build 필요';
    const ExcelJS = (await import('exceljs')).default;
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('목록');
    ws.addRow(['LOT', '수량']);
    for (const r of [['A1', 10], ['A2', 20], ['A3', 30]]) ws.addRow(r);
    const file = join(home, 'lots.xlsx');
    await wb.xlsx.writeFile(file);
    const r = await client([`${file} 파일을 엑셀로 열어서 정리해줘`, '--yes']);
    assert.equal(r.code, 0, r.text);
    assert.match(r.text, /엑셀 도구로 자유 요청을 합니다 \(브라우저는 쓰지 않습니다\)/);
    assert.match(r.text, /엑셀에서 3행을 읽었습니다/);
    assert.doesNotMatch(r.text, /확장 연결됨/);
    return '브라우저 연결 없이 완료';
  });

  await scenario('브라우저가 둘이면 목록을 보여 주고, --browser로 고른 브라우저를 조작', async () => {
    // 두 번째 브라우저(따로 띄운 Chromium, 확장 설치도 따로)를 같은 클라이언트에 붙인다.
    const second = await chromium.launchPersistentContext(await mkdtemp(join(tmpdir(), 'dogent-client-2-')), {
      channel: 'chromium',
      headless: !HEADED,
      args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
    });
    try {
      const w2 = second.serviceWorkers()[0] ?? (await second.waitForEvent('serviceworker'));
      const p2 = await second.newPage();
      await p2.goto(`chrome-extension://${new URL(w2.url()).host}/sidepanel.html`);
      // 같은 종류의 브라우저가 둘이므로 두 번째에 이름을 붙인다 (설정 → 클라이언트 연결 → 이 브라우저 이름).
      await p2.evaluate((v) => chrome.storage.local.set({ bridgeSettings: v }), { mode: 'ws', port: PORT, token: TOKEN, label: '두 번째 크롬' });
      const t2 = await second.newPage();
      await t2.goto(SITE + '/fw.html');
      await open('/wip.html');

      const list = await client(['browsers']);
      assert.equal(list.code, 0, list.text);
      const ids = [...list.text.matchAll(/\[(\d+)\]/g)].map((m) => m[1]);
      assert.equal(ids.length, 2, list.text);
      assert.match(list.text, /연결된 브라우저 2개/);
      assert.match(list.text, /두 번째 크롬/);
      // 이름으로 고르면 그 브라우저의 탭을 본다. 번호는 실행마다 다시 매겨지므로 명령에는 이름을 쓴다.
      const second2 = await client(['tabs', '--browser', '두 번째']);
      assert.equal(second2.code, 0, second2.text);
      assert.match(second2.text, /fw\.html/);
      assert.doesNotMatch(second2.text, /wip\.html/);
      const first = await client(['tabs', '--browser', 'chromium']);
      assert.equal(first.code, 0, first.text);
      assert.match(first.text, /wip\.html/);
      assert.doesNotMatch(first.text, /fw\.html/);
      // 없는 브라우저를 고르면 연결된 목록을 알려 준다.
      const bad = await client(['tabs', '--browser', 'firefox', '--wait', '2']);
      assert.notEqual(bad.code, 0);
      assert.match(bad.text, /"firefox"에 맞는 브라우저가 없습니다/);
      return list.text.trim().split(/\r?\n/).slice(-2).join(' / ');
    } finally {
      await second.close();
    }
  });

  await scenario('조작할 사이트 밖의 탭에서는 자유 요청이 막힘', async () => {
    await target.goto('http://127.0.0.1:4173/wip.html');
    await target.bringToFront();
    const r = await client(['8라인을 선택하고 조회해서 총 몇 건인지 알려줘', '--yes'], { answers: ['n'] });
    assert.notEqual(r.code, 0, r.text);
    assert.match(r.text, /조작할 사이트 목록에 없습니다/);
    return r.text.trim().split(/\r?\n/).filter((l) => /오류|중단|권한|허용|목록/.test(l)).pop();
  });
} finally {
  await context.close();
  site.close();
  llm.close();
  console.log(`\n결과: 통과 ${tally.pass}, 실패 ${tally.fail}`);
  process.exitCode = tally.fail ? 1 : 0;
}
