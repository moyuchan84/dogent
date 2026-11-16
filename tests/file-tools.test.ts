import { createServer, type Server } from 'node:http';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateRawSync } from 'node:zlib';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { ClientConfig } from '../client/src/config';
import type { Session as SessionType, Ui } from '../client/src/session';
import { checkAttachment, globRegex, localFilesPort, parseFile, parseOfficeXml, readZip } from '../client/src/files';
import { checkUploadPath } from '../client/src/upload';
import { actionSchema, buildFreeSkill, buildWorkbook, fileIntent, runSkill, schemaTools, type FilePort, type LocalFilesPort } from '../src/core';
import { scriptedLlm } from './helpers';

/** 시험용 ZIP (docx·pptx). 항목은 deflate로 담는다. CRC는 읽는 쪽이 보지 않으므로 0 */
function makeZip(entries: Record<string, string>): Uint8Array {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, text] of Object.entries(entries)) {
    const nameBuf = Buffer.from(name, 'utf8');
    const data = deflateRawSync(Buffer.from(text, 'utf8'));
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(Buffer.byteLength(text), 22);
    local.writeUInt16LE(nameBuf.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(Buffer.byteLength(text), 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, nameBuf, data);
    centrals.push(central, nameBuf);
    offset += 30 + nameBuf.length + data.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(entries).length, 8);
  end.writeUInt16LE(Object.keys(entries).length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return new Uint8Array(Buffer.concat([...locals, cd, end]));
}

/** 시험용 PDF: 쪽마다 Helvetica로 글 한 줄. 빈 글이면 그 쪽에는 글이 없다 (스캔한 그림처럼) */
function makePdf(pages: string[]): Uint8Array {
  const objs: string[] = [];
  const kids = pages.map((_, i) => `${4 + i * 2} 0 R`).join(' ');
  objs.push('<< /Type /Catalog /Pages 2 0 R >>');
  objs.push(`<< /Type /Pages /Kids [${kids}] /Count ${pages.length} >>`);
  objs.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  pages.forEach((text, i) => {
    const stream = text ? `BT /F1 18 Tf 72 720 Td (${text}) Tj ET` : '';
    objs.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${5 + i * 2} 0 R >>`);
    objs.push(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
  });
  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  objs.forEach((o, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(out);
}

const DOCX_XML =`<?xml version="1.0"?><w:document xmlns:w="x"><w:body>
<w:p><w:pPr><w:tabs><w:tab w:val="left" w:pos="100"/></w:tabs></w:pPr><w:r><w:t>재공 조정 요청서</w:t></w:r></w:p>
<w:p><w:r><w:t xml:space="preserve">요청자: </w:t></w:r><w:r><w:t>홍길동 &amp; 팀</w:t></w:r></w:p>
<w:tbl><w:tr><w:tc><w:p><w:r><w:t>Lot ID</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>조정수량</w:t></w:r></w:p></w:tc></w:tr>
<w:tr><w:tc><w:p><w:r><w:t>P7-00001</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>5</w:t></w:r></w:p></w:tc></w:tr></w:tbl>
<w:p><w:r><w:t>끝.</w:t></w:r></w:p></w:body></w:document>`;

const slide = (title: string) => `<p:sld xmlns:a="a" xmlns:p="p"><a:p><a:r><a:t>${title}</a:t></a:r></a:p><a:p><a:r><a:t>본문</a:t></a:r><a:br/><a:r><a:t>둘째 줄</a:t></a:r></a:p></p:sld>`;

/** 임시 폴더 구조: 읽을 수 있는 폴더(ok), 밖의 폴더(outside) */
function tree() {
  const root = mkdtempSync(join(tmpdir(), 'dogent-files-'));
  const ok = join(root, 'ok');
  const outside = join(root, 'outside');
  mkdirSync(join(ok, 'sub'), { recursive: true });
  mkdirSync(join(ok, '.secret'), { recursive: true });
  mkdirSync(outside, { recursive: true });
  writeFileSync(join(ok, 'memo.txt'), '첫 줄\n둘째 줄');
  writeFileSync(join(ok, 'sub', 'b.csv'), 'a,b\n1,2');
  writeFileSync(join(ok, '.secret', 'x.txt'), 'x');
  writeFileSync(join(ok, 'id_rsa'), 'key');
  writeFileSync(join(ok, 'creds.pem'), 'key');
  writeFileSync(join(outside, 'plan.txt'), '밖의 파일');
  writeFileSync(join(outside, 'other.txt'), '다른 파일');
  return { root, ok, outside };
}

describe('파일 읽기 (형식)', () => {
  it('CSV는 EUC-KR도 읽고, 머리글이 비거나 겹쳐도 표로 만든다. TSV도 표', async () => {
    const euc = new Uint8Array([0xb6, 0xf3, 0xc0, 0xce, 0x2c, 0x2c, 0x6e, 0x0a, 0x37, 0x2c, 0x31, 0x2c, 0x32]); // "라인,,n\n7,1,2"
    const csv = await parseFile('C:/x/a.csv', euc);
    expect(csv.tables[0]).toEqual({ columns: ['라인', '열2', 'n'], rows: [['7', '1', '2']] });
    const tsv = await parseFile('C:/x/a.tsv', new TextEncoder().encode('a\ta\n1\t2'));
    expect(tsv.tables[0].columns).toEqual(['a', 'a_2']);
  });

  it('엑셀은 시트를 골라 읽고 시트 이름들을 알려 준다. ZIP이 아니면 문서 보안 안내', async () => {
    const book = new Uint8Array(await buildWorkbook([
      { name: '원본', dataset: { columns: ['Lot', '수량'], rows: [['A', 1]] } },
      { name: '요약', dataset: { columns: ['합계'], rows: [[1]] } },
    ]));
    const first = await parseFile('C:/x/b.xlsx', book);
    expect(first).toMatchObject({ sheets: ['원본', '요약'], sheet: '원본', tables: [{ columns: ['Lot', '수량'], rows: [['A', 1]] }] });
    expect((await parseFile('C:/x/b.xlsx', book, { sheet: '요약' })).tables[0].columns).toEqual(['합계']);
    await expect(parseFile('C:/x/b.xlsx', book, { sheet: '없음' })).rejects.toThrow(/시트 "없음"가 없습니다. 시트: 원본, 요약/);
    await expect(parseFile('C:/x/drm.xlsx', new TextEncoder().encode('DRMONE....'))).rejects.toThrow(/문서 보안.*excel_read/);
    await expect(parseFile('C:/x/old.xls', new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0]))).rejects.toThrow(/예전 형식/);
  });

  it('워드는 문단과 표를, 파워포인트는 슬라이드 순서대로 글을 읽는다', async () => {
    const docx = await parseFile('C:/x/req.docx', makeZip({ '[Content_Types].xml': '<x/>', 'word/document.xml': DOCX_XML }));
    expect(docx.text).toBe('재공 조정 요청서\n요청자: 홍길동 & 팀\n| Lot ID | 조정수량 |\n| P7-00001 | 5 |\n끝.');
    expect(docx.tables).toEqual([{ columns: ['Lot ID', '조정수량'], rows: [['P7-00001', '5']] }]);
    const pptx = await parseFile('C:/x/s.pptx', makeZip({ 'ppt/slides/slide10.xml': slide('열'), 'ppt/slides/slide2.xml': slide('둘'), 'ppt/slides/slide1.xml': slide('하나') }));
    expect(pptx.text?.split('\n\n').map((p) => p.split('\n')[0])).toEqual(['## 슬라이드 1', '## 슬라이드 2', '## 슬라이드 10']);
    expect(pptx.text).toContain('본문\n둘째 줄');
  });

  it('표 안의 표는 바깥 칸의 글로 합친다', () => {
    const xml = '<w:tbl><w:tr><w:tc><w:p><w:r><w:t>바깥</w:t></w:r></w:p><w:tbl><w:tr><w:tc><w:p><w:r><w:t>안</w:t></w:r></w:p></w:tc></w:tr></w:tbl></w:tc></w:tr><w:tr><w:tc><w:p><w:r><w:t>2</w:t></w:r></w:p></w:tc></w:tr></w:tbl>';
    expect(parseOfficeXml(xml, 'w').tables).toEqual([{ columns: ['바깥\n안'], rows: [['2']] }]);
  });

  it('PDF는 쪽마다 글을 읽고, 글이 없거나 PDF가 아니면 이유를 알린다', async () => {
    const pdf = await parseFile('C:/x/report.pdf', makePdf(['Line 7 WIP report', 'Total 128 lots']));
    expect(pdf.format).toBe('pdf');
    expect(pdf.text).toBe('## 1쪽\nLine 7 WIP report\n\n## 2쪽\nTotal 128 lots');
    expect((await parseFile('C:/x/one.pdf', makePdf(['Only page']))).text).toBe('Only page');
    await expect(parseFile('C:/x/scan.pdf', makePdf(['']))).rejects.toThrow(/글이 없는 PDF/);
    await expect(parseFile('C:/x/drm.pdf', new TextEncoder().encode('DRMONE encrypted'))).rejects.toThrow(/PDF 형식이 아닙니다/);
  });

  it('그림·실행 파일은 읽지 않고 이유를 알린다. HTML은 글만', async () => {
    await expect(parseFile('C:/x/a.exe', new Uint8Array([0x4d, 0x5a]))).rejects.toThrow(/읽지 않습니다/);
    await expect(parseFile('C:/x/a.bin', new Uint8Array([1, 0, 2]))).rejects.toThrow(/글 파일이 아니라/);
    const html = await parseFile('C:/x/a.html', new TextEncoder().encode('<html><script>x()</script><p>안녕 &amp; 반가워</p><div>둘</div></html>'));
    expect(html.text).toBe('안녕 & 반가워\n둘');
  });

  it('ZIP의 저장(0) 항목도 읽는다', () => {
    const z = makeZip({ 'a.xml': '<a/>' });
    expect(new TextDecoder().decode(readZip(z).get('a.xml'))).toBe('<a/>');
  });
});

describe('파일 읽기 (경로 정책)', () => {
  it('읽을 수 있는 폴더 안만 읽고, 밖·숨김 폴더·키 파일은 거절한다', async () => {
    const t = tree();
    const port = localFilesPort({ dirs: () => [t.ok], attached: () => [] });
    expect((await port.read(join(t.ok, 'memo.txt'))).text).toBe('첫 줄\n둘째 줄');
    expect((await port.read('sub/b.csv')).tables[0].columns).toEqual(['a', 'b']);
    await expect(port.read(join(t.outside, 'plan.txt'))).rejects.toThrow(/읽을 수 있는 폴더 밖/);
    await expect(port.read(join(t.ok, '..', 'outside', 'plan.txt'))).rejects.toThrow(/폴더 밖/);
    await expect(port.read(join(t.ok, '.secret', 'x.txt'))).rejects.toThrow(/숨김 폴더.*읽지 않습니다/);
    await expect(port.read(join(t.ok, 'id_rsa'))).rejects.toThrow(/키·접속 정보/);
    await expect(port.read('없는.txt')).rejects.toThrow(/찾지 못했습니다/);
  });

  it('첨부한 파일은 폴더 밖이어도 그 파일만, 이름만으로도 읽는다. 첨부한 폴더는 그 안을 읽는다', async () => {
    const t = tree();
    const attached = [{ path: join(t.outside, 'plan.txt'), dir: false }];
    const port = localFilesPort({ dirs: () => [t.ok], attached: () => attached });
    expect((await port.read('plan.txt')).text).toBe('밖의 파일');
    await expect(port.read(join(t.outside, 'other.txt'))).rejects.toThrow(/폴더 밖/);
    expect(port.attached()).toEqual([join(t.outside, 'plan.txt')]);
    attached.push({ path: t.outside, dir: true });
    expect((await port.read(join(t.outside, 'other.txt'))).text).toBe('다른 파일');
    expect(port.roots()).toEqual([t.ok, t.outside]);
  });

  it('목록은 폴더 먼저, 숨김·키 파일은 빼고, pattern으로 거른다', async () => {
    const t = tree();
    const port = localFilesPort({ dirs: () => [t.ok], attached: () => [] });
    const all = await port.list(t.ok);
    expect(all.entries.map((e) => e.name)).toEqual(['sub', 'memo.txt']);
    expect((await port.list(t.ok, '*.TXT')).entries.map((e) => e.name)).toEqual(['memo.txt']);
    await expect(port.list(t.outside)).rejects.toThrow(/폴더 밖/);
    await expect(port.list(join(t.ok, 'memo.txt'))).rejects.toThrow(/폴더가 아닙니다/);
    expect(globRegex('재공*.xlsx').test('재공확인_7라인.XLSX')).toBe(true);
  });

  it('첨부할 경로를 확인한다', async () => {
    const t = tree();
    expect(await checkAttachment(join(t.outside, 'plan.txt'))).toEqual({ path: join(t.outside, 'plan.txt'), dir: false });
    expect(await checkAttachment(t.outside)).toEqual({ path: t.outside, dir: true });
    expect(await checkAttachment('plan.txt')).toEqual({ error: expect.stringMatching(/전체 경로/) });
    expect(await checkAttachment(join(t.ok, 'creds.pem'))).toEqual({ error: expect.stringMatching(/키·접속 정보/) });
    expect(await checkAttachment(join(t.ok, 'nope.txt'))).toEqual({ error: expect.stringMatching(/없는 파일/) });
  });

  it('첨부한 파일은 올릴 수 있는 폴더 밖이어도 올릴 수 있다', async () => {
    const t = tree();
    const file = join(t.outside, 'plan.txt');
    await expect(checkUploadPath(file, { dirs: [t.ok] })).rejects.toThrow(/올릴 수 있는 폴더 밖/);
    expect((await checkUploadPath(file, { dirs: [t.ok], files: () => [file] })).name).toBe('plan.txt');
    await expect(checkUploadPath(join(t.outside, 'other.txt'), { dirs: [t.ok], files: () => [file] })).rejects.toThrow(/폴더 밖/);
  });
});

describe('실행에서 파일 도구', () => {
  const ui = { ask: async () => '', approve: async () => false };
  const saved = () => {
    const m = new Map<string, string>();
    const files: FilePort = { save: async (name, data) => void m.set(name, new TextDecoder('utf-8', { ignoreBOM: true }).decode(data)) };
    return { m, files };
  };
  const noBrowser = { snapshot: async () => ({ url: '', title: '', hasPassword: false, items: [] }) } as never;

  it('파일의 표를 읽어 가공하고 CSV·JSON·MD로 쓴다 (브라우저 없이)', async () => {
    const t = tree();
    writeFileSync(join(t.ok, '조정.csv'), 'Lot ID,수량\nP1,5\nP2,-3\n');
    const localFiles = localFilesPort({ dirs: () => [t.ok], attached: () => [] });
    const { m, files } = saved();
    const llm = scriptedLlm([
      { thought: '목록', tool: 'list_files', args: { dir: t.ok, pattern: '*.csv' } },
      { thought: '읽기', tool: 'read_file', args: { path: join(t.ok, '조정.csv'), dataset: 'adj' } },
      { thought: '메모', tool: 'read_file', args: { path: 'memo.txt', name: 'memo' } },
      { thought: 'csv', tool: 'write_file', args: { filename: '결과.csv', dataset: 'adj' } },
      { thought: 'json', tool: 'write_file', args: { filename: '결과.json', dataset: 'adj' } },
      { thought: 'md', tool: 'write_file', args: { filename: '보고', content: '# 보고\n{out.memo}\n총 {rows.adj}건', dataset: 'adj' } },
      { thought: '막힘', tool: 'write_file', args: { filename: 'run.bat', content: 'del *' } },
      { thought: '끝', tool: 'finish', args: { summary: '{rows.adj}건' } },
    ]);
    const events: { tool: string; ok: boolean; result: string }[] = [];
    const r = await runSkill(buildFreeSkill(null, false, undefined, false, false, [], false, undefined, true), { request: '조정.csv 정리' }, {
      llm,
      browser: noBrowser,
      ui,
      files,
      localFiles,
      onEvent: (e) => e.type === 'action' && events.push(e.entry),
    });
    expect(r.status, r.message).toBe('done');
    expect(r.message).toBe('2건');
    expect(events[0].result).toMatch(/조정\.csv/);
    expect(events[0].result).not.toMatch(/memo\.txt/);
    expect(events[1].result).toMatch(/1번째 표를 "adj"에 담음: 2행/);
    expect(events[2].result).toMatch(/<file>\n첫 줄\n둘째 줄\n<\/file>\n\(글 전체를 \{out\.memo\}에 남김\)/);
    expect(m.get('결과.csv')).toBe('\uFEFFLot ID,수량\r\nP1,5\r\nP2,-3');
    expect(JSON.parse(m.get('결과.json')!)).toEqual([{ 'Lot ID': 'P1', 수량: '5' }, { 'Lot ID': 'P2', 수량: '-3' }]);
    expect(m.get('보고.txt')).toMatch(/^# 보고\n첫 줄\n둘째 줄\n총 2건\n\n\| Lot ID \| 수량 \|/);
    expect(events[6]).toMatchObject({ ok: false, result: expect.stringMatching(/\.bat 파일은 쓸 수 없습니다/) });
    expect(r.files).toEqual(['결과.csv', '결과.json', '보고.txt']);
  });

  it('파일 통로가 없으면(확장) 읽기는 안 된다고 알리고, 프롬프트·스키마에도 넣지 않는다', async () => {
    const { files } = saved();
    const seen: string[] = [];
    const llm = scriptedLlm([{ thought: '읽기', tool: 'read_file', args: { path: 'C:/a.txt' } }, { thought: '끝', tool: 'abort', args: { reason: '못 읽음' } }]);
    const events: { ok: boolean; result: string }[] = [];
    await runSkill(buildFreeSkill(null, false), { request: 'a.txt 읽어줘' }, {
      llm: { complete: async (msgs, s, o) => (seen.push(msgs[0].content), llm.complete(msgs, s, o)) },
      browser: noBrowser,
      ui,
      files,
      onEvent: (e) => e.type === 'action' && events.push(e.entry),
    });
    expect(events[0]).toMatchObject({ ok: false, result: expect.stringMatching(/PC 파일을 읽을 수 없습니다/) });
    expect(seen[0]).not.toContain('read_file {');
    expect(seen[0]).toContain('write_file {');
    expect(schemaTools({})).not.toContain('read_file');
    expect(schemaTools({ files: true })).toEqual(expect.arrayContaining(['list_files', 'read_file', 'write_file']));
  });

  it('파일 통로가 있으면 읽을 수 있는 폴더와 첨부한 파일을 모델에 보여 준다', async () => {
    const seen: string[] = [];
    const port: LocalFilesPort = { roots: () => ['C:\\Users\\me\\Downloads'], attached: () => ['D:\\work\\조정.xlsx'], list: async () => ({ dir: '', entries: [], more: 0 }), read: async () => ({ path: '', name: '', format: 'txt', tables: [] }) };
    await runSkill(buildFreeSkill(null, false, undefined, false, false, [], false, undefined, true), { request: '첨부한 엑셀 요약' }, {
      llm: { complete: async (msgs, _s, o) => (seen.push(msgs[0].content, JSON.stringify(o?.schema)), JSON.stringify({ thought: '', tool: 'abort', args: { reason: 'x' } })) },
      browser: noBrowser,
      ui,
      files: saved().files,
      localFiles: port,
    });
    expect(seen[0]).toMatch(/읽을 수 있는 폴더: C:\\Users\\me\\Downloads\n첨부한 파일: D:\\work\\조정\.xlsx/);
    expect(seen[1]).toContain('"read_file"');
    expect(JSON.stringify(actionSchema({ files: true }).schema)).toContain('"list_files"');
  });
});

describe('요청이 파일을 말하는지', () => {
  it('경로, 확장자, 파일·폴더라는 말', () => {
    for (const t of ['D:\\work\\a.txt 요약', 'memo.md 정리해줘', '내려받기 폴더 파일 목록', '첨부한 거 봐줘', '\\\\share\\team\\a 열어']) expect(fileIntent(t), t).toBe(true);
    for (const t of ['7라인 재공 조회해줘', '이 화면 요약해줘']) expect(fileIntent(t), t).toBe(false);
  });
});

// ── 세션: 첨부와 파일만 쓰는 자유 요청 ──
const read = (p: string) => readFileSync(join(import.meta.dirname, '..', p), 'utf8');
let Session: typeof SessionType;
beforeAll(async () => {
  vi.stubGlobal('__DOGENT_SKILLS__', { 'wip-check/SKILL.md': read('samples/skills/wip-check/SKILL.md') });
  vi.stubGlobal('__DOGENT_BUILD__', { mode: 'home', version: 'test' });
  ({ Session } = await import('../client/src/session'));
});
let server: Server | null = null;
let session: SessionType | null = null;
afterEach(async () => {
  await session?.close();
  server?.closeAllConnections();
  server?.close();
  server = session = null;
});

describe('세션의 첨부', () => {
  it('첨부한 파일로 브라우저 없이 자유 요청을 하고, 결과를 결과 폴더에 쓴다', async () => {
    const t = tree();
    const replies = [
      { skill_id: null, inputs: {}, reason: '맞는 스킬 없음' },
      { thought: '읽기', tool: 'read_file', args: { path: 'plan.txt', name: 'plan' } },
      { thought: '쓰기', tool: 'write_file', args: { filename: '정리.md', content: '요약: {out.plan}' } },
      { thought: '끝', tool: 'finish', args: { summary: '정리.md에 썼습니다' } },
    ];
    const prompts: string[] = [];
    server = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        prompts.push(JSON.parse(body).messages.map((m: { content: string }) => m.content).join('\n'));
        res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(replies.shift()) } }] }));
      });
    });
    await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
    const port = (server.address() as { port: number }).port;
    const lines: string[] = [];
    const ui: Ui = { print: (x) => lines.push(x), ask: async () => null, confirm: async () => true, askDefault: async (_q, f) => f };
    const cfg: ClientConfig = {
      home: t.root,
      llm: { baseUrl: `http://127.0.0.1:${port}/v1`, model: 'm', apiKey: 'k', jsonMode: false, timeoutScale: 1, skillDirect: true, pathCache: false, skillsUrl: '' },
      personalSkills: join(t.root, 'skills'),
      outputDir: join(t.root, 'out'),
      uploadDirs: [t.ok],
      saveThroughExcel: false,
      file: join(t.root, 'config.json'),
    };
    session = new Session(ui, cfg, { yes: true, allowWrite: false, dryRun: false, waitSec: 1, launchBrowser: false });
    await session.handle('이 계획 파일 정리해줘', [join(t.outside, 'plan.txt'), join(t.ok, 'id_rsa')]);
    expect(lines).toContain(`첨부: ${join(t.outside, 'plan.txt')}`);
    expect(lines.some((l) => /첨부하지 못했습니다: .*키·접속 정보/.test(l))).toBe(true);
    expect(lines).toContain('맞는 스킬이 없어 PC 파일 도구로 자유 요청을 합니다 (브라우저는 쓰지 않습니다).');
    // 요청 해석에도 첨부를 알려 준다
    expect(prompts[0]).toContain(`(첨부한 파일: ${join(t.outside, 'plan.txt')})`);
    expect(readFileSync(join(t.root, 'out', '정리.md'), 'utf8')).toBe('요약: 밖의 파일');
    expect(session.attachmentList()).toEqual([{ path: join(t.outside, 'plan.txt'), dir: false }]);
    // 새 대화는 첨부도 뗀다
    await session.handle('새 대화');
    expect(session.attachmentList()).toEqual([]);
  });
});
