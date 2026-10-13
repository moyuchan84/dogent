import ExcelJS from 'exceljs';
import type { Cell, Dataset } from './types';

/**
 * 표시용 문자열을 엑셀 값으로 바꾼다. "1,234"는 숫자로, "00123"처럼 앞자리 0이 있는
 * 식별자는 문자열 그대로 둔다.
 */
export function toExcelValue(cell: Cell): string | number {
  if (typeof cell === 'number') return cell;
  const s = cell.trim();
  if (/^-?(0|[1-9]\d{0,2}(,\d{3})+|[1-9]\d*)(\.\d+)?$/.test(s)) return Number(s.replace(/,/g, ''));
  return cell;
}

function cellOf(value: ExcelJS.CellValue): Cell {
  if (value === null || value === undefined) return '';
  if (typeof value === 'number') return value;
  if (typeof value === 'string') return value;
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if ('result' in value) return cellOf(value.result as ExcelJS.CellValue);
  if ('richText' in value) return value.richText.map((r) => r.text).join('');
  if ('text' in value) return String(value.text);
  return String(value);
}

/** 큰따옴표로 감싼 칸과 칸 안의 줄바꿈을 지원하는 CSV 읽기. */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') {
      row.push(cell);
      cell = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else cell += ch;
  }
  if (cell !== '' || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

/**
 * 엑셀(xlsx) 또는 CSV 파일의 첫 시트를 표로 읽는다. 첫 행은 컬럼 이름이다.
 * 내용이 전혀 없는 행은 건너뛴다.
 */
export async function readTable(data: ArrayBuffer, filename: string): Promise<Pick<Dataset, 'columns' | 'rows'>> {
  let grid: Cell[][];
  if (/\.csv$/i.test(filename)) {
    grid = parseCsv(new TextDecoder('utf-8').decode(data).replace(/^﻿/, ''));
  } else if (/\.xlsx$/i.test(filename)) {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(data);
    const ws = wb.worksheets[0];
    if (!ws) throw new Error('엑셀 파일에 시트가 없습니다');
    grid = [];
    ws.eachRow({ includeEmpty: false }, (row) => {
      const values = row.values as ExcelJS.CellValue[];
      grid.push(Array.from({ length: Math.max(values.length - 1, 0) }, (_, i) => cellOf(values[i + 1])));
    });
  } else {
    throw new Error('xlsx 또는 csv 파일만 읽을 수 있습니다');
  }
  grid = grid.filter((r) => r.some((c) => String(c).trim() !== ''));
  if (grid.length === 0) throw new Error('파일에 내용이 없습니다');
  const columns = grid[0].map((c) => String(c).trim());
  if (columns.some((c) => c === '')) throw new Error('첫 행(컬럼 이름)에 빈 칸이 있습니다');
  if (new Set(columns).size !== columns.length) throw new Error('첫 행에 같은 컬럼 이름이 두 번 나옵니다');
  const rows = grid.slice(1).map((r) => columns.map((_, i) => r[i] ?? ''));
  return { columns, rows };
}

export async function buildWorkbook(
  sheets: { name: string; dataset: Pick<Dataset, 'columns' | 'rows'> }[],
): Promise<ArrayBuffer> {
  const wb = new ExcelJS.Workbook();
  for (const { name, dataset } of sheets) {
    const ws = wb.addWorksheet(name.replace(/[\\/?*[\]:]/g, '_').slice(0, 31));
    ws.addRow(dataset.columns).font = { bold: true };
    for (const row of dataset.rows) ws.addRow(row.map(toExcelValue));
    ws.views = [{ state: 'frozen', ySplit: 1 }];
    dataset.columns.forEach((col, i) => {
      const longest = dataset.rows
        .slice(0, 200)
        .reduce((max, r) => Math.max(max, String(r[i] ?? '').length), col.length);
      ws.getColumn(i + 1).width = Math.min(40, Math.max(8, longest * 1.4 + 2));
    });
  }
  return (await wb.xlsx.writeBuffer()) as ArrayBuffer;
}
