import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Cell, Dataset, OfficeDoc, OfficeKind, OfficePort, SlidesContent, SlidesEdit, WordContent, WordEdit } from '../../src/core';

type Table = Pick<Dataset, 'columns' | 'rows'>;
import { StdioMcp } from './mcp-stdio';

/**
 * 오피스 도구(dogent-office.exe)로 엑셀을 다룬다. 문서 보안(NASCA)이 걸린 파일은 라이브러리로 읽을 수 없어
 * 사용자의 Excel이 열어야 한다 (docs/09 D5).
 */
export interface SheetInfo {
  name: string;
  range: string;
  rows: number;
  columns: number;
}

/** 오피스 도구 실행 파일을 찾는다: 설정 → 환경 변수 → 클라이언트 옆 → 저장소의 office/dist */
export function findOfficeExe(configured?: string): string | null {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    configured,
    process.env.DOGENT_OFFICE_EXE,
    join(here, 'dogent-office.exe'),
    resolve(here, '../../office/dist/dogent-office.exe'),
  ].filter((p): p is string => !!p);
  return candidates.find((p) => existsSync(p)) ?? null;
}

export class Office {
  private constructor(private mcp: StdioMcp) {}

  static async start(exe: string, log?: (line: string) => void): Promise<Office> {
    return new Office(await StdioMcp.start(exe, [], { name: '오피스 도구(dogent-office)', log }));
  }

  private async tool<T>(name: string, args: Record<string, unknown>): Promise<T> {
    const r = await this.mcp.call(name, args);
    if (r.isError) throw new Error(r.text);
    return JSON.parse(r.text) as T;
  }

  /** 워드·파워포인트 도구처럼 이름으로 부르는 도구 (word_open, ppt_read …) */
  call<T>(name: string, args: Record<string, unknown> = {}): Promise<T> {
    return this.tool<T>(name, args);
  }

  async open(path: string, readOnly = true): Promise<{ workbook: string; sheets: SheetInfo[] }> {
    return this.tool('excel_open', { path: resolve(path), read_only: readOnly });
  }

  async read(workbook: string, opts: { sheet?: string; range?: string; maxRows?: number } = {}): Promise<{ sheet: string; range: string; columns: string[]; total_rows: number; rows: unknown[][] }> {
    return this.tool('excel_read', { workbook, ...(opts.sheet ? { sheet: opts.sheet } : {}), ...(opts.range ? { range: opts.range } : {}), max_rows: opts.maxRows ?? 1000 });
  }

  async close(workbook: string): Promise<void> {
    await this.tool('excel_close', { workbook });
  }

  /** 사용자의 Excel에 열린 문서 (문서 공유망에서 연 문서 등) */
  async userWorkbooks(): Promise<{ name: string; full_name: string; read_only: boolean }[]> {
    return this.tool('excel_user_workbooks', {});
  }

  async write(workbook: string, a: { sheet: string; start?: string; columns: string[]; rows: Cell[][] }): Promise<{ sheet: string; range: string; written: number }> {
    return this.tool('excel_write', { workbook, sheet: a.sheet, ...(a.start ? { start: a.start } : {}), columns: a.columns, rows: a.rows });
  }

  /** Excel로 저장한다. path가 없으면 연 곳에 저장하고, 있으면 다른 이름으로 저장한다. 저장한 곳을 돌려준다. */
  async save(workbook: string, path?: string): Promise<string> {
    return (await this.tool<{ saved: string }>('excel_save', { workbook, ...(path ? { path } : {}) })).saved;
  }

  /** 사용자의 Excel에 열린 문서를 잡는다. 저장하면 열린 곳에 저장되고, 닫아도 사용자의 문서는 닫히지 않는다. */
  async attach(name?: string, waitSec = 0): Promise<{ workbook: string; path: string; read_only: boolean; sheets: SheetInfo[] }> {
    return this.tool('excel_attach', { ...(name ? { name } : {}), wait_sec: waitSec });
  }

  /** 파일의 시트 하나를 표로 읽는다 (첫 행은 컬럼 이름). 열고 읽고 닫는다. */
  async readTable(path: string, opts: { sheet?: string; range?: string } = {}): Promise<Table> {
    const { workbook } = await this.open(path);
    try {
      const t = await this.read(workbook, { ...opts, maxRows: 1_000_000 });
      return { columns: t.columns, rows: t.rows.map((r) => r.map((c) => (typeof c === 'number' ? c : String(c ?? '')))) };
    } finally {
      await this.close(workbook).catch(() => {});
    }
  }

  /**
   * 파일을 Excel로 열어 다른 이름으로 저장한다. 문서 보안 프로그램이 Excel의 저장을 가로채 암호화하는지
   * 확인하거나, Dogent가 만든 결과 엑셀을 사내 규정대로 Excel을 거쳐 저장할 때 쓴다.
   */
  async resave(source: string, target: string, overwrite = false): Promise<string> {
    const { workbook } = await this.open(source);
    try {
      const r = await this.tool<{ saved: string }>('excel_save', { workbook, path: resolve(target), overwrite });
      return r.saved;
    } finally {
      await this.close(workbook).catch(() => {});
    }
  }

  shutdown(): Promise<void> {
    return this.mcp.close();
  }
}

/** 경로로 보이는 글인지 (드라이브·폴더 구분자·엑셀 확장자). 아니면 열린 문서의 이름으로 본다. */
export function looksLikePath(doc: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(doc) || /^\\\\/.test(doc) || /[\\/]/.test(doc);
}

const EXT_KIND: [RegExp, OfficeKind][] = [
  [/\.(xlsx|xlsm|xls|csv)$/i, 'excel'],
  [/\.(docx|docm|doc|rtf)$/i, 'word'],
  [/\.(pptx|pptm|ppt)$/i, 'ppt'],
];

/** 파일 이름의 확장자로 본 문서 종류. 알 수 없으면 null */
export function kindFromName(name: string): OfficeKind | null {
  return EXT_KIND.find(([re]) => re.test(name.trim()))?.[1] ?? null;
}

interface Held {
  kind: OfficeKind;
  /** 오피스 도구가 준 번호 (excel은 workbook, 워드·파워포인트는 doc) */
  handle: string;
  sheets: SheetInfo[];
  /** 아직 없는 파일 경로로 새로 만든 문서면 저장할 곳 */
  newPath?: string;
}

const cells = (rows: unknown[][]): Cell[][] => rows.map((r) => r.map((c) => (typeof c === 'number' ? c : String(c ?? ''))));

/**
 * 에이전트의 오피스 도구(엑셀·워드·파워포인트)가 쓰는 통로. 열린 문서는 사용자의 프로그램에서 이름으로 잡고(attach),
 * 경로는 프로그램으로 연다. 없는 문서 경로(.docx, .pptx)를 쓰기로 부르면 새 문서를 만든다.
 * 잡은 문서는 한 실행 동안 재사용하고, 끝나면 놓는다 (사용자의 문서는 닫히지 않는다).
 */
export class OfficeDocs implements OfficePort {
  private books = new Map<string, Held>();

  constructor(private office: () => Promise<Office>) {}

  /** 문서가 엑셀·워드·파워포인트 중 무엇인지: 확장자 → 열린 문서 목록의 이름 → 엑셀 */
  private async kindOf(doc: string): Promise<OfficeKind> {
    const byExt = kindFromName(doc);
    if (byExt) return byExt;
    if (!looksLikePath(doc)) {
      const hit = (await this.docs().catch(() => [])).find((d) => d.name.toLowerCase().includes(doc.toLowerCase()) || d.fullName.toLowerCase().includes(doc.toLowerCase()));
      if (hit?.kind) return hit.kind;
    }
    return 'excel';
  }

  private async book(doc: string, forWrite: boolean, want?: OfficeKind): Promise<Held> {
    const key = `${doc.toLowerCase()}|${forWrite ? 'w' : 'r'}`;
    const known = this.books.get(key);
    if (known) return known;
    const kind = want ?? (await this.kindOf(doc));
    const office = await this.office();
    let held: Held;
    if (kind === 'excel') {
      let opened: { workbook: string; sheets: SheetInfo[] };
      if (looksLikePath(doc)) {
        if (!existsSync(doc)) throw new Error(`파일이 없습니다: ${doc}`);
        opened = await office.open(doc, !forWrite);
      } else {
        opened = await office.attach(doc).catch((e: Error) => {
          throw new Error(`열린 엑셀 문서 "${doc}"을(를) 잡지 못했습니다: ${e.message}`);
        });
      }
      held = { kind, handle: opened.workbook, sheets: opened.sheets };
    } else {
      const label = kind === 'word' ? '워드' : '파워포인트';
      if (looksLikePath(doc)) {
        if (existsSync(doc)) {
          held = { kind, handle: (await office.call<{ doc: string }>(`${kind}_open`, { path: resolve(doc), read_only: !forWrite })).doc, sheets: [] };
        } else if (forWrite && kindFromName(doc) === kind) {
          // 없는 파일은 쓰기일 때 새 문서로 만든다. 저장하면 그 경로에 파일이 생긴다.
          held = { kind, handle: (await office.call<{ doc: string }>(`${kind}_new`)).doc, sheets: [], newPath: resolve(doc) };
        } else {
          throw new Error(`파일이 없습니다: ${doc}`);
        }
      } else {
        held = {
          kind,
          handle: (
            await office.call<{ doc: string }>(`${kind}_attach`, { name: doc }).catch((e: Error) => {
              throw new Error(`열린 ${label} 문서 "${doc}"을(를) 잡지 못했습니다: ${e.message}`);
            })
          ).doc,
          sheets: [],
        };
      }
    }
    this.books.set(key, held);
    return held;
  }

  /** 사용자의 Excel·Word·PowerPoint에 열린 문서. 도구가 워드·파워포인트를 모르는 옛 빌드면 엑셀만 보인다. */
  async docs(): Promise<OfficeDoc[]> {
    const office = await this.office();
    const list: OfficeDoc[] = (await office.userWorkbooks()).map((b) => ({ kind: 'excel' as const, name: b.name, fullName: b.full_name, readOnly: b.read_only }));
    for (const kind of ['word', 'ppt'] as const) {
      const r = await office.call<{ name: string; full_name: string; read_only: boolean }[]>(`${kind}_user_docs`).catch(() => []);
      for (const b of r) list.push({ kind, name: b.name, fullName: b.full_name, readOnly: b.read_only });
    }
    return list;
  }

  async read(doc: string, opts: { sheet?: string; range?: string }) {
    const book = await this.book(doc, false, 'excel');
    const t = await (await this.office()).read(book.handle, { ...opts, maxRows: 200_000 });
    return { sheet: t.sheet, sheets: book.sheets.map((s) => s.name), columns: t.columns, rows: cells(t.rows), total: t.total_rows };
  }

  async write(doc: string, sheet: string, table: { columns: string[]; rows: Cell[][] }, start?: string): Promise<string> {
    const book = await this.book(doc, true, 'excel');
    const r = await (await this.office()).write(book.handle, { sheet, start, columns: table.columns, rows: table.rows });
    return `${doc}의 "${r.sheet}" 시트 ${r.range}`;
  }

  async readWord(doc: string): Promise<WordContent> {
    const book = await this.book(doc, false, 'word');
    const r = await (await this.office()).call<{
      total_paragraphs: number;
      paragraphs: { text: string; style: string }[];
      tables: { columns: string[]; rows: unknown[][] }[];
    }>('word_read', { doc: book.handle });
    return { totalParagraphs: r.total_paragraphs, paragraphs: r.paragraphs, tables: r.tables.map((t) => ({ columns: t.columns, rows: cells(t.rows) })) };
  }

  async writeWord(doc: string, edit: WordEdit): Promise<string> {
    const book = await this.book(doc, true, 'word');
    const r = await (await this.office()).call<{ replaced: number; appended_paragraphs: number; appended_table_rows: number }>('word_write', { doc: book.handle, ...edit });
    return `바꾼 곳 ${r.replaced}건, 덧붙인 문단 ${r.appended_paragraphs}개, 덧붙인 표 ${r.appended_table_rows}행`;
  }

  async readSlides(doc: string): Promise<SlidesContent> {
    const book = await this.book(doc, false, 'ppt');
    const r = await (await this.office()).call<{
      total_slides: number;
      slides: { index: number; title: string; texts: string[]; tables: { columns: string[]; rows: unknown[][] }[]; notes: string }[];
    }>('ppt_read', { doc: book.handle });
    return {
      totalSlides: r.total_slides,
      slides: r.slides.map((s) => ({ ...s, notes: s.notes ?? '', tables: s.tables.map((t) => ({ columns: t.columns, rows: cells(t.rows) })) })),
    };
  }

  async writeSlides(doc: string, edit: SlidesEdit): Promise<string> {
    const book = await this.book(doc, true, 'ppt');
    const r = await (await this.office()).call<{ replaced: number; added_slides: number; notes_set: number; slides: number }>('ppt_write', { doc: book.handle, ...edit });
    return `바꾼 곳 ${r.replaced}건, 덧붙인 슬라이드 ${r.added_slides}장, 발표자 메모 ${r.notes_set}건 (지금 ${r.slides}장)`;
  }

  async save(doc: string, path?: string): Promise<string> {
    const key = doc.toLowerCase();
    const book = this.books.get(`${key}|w`) ?? this.books.get(`${key}|r`) ?? (await this.book(doc, true));
    const office = await this.office();
    if (book.kind === 'excel') return office.save(book.handle, path ? resolve(path) : undefined);
    const target = path ? resolve(path) : book.newPath;
    const r = await office.call<{ saved: string }>(`${book.kind}_save`, { doc: book.handle, ...(target ? { path: target } : {}) });
    return r.saved;
  }

  /** 실행이 끝나면 잡은 문서를 놓는다. 이 도구가 연 파일은 저장하지 않고 닫는다. */
  async release(): Promise<void> {
    const office = await this.office().catch(() => null);
    for (const b of this.books.values()) {
      if (b.kind === 'excel') await office?.close(b.handle).catch(() => {});
      else await office?.call(`${b.kind}_close`, { doc: b.handle }).catch(() => {});
    }
    this.books.clear();
  }
}
