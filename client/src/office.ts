import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Dataset } from '../../src/core';

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
