// 확장이 새 판으로 덮어쓴 폴더를 알아채고 스스로 다시 읽는지 크로미움에서 확인한다 (src/ext/self-update.ts).
//
//   node tests/e2e/self-update.e2e.mjs
//
// 1. 확장을 빌드해 임시 폴더에 복사하고 로드한다
// 2. 같은 판이면 패널을 열어도 다시 읽지 않는다
// 3. 다시 빌드(새 표시)해 같은 폴더를 덮어쓰면(설치 프로그램이 하는 일) 패널을 열 때 다시 읽는다 (열린 확장 페이지가 닫힌다)
//
// 한계: 자동화로 넣은 확장(--load-extension, DevTools의 Extensions.loadUnpacked)은 runtime.reload()에 다시 올라오지 않고 꺼진다.
// 확장 관리 화면의 "압축해제된 확장 프로그램 로드"로 넣은 확장은 같은 폴더에서 다시 올라온다. 그래서 여기서는 다시 읽기를
// 부르는 데까지 확인하고, 다시 올라온 뒤는 사람 PC에서 한 번 확인한다 (docs/12 설치 안내의 "업데이트").
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';

const ROOT = join(import.meta.dirname, '../..');
const OUT = join(ROOT, '.output/chrome-mv3');
const wxt = join(ROOT, 'node_modules/.bin', process.platform === 'win32' ? 'wxt.CMD' : 'wxt');
const build = () => {
  execFileSync(process.platform === 'win32' ? `"${wxt}" build` : `${wxt} build`, { cwd: ROOT, stdio: 'ignore', shell: true });
  return JSON.parse(readFileSync(join(OUT, 'build.json'), 'utf8')).stamp;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const ext = mkdtempSync(join(tmpdir(), 'dogent-ext-'));
const profile = mkdtempSync(join(tmpdir(), 'dogent-profile-'));
const first = build();
cpSync(OUT, ext, { recursive: true });

const context = await chromium.launchPersistentContext(profile, {
  channel: 'chromium',
  headless: true,
  args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`],
});
try {
  const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
  const id = new URL(worker.url()).host;

  /** 패널을 열어 확인을 요청한다. 백그라운드가 지금 코드의 표시를 돌려주면 그 값, 다시 읽혀 패널이 닫히면 'reloaded' */
  async function openPanel() {
    const page = await context.newPage();
    const closed = new Promise((r) => page.once('close', () => r('reloaded')));
    await page.goto(`chrome-extension://${id}/sidepanel.html`).catch(() => {});
    const asked = page.evaluate(() => chrome.runtime.sendMessage({ type: 'dogent:check-update' }).then((r) => r?.stamp ?? null)).catch(() => null);
    const out = await Promise.race([closed, asked.then((s) => s ?? closed), sleep(10_000).then(() => 'timeout')]);
    await page.close().catch(() => {});
    return out;
  }

  assert.equal(await openPanel(), first);
  assert.equal(await openPanel(), first, '같은 판인데 다시 읽었습니다');
  console.log(`  ✓ 같은 판(${first})이면 그대로 둔다`);

  const second = build();
  assert.notEqual(second, first);
  cpSync(OUT, ext, { recursive: true, force: true });
  console.log(`  폴더를 새 판(${second})으로 덮어씀`);
  // 돌고 있는 옛 코드도 덮어쓴 build.json을 읽는다 (압축해제 확장은 파일을 그때그때 읽는다)
  assert.equal(await worker.evaluate(async () => (await (await fetch('/build.json', { cache: 'no-store' })).json()).stamp), second);
  assert.equal(await openPanel(), 'reloaded', '새 판을 알아채고 다시 읽지 않았습니다');
  console.log('  ✓ 패널을 열자 새 판을 알아채고 다시 읽었다');
} finally {
  await context.close();
  rmSync(ext, { recursive: true, force: true });
  rmSync(profile, { recursive: true, force: true });
}
console.log('통과');
