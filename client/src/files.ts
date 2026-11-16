import { promises as nodeFs } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { inflateRawSync } from 'node:zlib';
import {
  decodeText,
  formatBytes,
  looseTable,
  parseCsv,
  readSheet,
  sensitiveNameReason,
  sensitivePathReason,
  type Cell,
  type LocalFileContent,
  type LocalFileEntry,
  type LocalFilesPort,
} from '../../src/core';

/**
 * PC 파일 읽기 (list_files·read_file). 에이전트가 읽을 수 있는 곳은 둘뿐이다.
 * - 읽을 수 있는 폴더: 설정의 uploadDirs(기본: 결과 폴더, 내려받기, 문서, 바탕 화면)와 사용자가 첨부한 폴더
 * - 사용자가 첨부한 파일 (앱에 끌어다 놓기, dogent --file)
 * 그 밖의 경로, 숨김·키 파일, 링크로 폴더 밖을 가리키는 경로는 읽지 않는다 (upload.ts와 같은 검사).
 * 쓰기는 여기서 하지 않는다. write_file은 결과 폴더(FilePort)에만 쓴다.
 */

/** 읽을 파일의 최대 크기 */
export const READ_MAX_BYTES = 30 * 1024 * 1024;
/** list_files가 한 번에 보여 주는 최대 항목 수 */
export const LIST_MAX = 100;

/** 글로 읽는 확장자 */
const TEXT_EXT = new Set(['txt', 'md', 'markdown', 'log', 'json', 'xml', 'html', 'htm', 'yaml', 'yml', 'ini', 'cfg', 'conf', 'sql', 'properties', 'csv', 'tsv']);

export interface FileAccess {
  /** 읽을 수 있는 폴더 */
  dirs: () => string[];
  /** 첨부한 파일·폴더 (checkAttachment로 확인한 것) */
  attached: () => { path: string; dir: boolean }[];
  home?: string;
}

export interface ReadFs {
  realpath(path: string): Promise<string>;
  stat(path: string): Promise<{ isFile(): boolean; isDirectory(): boolean; size: number; mtime: Date }>;
  readFile(path: string): Promise<Uint8Array>;
  readdir(path: string): Promise<{ name: string; isFile(): boolean; isDirectory(): boolean }[]>;
}

export const nodeReadFs: ReadFs = {
  realpath: (p) => nodeFs.realpath(p),
  stat: (p) => nodeFs.stat(p),
  readFile: (p) => nodeFs.readFile(p),
  readdir: (p) => nodeFs.readdir(p, { withFileTypes: true }),
};

/** root 안(root 자신 포함)이면 상대 경로, 아니면 null. 다른 드라이브면 relative가 절대 경로로 나온다 */
function within(root: string, target: string): string | null {
  const rel = relative(root, target);
  if (rel === '') return '';
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return null;
  return rel;
}

const sameFile = (a: string, b: string) => (process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b);
const forReading = (reason: string) => reason.replace(/올리지 않습니다/g, '읽지 않습니다');

/** 글로 쓴 glob(*, ?)을 정규식으로. 대소문자는 가리지 않는다 */
export function globRegex(pattern: string): RegExp {
  const body = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp(`^${body}$`, 'i');
}

export function localFilesPort(access: FileAccess, fs: ReadFs = nodeReadFs): LocalFilesPort {
  const home = access.home ?? homedir();
  const attachedFiles = async () => access.attached().filter((a) => !a.dir).map((a) => a.path);
  const roots = () => [...new Set([...access.dirs(), ...access.attached().filter((a) => a.dir).map((a) => a.path)])];
  const rootList = async () => roots();

  /** 경로를 읽어도 되는 실제 경로로 푼다. 어기면 이유를 담아 던진다 */
  async function resolveReadable(raw: string, want: 'file' | 'dir'): Promise<string> {
    let text = raw.trim().replace(/^["']|["']$/g, '').replace(/^~(?=$|[\\/])/, home);
    if (text === '') throw new Error('경로가 비어 있습니다');
    if (!isAbsolute(text)) {
      // 첨부한 파일은 이름만으로, 그 밖에는 읽을 수 있는 폴더 안의 상대 경로로 찾는다
      const byName = want === 'file' ? (await attachedFiles()).find((f) => sameFile(basename(f), basename(text))) : undefined;
      let found = byName;
      if (!found) {
        for (const root of await rootList()) {
          const candidate = join(root, text);
          const st = await fs.stat(candidate).catch(() => null);
          if (st && (want === 'file' ? st.isFile() : st.isDirectory())) {
            found = candidate;
            break;
          }
        }
      }
      if (!found) throw new Error(`"${raw}"을(를) 찾지 못했습니다. 전체 경로로 쓰거나 list_files로 찾으세요. 읽을 수 있는 폴더: ${(await rootList()).join(', ')}`);
      text = found;
    }
    let real: string;
    try {
      real = await fs.realpath(resolve(text));
    } catch {
      throw new Error(`${want === 'file' ? '파일' : '폴더'}을 찾을 수 없습니다: ${raw}`);
    }
    // 첨부한 파일은 어디에 있든 그 파일만 읽을 수 있다 (사용자가 직접 건넨 것)
    for (const a of await attachedFiles()) {
      const ra = await fs.realpath(resolve(a)).catch(() => null);
      if (ra && sameFile(ra, real)) {
        const bad = sensitiveNameReason(real);
        if (bad) throw new Error(forReading(bad));
        return real;
      }
    }
    let rel: string | null = null;
    for (const dir of await rootList()) {
      const root = await fs.realpath(resolve(dir)).catch(() => null);
      if (!root) continue;
      rel = within(root, real);
      if (rel !== null) break;
    }
    if (rel === null) {
      throw new Error(`읽을 수 있는 폴더 밖입니다: ${raw}. 읽을 수 있는 폴더: ${(await rootList()).join(', ')}. 앱에 파일을 끌어다 놓거나 dogent config uploadDirs 로 폴더를 더합니다`);
    }
    if (rel !== '') {
      const bad = sensitivePathReason(real, want === 'dir' ? join(rel, 'x') : rel);
      if (bad && (want === 'file' || !/숨김 파일|키·접속/.test(bad))) throw new Error(forReading(bad));
    }
    const st = await fs.stat(real);
    if (want === 'file' && !st.isFile()) throw new Error(`파일이 아닙니다: ${raw} (폴더는 list_files로 봅니다)`);
    if (want === 'dir' && !st.isDirectory()) throw new Error(`폴더가 아닙니다: ${raw} (파일은 read_file로 읽습니다)`);
    return real;
  }

  return {
    roots,
    attached: () => access.attached().filter((a) => !a.dir).map((a) => a.path),
    async list(dir, pattern) {
      const real = await resolveReadable(dir, 'dir');
      const re = pattern ? globRegex(pattern) : null;
      const items = await fs.readdir(real);
      const entries: LocalFileEntry[] = [];
      for (const d of items) {
        if (d.name.startsWith('.') || (d.isFile() && sensitiveNameReason(d.name))) continue;
        if (!d.isFile() && !d.isDirectory()) continue;
        if (re && (d.isDirectory() || !re.test(d.name))) continue;
        const st = await fs.stat(join(real, d.name)).catch(() => null);
        if (!st) continue;
        entries.push({ name: d.name, dir: d.isDirectory(), size: d.isFile() ? st.size : 0, modified: st.mtime.toISOString() });
      }
      // 폴더 먼저, 파일은 최근에 고친 것부터 (방금 내려받은 파일을 찾기 쉽게)
      entries.sort((a, b) => (a.dir !== b.dir ? (a.dir ? -1 : 1) : a.dir ? a.name.localeCompare(b.name) : b.modified.localeCompare(a.modified)));
      return { dir: real, entries: entries.slice(0, LIST_MAX), more: Math.max(0, entries.length - LIST_MAX) };
    },
    async read(path, opts = {}) {
      const real = await resolveReadable(path, 'file');
      const st = await fs.stat(real);
      if (st.size > READ_MAX_BYTES) throw new Error(`파일이 너무 큽니다 (${formatBytes(st.size)}, 상한 ${formatBytes(READ_MAX_BYTES)})`);
      const bytes = await fs.readFile(real);
      return parseFile(real, bytes, opts);
    },
  };
}

const isZip = (b: Uint8Array) => b[0] === 0x50 && b[1] === 0x4b;
const isOle = (b: Uint8Array) => b[0] === 0xd0 && b[1] === 0xcf && b[2] === 0x11 && b[3] === 0xe0;
const DRM_HINT = '문서 보안(DRM)이 걸린 파일이거나 형식이 다릅니다. 오피스 도구가 있으면 excel_read·word_read·ppt_read로 읽으세요';

/** 파일 내용을 형식에 맞게 읽는다. 형식은 확장자로 정하고, 내용의 첫머리로 확인한다 */
export async function parseFile(path: string, bytes: Uint8Array, opts: { sheet?: string } = {}): Promise<LocalFileContent> {
  const name = basename(path);
  const ext = extname(name).slice(1).toLowerCase();
  const base = { path, name, format: ext || 'text', tables: [] as LocalFileContent['tables'] };
  const buf = () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;

  if (ext === 'xlsx' || ext === 'xlsm') {
    if (!isZip(bytes)) throw new Error(`${name}: ${DRM_HINT}`);
    const r = await readSheet(buf(), opts.sheet);
    return { ...base, tables: [{ title: r.sheet, ...r.table }], sheets: r.sheets, sheet: r.sheet };
  }
  if (ext === 'docx' || ext === 'pptx') {
    if (!isZip(bytes)) throw new Error(`${name}: ${DRM_HINT}`);
    const zip = readZip(bytes);
    if (ext === 'docx') {
      const xml = zip.get('word/document.xml');
      if (!xml) throw new Error(`${name}: 워드 문서의 본문을 찾지 못했습니다`);
      const doc = parseOfficeXml(decodeText(xml), 'w');
      return { ...base, text: doc.text, tables: doc.tables };
    }
    const slides = [...zip.keys()]
      .map((k) => /^ppt\/slides\/slide(\d+)\.xml$/.exec(k))
      .filter((m): m is RegExpExecArray => m !== null)
      .sort((a, b) => Number(a[1]) - Number(b[1]));
    const parts: string[] = [];
    const tables: LocalFileContent['tables'] = [];
    for (const m of slides) {
      const doc = parseOfficeXml(decodeText(zip.get(m[0])!), 'a');
      parts.push(`## 슬라이드 ${m[1]}\n${doc.text}`.trim());
      for (const t of doc.tables) tables.push({ ...t, title: `슬라이드 ${m[1]}` });
    }
    return { ...base, text: parts.join('\n\n'), tables };
  }
  if (['xls', 'doc', 'ppt'].includes(ext) || isOle(bytes)) {
    throw new Error(`${name}: 예전 형식(xls·doc·ppt)이거나 문서 보안이 걸린 파일이라 직접 읽지 못합니다. 오피스 도구가 있으면 excel_read·word_read·ppt_read로 읽으세요`);
  }
  if (ext === 'pdf') return { ...base, text: await pdfText(name, bytes) };
  if (['png', 'jpg', 'jpeg', 'gif', 'bmp', 'webp', 'zip', 'exe', 'dll', 'msi'].includes(ext)) {
    throw new Error(`${name}: 글이나 표가 아닌 파일이라 읽지 않습니다`);
  }
  // 글 파일. 확장자를 모르면 내용에 NUL이 없을 때만 글로 본다
  if (!TEXT_EXT.has(ext) && bytes.slice(0, 8192).includes(0)) throw new Error(`${name}: 글 파일이 아니라 읽지 않습니다`);
  const text = decodeText(bytes);
  if (ext === 'csv' || ext === 'tsv') {
    const grid: Cell[][] = ext === 'csv' ? parseCsv(text) : text.split(/\r?\n/).map((l) => l.split('\t'));
    const t = looseTable(grid);
    return { ...base, tables: t ? [t] : [] };
  }
  if (ext === 'html' || ext === 'htm') return { ...base, text: htmlText(text) };
  return { ...base, format: ext || 'text', text };
}

/**
 * PDF의 글을 쪽마다 읽는다 (unpdf = pdf.js). 라이브러리는 PDF를 읽을 때만 불러온다.
 * 스캔한 그림뿐인 PDF는 글이 없으므로 그렇다고 알린다 (글자 인식은 하지 않는다).
 */
async function pdfText(name: string, bytes: Uint8Array): Promise<string> {
  if (new TextDecoder().decode(bytes.slice(0, 1024)).indexOf('%PDF-') < 0) {
    throw new Error(`${name}: PDF 형식이 아닙니다. 문서 보안(DRM)이 걸린 파일일 수 있습니다`);
  }
  const { extractText, getDocumentProxy } = await import('unpdf');
  let pages: string[];
  try {
    // pdf.js가 넘겨받은 버퍼를 옮겨 쓸 수 있으므로 복사본을 준다
    const doc = await getDocumentProxy(new Uint8Array(bytes));
    pages = (await extractText(doc, { mergePages: false })).text;
  } catch (e) {
    const msg = (e as Error).message;
    throw new Error(/password/i.test(msg) ? `${name}: 암호가 걸린 PDF라 읽지 못합니다` : `${name}: PDF를 읽지 못했습니다 (${msg})`);
  }
  const text = pages
    .map((p, i) => ({ n: i + 1, t: p.replace(/[ \t]+\n/g, '\n').trim() }))
    .filter((p) => p.t)
    .map((p) => (pages.length > 1 ? `## ${p.n}쪽\n${p.t}` : p.t))
    .join('\n\n');
  if (!text) throw new Error(`${name}: 글이 없는 PDF입니다 (스캔한 그림으로 보입니다. 글자 인식은 하지 않습니다)`);
  return text;
}

/** HTML에서 글만 (스크립트·스타일을 빼고 태그를 지운다) */
function htmlText(html: string): string {
  return xmlUnescape(
    html
      .replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, '')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|div|tr|li|h[1-6])>/gi, '\n')
      .replace(/<[^>]+>/g, ' '),
  )
    .split('\n')
    .map((l) => l.replace(/[ \t]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function xmlUnescape(s: string): string {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h: string) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&');
}

/**
 * 워드(w:)·파워포인트(a:) XML에서 문단 글과 표를 꺼낸다. 표는 글에도 "| 칸 | 칸 |"으로 넣고, 따로 표로도 돌려준다.
 * 표 안의 표는 바깥 칸의 글로 합친다.
 */
export function parseOfficeXml(xml: string, ns: 'w' | 'a'): { text: string; tables: { columns: string[]; rows: Cell[][] }[] } {
  const re = new RegExp(`<(/?)${ns}:(tbl|tr|tc|p)\\b[^>]*?(/?)>|<${ns}:t(?:\\s[^>]*)?>([^<]*)</${ns}:t>|<${ns}:(tab|br|cr)\\b[^>]*/>`, 'g');
  const out: string[] = [];
  const tables: { columns: string[]; rows: Cell[][] }[] = [];
  let depth = 0;
  let rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let para = '';
  let inPara = false;
  for (const m of xml.matchAll(re)) {
    const [, close, tag, selfClose, text, brk] = m;
    if (text !== undefined) {
      if (inPara) para += xmlUnescape(text);
      continue;
    }
    if (brk) {
      if (inPara) para += brk === 'tab' ? '\t' : '\n';
      continue;
    }
    if (selfClose) continue;
    if (tag === 'p') {
      if (!close) {
        inPara = true;
        para = '';
      } else {
        inPara = false;
        const line = para.replace(/^\s+|\s+$/g, '');
        if (depth > 0) cell += (cell && line ? '\n' : '') + line;
        else if (line) out.push(line);
      }
    } else if (tag === 'tbl') {
      if (!close) {
        if (depth === 0) rows = [];
        depth++;
      } else {
        depth--;
        if (depth === 0 && rows.length) {
          const t = looseTable(rows);
          if (t) tables.push(t);
          out.push(rows.map((r) => `| ${r.map((c) => c.replace(/\n/g, ' ')).join(' | ')} |`).join('\n'));
        }
      }
    } else if (depth === 1 && tag === 'tr') {
      if (!close) row = [];
      else rows.push(row);
    } else if (depth === 1 && tag === 'tc') {
      if (!close) cell = '';
      else row.push(cell);
    }
  }
  return { text: out.join('\n'), tables };
}

/** ZIP 파일(docx·pptx)의 항목들을 이름 → 내용으로 푼다. 저장(0)과 deflate(8)만 다룬다 */
export function readZip(bytes: Uint8Array): Map<string, Uint8Array> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65_557); i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('ZIP 형식이 아닙니다');
  const count = view.getUint16(eocd + 10, true);
  let p = view.getUint32(eocd + 16, true);
  const out = new Map<string, Uint8Array>();
  const utf8 = new TextDecoder('utf-8');
  for (let n = 0; n < count; n++) {
    if (view.getUint32(p, true) !== 0x02014b50) throw new Error('ZIP 목록이 깨졌습니다');
    const method = view.getUint16(p + 10, true);
    const size = view.getUint32(p + 20, true);
    const nameLen = view.getUint16(p + 28, true);
    const extraLen = view.getUint16(p + 30, true);
    const commentLen = view.getUint16(p + 32, true);
    const local = view.getUint32(p + 42, true);
    const name = utf8.decode(bytes.subarray(p + 46, p + 46 + nameLen));
    p += 46 + nameLen + extraLen + commentLen;
    if (name.endsWith('/') || !/\.(xml|rels)$/i.test(name)) continue;
    const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
    const data = bytes.subarray(start, start + size);
    if (method === 0) out.set(name, data);
    else if (method === 8) out.set(name, inflateRawSync(data));
  }
  return out;
}

/** 첨부할 경로를 확인한다 (있는 파일·폴더인지, 숨김·키 파일이 아닌지). 문제가 있으면 이유를 돌려준다 */
export async function checkAttachment(raw: string, fs: ReadFs = nodeReadFs, home = homedir()): Promise<{ path: string; dir: boolean } | { error: string }> {
  const text = raw.trim().replace(/^["']|["']$/g, '').replace(/^~(?=$|[\\/])/, home);
  if (!isAbsolute(text)) return { error: `전체 경로로 적어 주세요: ${raw}` };
  const st = await fs.stat(text).catch(() => null);
  if (!st) return { error: `없는 파일입니다: ${raw}` };
  if (!st.isDirectory()) {
    const bad = sensitiveNameReason(basename(text));
    if (bad) return { error: forReading(bad) };
  } else if (basename(text).startsWith('.') || dirname(text) === text) {
    return { error: `이 폴더는 첨부하지 않습니다: ${raw}` };
  }
  return { path: resolve(text), dir: st.isDirectory() };
}
