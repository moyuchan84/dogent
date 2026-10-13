import type { Cell, Dataset, DatasetInfo, TableData } from './types';

export class DatasetStore {
  private map = new Map<string, Dataset>();

  get(name: string): Dataset {
    const ds = this.map.get(name);
    if (!ds) {
      const known = [...this.map.keys()].join(', ') || '(없음)';
      throw new Error(`데이터셋 "${name}"이 없습니다. 현재 데이터셋: ${known}`);
    }
    return ds;
  }

  set(name: string, columns: string[], rows: Cell[][]): Dataset {
    const ds = { name, columns, rows };
    this.map.set(name, ds);
    return ds;
  }

  private lastChunk = new Map<string, string>();

  /**
   * 표를 데이터셋에 넣는다. append면 컬럼이 같은 기존 데이터셋 뒤에 붙인다.
   * 직전에 붙인 것과 내용이 같으면 같은 페이지를 다시 추출한 것으로 보고 거부한다.
   */
  put(name: string, table: TableData, append: boolean): Dataset {
    const existing = this.map.get(name);
    const chunk = JSON.stringify(table.rows);
    if (append && existing && table.rows.length > 0 && this.lastChunk.get(name) === chunk) {
      throw new Error(
        `방금 추출한 페이지와 내용이 같아 "${name}"에 붙이지 않았습니다 (현재 ${existing.rows.length}행). 다음 페이지로 넘어간 뒤 추출하세요`,
      );
    }
    this.lastChunk.set(name, chunk);
    if (append && existing) {
      if (existing.columns.join('\u0001') !== table.columns.join('\u0001')) {
        throw new Error(
          `"${name}"의 컬럼(${existing.columns.join(', ')})과 추출한 표의 컬럼(${table.columns.join(', ')})이 다릅니다`,
        );
      }
      existing.rows.push(...table.rows);
      return existing;
    }
    return this.set(name, table.columns, [...table.rows]);
  }

  list(): Dataset[] {
    return [...this.map.values()];
  }

  info(): DatasetInfo[] {
    return this.list().map((d) => ({ name: d.name, columns: d.columns, rowCount: d.rows.length }));
  }

  /** 모델에 보여줄 요약. 전체 데이터가 아니라 컬럼과 샘플 행만 담는다. */
  describe(sampleRows = 3): string {
    if (this.map.size === 0) return '(없음)';
    return this.list()
      .map((ds) => {
        const sample = ds.rows
          .slice(0, sampleRows)
          .map((r) => `    ${JSON.stringify(r)}`)
          .join('\n');
        return `- ${ds.name}: ${ds.rows.length}행, 컬럼 ${JSON.stringify(ds.columns)}\n${sample}`;
      })
      .join('\n');
  }
}
