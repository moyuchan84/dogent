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
