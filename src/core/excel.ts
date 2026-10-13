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

type Table = Pick<Dataset, 'columns' | 'rows'>;

/** 사내 시스템의 CSV는 UTF-8이 아니라 EUC-KR(CP949)인 경우가 많다. UTF-8로 읽히지 않으면 EUC-KR로 읽는다. */
function csvGrid(data: ArrayBuffer): Cell[][] {
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(data);
  } catch {
    text = new TextDecoder('euc-kr').decode(data);
  }
  return parseCsv(text.replace(/^﻿/, ''));
}

async function xlsxGrid(data: ArrayBuffer): Promise<Cell[][]> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(data);
  const ws = wb.worksheets[0];
  if (!ws) throw new Error('엑셀 파일에 시트가 없습니다');
  const grid: Cell[][] = [];
  ws.eachRow({ includeEmpty: false }, (row) => {
    const values = row.values as ExcelJS.CellValue[];
    grid.push(Array.from({ length: Math.max(values.length - 1, 0) }, (_, i) => cellOf(values[i + 1])));
  });
  return grid;
}

/**
 * 엑셀(xlsx) 또는 CSV 파일의 첫 시트를 표로 읽는다. 첫 행은 컬럼 이름이다.
 * 내용이 전혀 없는 행은 건너뛴다.
 */
export async function readTable(data: ArrayBuffer, filename: string): Promise<Table> {
  if (/\.csv$/i.test(filename)) return toTable(csvGrid(data));
  if (/\.xlsx$/i.test(filename)) return toTable(await xlsxGrid(data));
  throw new Error('xlsx 또는 csv 파일만 읽을 수 있습니다');
}

/**
 * 화면에서 내려받은 파일을 표로 읽는다. 파일 이름이 없거나 확장자가 내용과 다른 경우가 있어
 * 형식은 내용의 첫머리로 판별한다.
 */
export async function readDownloadedTable(data: ArrayBuffer): Promise<Table> {
  const head = new Uint8Array(data.slice(0, 8));
  if (head[0] === 0x50 && head[1] === 0x4b) return toTable(await xlsxGrid(data));
  if (head[0] === 0xd0 && head[1] === 0xcf) {
    throw new Error('구형 엑셀(xls) 파일은 읽을 수 없습니다. xlsx나 csv로 내려받는 버튼을 쓰세요');
  }
  const start = new TextDecoder('utf-8').decode(data.slice(0, 200)).replace(/^﻿/, '').trimStart();
  if (start.startsWith('<')) {
    throw new Error('내려받은 내용이 엑셀·CSV가 아니라 웹 문서입니다. 로그인이 풀렸거나 오류 화면일 수 있습니다');
  }
  return toTable(csvGrid(data));
}

function toTable(grid: Cell[][]): Table {
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
