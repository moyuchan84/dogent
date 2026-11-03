// 오피스 도구(dogent-office.exe)를 실제 Excel로 돌려 본다. Excel이 설치된 윈도우에서만 돈다.
//
//   pnpm office:build && pnpm e2e:office            숨긴 Excel로 열기·읽기·쓰기·저장
//   pnpm e2e:office --attach                        사용자 Excel에 열린 문서 잡기 (EDM 링크로 연 문서 흉내, Excel 창이 잠깐 뜸)
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import ExcelJS from 'exceljs';

const ROOT = join(import.meta.dirname, '../..');
const EXE = join(ROOT, 'office/dist/dogent-office.exe');
const ATTACH = process.argv.includes('--attach');
// Git Bash 등에서는 PATH에 없을 수 있어 전체 경로로 부른다.
const POWERSHELL = join(process.env.SystemRoot ?? 'C:\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
if (!existsSync(EXE)) throw new Error(`${EXE}가 없습니다. 먼저 pnpm office:build`);

const dir = mkdtempSync(join(tmpdir(), 'dogent-office-'));
const tally = { pass: 0, fail: 0 };
const excelCount = () => {
  try {
    return execFileSync('tasklist', ['/FI', 'IMAGENAME eq EXCEL.EXE', '/NH'], { encoding: 'utf8' }).split('\n').filter((l) => /EXCEL\.EXE/i.test(l)).length;
  } catch {
    return -1;
  }
};

/** 오피스 도구를 띄우고 MCP로 부른다. */
function start() {
  const child = spawn(EXE, [], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  const pending = new Map();
  const logs = [];
  let id = 1;
  createInterface({ input: child.stdout }).on('line', (line) => {
    const msg = JSON.parse(line);
    pending.get(msg.id)?.(msg);
    pending.delete(msg.id);
  });
  createInterface({ input: child.stderr }).on('line', (l) => logs.push(l));
  const request = (method, params = {}) =>
    new Promise((resolve) => {
      const n = id++;
      pending.set(n, resolve);
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: n, method, params })}\n`);
    });
  const call = async (name, args = {}) => {
    const r = await request('tools/call', { name, arguments: args });
    return { text: r.result.content[0].text, error: !!r.result.isError };
  };
  const ok = async (name, args) => {
    const r = await call(name, args);
    assert.equal(r.error, false, `${name}: ${r.text}`);
    return JSON.parse(r.text);
  };
  const stop = () =>
    new Promise((resolve) => {
      child.once('exit', resolve);
      child.stdin.end();
    });
  return { request, call, ok, stop, logs };
}

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

/** 시험용 원본: 재공 시트(글자·숫자·날짜·빈 칸)와 요약 시트 */
async function makeSource(path) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('재공');
  ws.addRow(['Lot ID', '제품', '수량', '입고일', '비고']);
  ws.addRow(['L001', 'DR5', 1200, new Date(Date.UTC(2026, 9, 1)), '']);
  ws.addRow(['L002', 'NV2-1T', 850.5, new Date(Date.UTC(2026, 9, 2)), 'HOLD']);
  ws.addRow(['L003', '00123', 0, new Date(Date.UTC(2026, 9, 3)), '']);
  ws.getColumn(4).numFmt = 'yyyy-mm-dd';
  ws.getCell('B4').numFmt = '@';
  const sum = wb.addWorksheet('요약');
  sum.addRow(['공정', '합계']);
  sum.addRow(['PHOTO', 5]);
  await wb.xlsx.writeFile(path);
}

const source = join(dir, '재공_원본.xlsx');
await makeSource(source);
const before = excelCount();
const office = start();

try {
  await scenario('MCP 시작과 도구 목록', async () => {
    const init = await office.request('initialize', { protocolVersion: '2025-06-18' });
    assert.equal(init.result.serverInfo.name, 'dogent-office');
    const names = (await office.request('tools/list')).result.tools.map((t) => t.name);
    for (const n of ['excel_open', 'excel_read', 'excel_write', 'excel_save', 'excel_close', 'excel_attach', 'excel_user_workbooks']) assert.ok(names.includes(n), n);
    return `도구 ${names.length}개`;
  });

  let wb;
  await scenario('열기: 시트 목록과 사용 범위', async () => {
    const r = await office.ok('excel_open', { path: source });
    wb = r.workbook;
    assert.deepEqual(r.sheets.map((s) => [s.name, s.range]), [['재공', 'A1:E4'], ['요약', 'A1:B2']]);
  });

  await scenario('읽기: 머리글, 숫자, 날짜, 앞자리 0, 빈 칸', async () => {
    const r = await office.ok('excel_read', { workbook: wb });
    assert.deepEqual(r.columns, ['Lot ID', '제품', '수량', '입고일', '비고']);
    assert.equal(r.total_rows, 3);
    assert.deepEqual(r.rows[0], ['L001', 'DR5', 1200, '2026-10-01', '']);
    assert.deepEqual(r.rows[1], ['L002', 'NV2-1T', 850.5, '2026-10-02', 'HOLD']);
    assert.equal(r.rows[2][1], '00123');
  });

  await scenario('읽기: 다른 시트와 범위, 최대 행 수', async () => {
    assert.deepEqual((await office.ok('excel_read', { workbook: wb, sheet: '요약' })).rows, [['PHOTO', 5]]);
    const part = await office.ok('excel_read', { workbook: wb, range: 'A1:B3', max_rows: 1 });
    assert.deepEqual(part.columns, ['Lot ID', '제품']);
    assert.equal(part.total_rows, 2);
    assert.equal(part.rows.length, 1);
  });

  await scenario('읽기 전용 문서는 그 자리에 저장하지 않음', async () => {
    const r = await office.call('excel_save', { workbook: wb });
    assert.equal(r.error, true);
    assert.match(r.text, /읽기 전용/);
    await office.ok('excel_close', { workbook: wb });
  });

  const out = join(dir, '결과.xlsx');
  await scenario('새 문서에 쓰고 다른 이름으로 저장 → 파일 내용 확인', async () => {
    const { workbook } = await office.ok('excel_new');
    const w = await office.ok('excel_write', {
      workbook,
      sheet: '결과',
      start: 'B2',
      columns: ['Lot ID', '수량', '상태'],
      rows: [
        ['L001', 1200, '정상'],
        ['L002', 850.5, 'HOLD'],
      ],
    });
    assert.equal(w.range, 'B2:D4');
    await office.ok('excel_save', { workbook, path: out });
    await office.ok('excel_close', { workbook });
    const check = new ExcelJS.Workbook();
    await check.xlsx.readFile(out);
    const ws = check.getWorksheet('결과');
    assert.ok(ws, '결과 시트');
    assert.deepEqual([ws.getCell('B2').value, ws.getCell('C3').value, ws.getCell('D4').value], ['Lot ID', 1200, 'HOLD']);
  });

  await scenario('있는 파일은 overwrite 없이 덮어쓰지 않음', async () => {
    const { workbook } = await office.ok('excel_open', { path: out, read_only: false });
    const r = await office.call('excel_save', { workbook, path: source });
    assert.equal(r.error, true);
    assert.match(r.text, /이미 있는 파일/);
    await office.ok('excel_write', { workbook, sheet: '결과', start: 'F2', rows: [['고침']] });
    await office.ok('excel_save', { workbook });
    await office.ok('excel_close', { workbook });
    const check = new ExcelJS.Workbook();
    await check.xlsx.readFile(out);
    assert.equal(check.getWorksheet('결과').getCell('F2').value, '고침');
  });

  await scenario('없는 파일, 상대 경로, 모르는 문서 번호는 이유를 알려 줌', async () => {
    assert.match((await office.call('excel_open', { path: join(dir, '없음.xlsx') })).text, /파일이 없습니다/);
    assert.match((await office.call('excel_open', { path: '재공.xlsx' })).text, /전체 경로/);
    assert.match((await office.call('excel_read', { workbook: 'wb99' })).text, /excel_open으로 먼저/);
  });

  // ---- Word·PowerPoint ----
  /** docx·pptx 안의 파일 하나를 태그를 뗀 글로 꺼낸다 (zip이라 윈도우 tar로 읽는다. Word는 글자를 여러 조각으로 나눠 저장한다). */
  const unzip = (file, inner) => execFileSync(join(process.env.SystemRoot ?? 'C:\Windows', 'System32/tar.exe'), ['-xOf', file, inner], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).replace(/<[^>]+>/g, '');

  await scenario('Word·PowerPoint 도구가 목록에 있음', async () => {
    const names = (await office.request('tools/list')).result.tools.map((t) => t.name);
    for (const n of ['word_open', 'word_read', 'word_write', 'word_save', 'word_attach', 'ppt_open', 'ppt_read', 'ppt_write', 'ppt_save', 'ppt_attach']) assert.ok(names.includes(n), n);
  });

  const docx = join(dir, '보고서.docx');
  await scenario('Word: 새 문서에 문단·표를 쓰고 저장 → 파일 내용 확인', async () => {
    const { doc } = await office.ok('word_new');
    const w = await office.ok('word_write', {
      doc,
      append: [{ text: '재공 현황', style: 'heading1' }, '이번 주 HOLD Lot은 1건입니다.', { text: '확인 필요', style: 'bullet' }],
      table: { columns: ['Lot ID', '수량'], rows: [['L001', 1200], ['L002', 850]] },
    });
    assert.equal(w.appended_paragraphs, 3);
    assert.equal(w.appended_table_rows, 2);
    await office.ok('word_save', { doc, path: docx });
    await office.ok('word_close', { doc });
    const xml = unzip(docx, 'word/document.xml');
    for (const s of ['재공 현황', 'HOLD Lot은 1건', 'L002', '850']) assert.ok(xml.includes(s), `docx에 ${s}`);
  });

  await scenario('Word: 열어서 읽기(문단·스타일·표) → 찾아 바꾸기 → 읽기 전용은 쓰지 않음', async () => {
    const ro = await office.ok('word_open', { path: docx });
    const w = await office.call('word_write', { doc: ro.doc, replace: [{ find: 'HOLD', with: '정상' }] });
    assert.equal(w.error, true);
    assert.match(w.text, /읽기 전용/);
    await office.ok('word_close', { doc: ro.doc });

    const { doc, tables } = await office.ok('word_open', { path: docx, read_only: false });
    assert.equal(tables, 1);
    const r = await office.ok('word_read', { doc });
    assert.ok(r.paragraphs.some((p) => p.text === '재공 현황'), '제목 문단');
    assert.ok(!r.paragraphs.some((p) => p.text === 'L001'), '표 안의 글은 문단에 안 나옴');
    assert.deepEqual(r.tables[0].columns, ['Lot ID', '수량']);
    assert.deepEqual(r.tables[0].rows, [['L001', '1200'], ['L002', '850']]);
    const e = await office.ok('word_write', { doc, replace: [{ find: 'HOLD', with: '정상' }, { find: '없는글', with: 'x' }] });
    assert.equal(e.replaced, 1);
    const out = join(dir, '보고서_수정.docx');
    await office.ok('word_save', { doc, path: out });
    await office.ok('word_close', { doc });
    const xml = unzip(out, 'word/document.xml');
    assert.ok(xml.includes('정상 Lot은 1건'), '바뀐 글');
    assert.ok(!xml.includes('HOLD Lot'), '이전 글 없음');
    const again = await office.call('word_save', { doc: 'wd99' });
    assert.match(again.text, /word_open으로 먼저/);
  });

  const pptx = join(dir, '발표.pptx');
  await scenario('PowerPoint: 새 자료에 슬라이드를 쓰고 저장 → 파일 내용 확인', async () => {
    const { doc } = await office.ok('ppt_new');
    const w = await office.ok('ppt_write', {
      doc,
      slides: [
        { title: '재공 현황', bullets: ['HOLD 1건', '정상 2건'], notes: '발표 때 HOLD부터 설명' },
        { title: 'Lot 표', table: { columns: ['Lot ID', '수량'], rows: [['L001', 1200], ['L002', 850]] } },
      ],
    });
    assert.equal(w.added_slides, 2);
    await office.ok('ppt_save', { doc, path: pptx });
    await office.ok('ppt_close', { doc });
    assert.ok(unzip(pptx, 'ppt/slides/slide1.xml').includes('HOLD 1건'));
    assert.ok(unzip(pptx, 'ppt/slides/slide2.xml').includes('L002'));
  });

  await scenario('PowerPoint: 읽기(제목·글·표·메모) → 찾아 바꾸기 → 저장', async () => {
    const { doc, slides } = await office.ok('ppt_open', { path: pptx, read_only: false });
    assert.ok(slides >= 2, `슬라이드 ${slides}`);
    const r = await office.ok('ppt_read', { doc });
    const s1 = r.slides.find((s) => s.title === '재공 현황');
    assert.ok(s1, '첫 슬라이드 제목');
    assert.ok(s1.texts.join('\n').includes('HOLD 1건'), '본문');
    assert.equal(s1.notes, '발표 때 HOLD부터 설명');
    const s2 = r.slides.find((s) => s.title === 'Lot 표');
    assert.deepEqual(s2.tables[0].columns, ['Lot ID', '수량']);
    assert.deepEqual(s2.tables[0].rows[1], ['L002', '850']);
    const e = await office.ok('ppt_write', { doc, replace: [{ find: 'HOLD', with: '점검' }], notes: [{ slide: 2, text: '표는 읽어만 준다' }] });
    assert.ok(e.replaced >= 1);
    assert.equal(e.notes_set, 1);
    const out = join(dir, '발표_수정.pptx');
    await office.ok('ppt_save', { doc, path: out });
    await office.ok('ppt_close', { doc });
    assert.ok(unzip(out, 'ppt/slides/slide1.xml').includes('점검 1건'));
    const ow = await office.call('ppt_save', { doc: 'pp99' });
    assert.match(ow.text, /ppt_open으로 먼저/);
  });

  if (ATTACH) {
    await scenario('Word·PowerPoint: 사용자 프로그램에 열린 문서를 잡아 읽고 저장, 닫아도 사용자 문서는 남음', async () => {
      const stamp = Date.now();
      // 시험이 띄운 Word·PowerPoint만 정리하려고 시작 전 프로세스 번호를 적어 둔다 (사용자가 쓰던 창은 건드리지 않는다).
      const officePids = () => execFileSync(POWERSHELL, ['-NoProfile', '-Command', "(Get-Process WINWORD,POWERPNT -ErrorAction SilentlyContinue | ForEach-Object { $_.Id }) -join ','"], { encoding: 'utf8' }).trim().split(',').filter(Boolean);
      const before = new Set(officePids());
      const wd = join(dir, `edm-워드-${stamp}.docx`);
      const pp = join(dir, `edm-발표-${stamp}.pptx`);
      await fs.copyFile(docx, wd);
      await fs.copyFile(pptx, pp);
      // 이 PC에 .docx·.pptx 연결 프로그램이 없을 수 있어 Start-Process 대신 사용자가 프로그램을 띄워 문서를 연 것처럼 COM으로 연다 (띄운 프로그램은 창을 둔 채 남는다).
      execFileSync(POWERSHELL, ['-NoProfile', '-Command', `$a=New-Object -ComObject Word.Application; $a.Visible=$true; $null=$a.Documents.Open("${wd}")`]);
      execFileSync(POWERSHELL, ['-NoProfile', '-Command', `$a=New-Object -ComObject PowerPoint.Application; $a.Visible=-1; $null=$a.Presentations.Open("${pp}")`]);
      const w = await office.ok('word_attach', { name: `edm-워드-${stamp}`, wait_sec: 60 });
      assert.equal(w.attached, true);
      assert.ok((await office.ok('word_read', { doc: w.doc })).paragraphs.length > 0);
      await office.ok('word_write', { doc: w.doc, append: ['EDM에서 추가'] });
      await office.ok('word_save', { doc: w.doc });
      const nonPdf = await office.call('word_save', { doc: w.doc, path: join(dir, 'x.docx') });
      assert.equal(nonPdf.error, true, '사용자의 Word 문서는 PDF 사본만');
      await office.ok('word_save', { doc: w.doc, path: join(dir, `edm-${stamp}.pdf`) });
      await office.ok('word_close', { doc: w.doc });

      const p = await office.ok('ppt_attach', { name: `edm-발표-${stamp}`, wait_sec: 60 });
      assert.equal(p.attached, true);
      assert.ok((await office.ok('ppt_read', { doc: p.doc })).slides.length >= 2);
      await office.ok('ppt_write', { doc: p.doc, slides: [{ title: 'EDM에서 추가', bullets: ['완료'] }] });
      await office.ok('ppt_save', { doc: p.doc });
      const copy = join(dir, `edm-사본-${stamp}.pptx`);
      await office.ok('ppt_save', { doc: p.doc, path: copy });
      assert.ok(unzip(copy, 'ppt/slides/slide3.xml').includes('EDM에서 추가'));
      await office.ok('ppt_close', { doc: p.doc });

      assert.ok((await office.ok('word_user_docs')).some((b) => b.name === `edm-워드-${stamp}.docx`), '사용자 Word 문서가 그대로 열려 있음');
      assert.ok((await office.ok('ppt_user_docs')).some((b) => b.name === `edm-발표-${stamp}.pptx`), '사용자 PowerPoint 문서가 그대로 열려 있음');
      // 정리: 시험으로 연 문서만 닫는다.
      for (const f of [wd, pp]) {
        execFileSync(POWERSHELL, ['-NoProfile', '-Command', `$d=[Runtime.InteropServices.Marshal]::BindToMoniker("${f}"); $app=$d.Application; $d.Close(); if (($app.Documents -ne $null -and $app.Documents.Count -eq 0) -or ($app.Presentations -ne $null -and $app.Presentations.Count -eq 0)) { $app.Quit() }`]);
      }
      assert.ok(unzip(wd, 'word/document.xml').includes('EDM에서 추가'), '저장한 Word 내용');
      // 문서를 닫아도 시험이 띄운 프로그램이 남으므로 새로 생긴 프로세스만 끝낸다.
      const fresh = officePids().filter((p) => !before.has(p));
      if (fresh.length) execFileSync(POWERSHELL, ['-NoProfile', '-Command', `Stop-Process -Id ${fresh.join(',')} -Force -ErrorAction SilentlyContinue`]);
    });
  }

  if (ATTACH) {
    await scenario('EDM처럼 사용자 Excel에 열린 문서를 잡아 읽고 저장, 닫아도 사용자 문서는 남음', async () => {
      // 같은 이름의 문서가 이미 열려 있으면 Excel이 열지 않으므로 이름을 매번 다르게 한다.
      const edmName = `edm-공유문서-${Date.now()}.xlsx`;
      const edm = join(dir, edmName);
      await makeSource(edm);
      // 문서 공유망의 "편집" 버튼이 하는 일: 사용자의 Excel이 문서를 연다.
      execFileSync(POWERSHELL, ['-NoProfile', '-Command', `Start-Process -FilePath "${edm}"`]);
      const r = await office.ok('excel_attach', { name: 'edm-공유', wait_sec: 60 });
      assert.equal(r.attached, true);
      assert.equal(r.read_only, false);
      const rows = await office.ok('excel_read', { workbook: r.workbook });
      assert.equal(rows.total_rows, 3);
      await office.ok('excel_write', { workbook: r.workbook, sheet: '재공', start: 'F1', rows: [['확인'], ['완료']] });
      await office.ok('excel_save', { workbook: r.workbook });
      // 다른 이름으로 저장은 사본만 만든다. 사용자 창의 문서 이름이 바뀌면 안 된다.
      const copy = join(dir, `edm-사본-${Date.now()}.xlsx`);
      await office.ok('excel_write', { workbook: r.workbook, sheet: '재공', start: 'G1', rows: [['사본만']] });
      await office.ok('excel_save', { workbook: r.workbook, path: copy });
      const copied = new ExcelJS.Workbook();
      await copied.xlsx.readFile(copy);
      assert.equal(copied.getWorksheet('재공').getCell('G1').value, '사본만');
      const csv = await office.call('excel_save', { workbook: r.workbook, path: join(dir, 'x.csv') });
      assert.equal(csv.error, true, '다른 형식의 사본 저장은 거절');
      assert.match(csv.text, /같은 형식/);
      await office.ok('excel_close', { workbook: r.workbook });
      const listed = await office.ok('excel_user_workbooks');
      assert.ok(listed.some((b) => b.name === edmName), '사용자 문서가 그대로 열려 있음');
      // 정리: 시험으로 연 사용자 문서만 닫는다.
      execFileSync(POWERSHELL, [
        '-NoProfile',
        '-Command',
        `$wb=[Runtime.InteropServices.Marshal]::BindToMoniker("${edm}"); $app=$wb.Application; $wb.Close($false); if ($app.Workbooks.Count -eq 0) { $app.Quit() }`,
      ]);
      const check = new ExcelJS.Workbook();
      await check.xlsx.readFile(edm);
      assert.equal(check.getWorksheet('재공').getCell('F2').value, '완료');
    });
  }
} finally {
  await office.stop();
}

await scenario('끝나면 이 도구가 띄운 Excel도 끝남', async () => {
  for (let i = 0; i < 20 && excelCount() > before; i++) await new Promise((r) => setTimeout(r, 500));
  assert.equal(excelCount(), before, `EXCEL.EXE 수: 전 ${before}, 후 ${excelCount()}`);
});

console.log(`\n결과: 통과 ${tally.pass}, 실패 ${tally.fail}`);
process.exitCode = tally.fail ? 1 : 0;
