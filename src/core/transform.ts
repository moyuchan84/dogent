import { z } from 'zod';
import type { Cell, Dataset } from './types';

const Condition = z.object({
  col: z.string(),
  // 모델이 "="로 쓰는 일이 잦아 "=="와 같게 받는다.
  cmp: z.preprocess((v) => (v === '=' ? '==' : v), z.enum(['==', '!=', '>', '>=', '<', '<=', 'contains'])),
  value: z.union([z.string(), z.number()]),
});

export const TransformStep = z.discriminatedUnion('op', [
  z.object({
    op: z.literal('filter'),
    match: z.enum(['all', 'any']).default('all'),
    where: z.array(Condition).min(1),
  }),
  z.object({
    op: z.literal('group'),
    by: z.array(z.string()).min(1),
    agg: z
      .array(
        z.object({
          fn: z.enum(['count', 'sum', 'avg', 'min', 'max']),
          col: z.string().optional(),
          as: z.string().min(1),
        }),
      )
      .min(1),
  }),
  z.object({ op: z.literal('sort'), by: z.string(), desc: z.boolean().default(false) }),
  z.object({ op: z.literal('select'), cols: z.array(z.string()).min(1) }),
  z.object({ op: z.literal('limit'), n: z.number().int().positive() }),
]);
export type TransformStep = z.infer<typeof TransformStep>;

/** "1,234" 같은 표시용 숫자 문자열도 숫자로 읽는다. 숫자가 아니면 NaN. */
export function toNumber(cell: Cell): number {
  if (typeof cell === 'number') return cell;
  const s = cell.replace(/,/g, '').trim();
  return /^-?\d+(\.\d+)?$/.test(s) ? Number(s) : NaN;
}

type Table = Pick<Dataset, 'columns' | 'rows'>;

function colIndex(t: Table, col: string): number {
  const i = t.columns.indexOf(col);
  if (i < 0) throw new Error(`컬럼 "${col}"이 없습니다. 사용 가능한 컬럼: ${t.columns.join(', ')}`);
  return i;
}

function test(cell: Cell, cmp: z.infer<typeof Condition>['cmp'], value: string | number): boolean {
  if (cmp === 'contains') return String(cell).includes(String(value));
  const a = toNumber(cell);
  const b = toNumber(value);
  const numeric = !Number.isNaN(a) && !Number.isNaN(b);
  if (cmp === '==') return numeric ? a === b : String(cell).trim() === String(value).trim();
  if (cmp === '!=') return numeric ? a !== b : String(cell).trim() !== String(value).trim();
  if (!numeric) return false;
  if (cmp === '>') return a > b;
  if (cmp === '>=') return a >= b;
  if (cmp === '<') return a < b;
  return a <= b;
}

function applyStep(t: Table, step: TransformStep): Table {
  switch (step.op) {
    case 'filter': {
      const conds = step.where.map((w) => ({ ...w, i: colIndex(t, w.col) }));
      const pass = (row: Cell[]) =>
        step.match === 'any'
          ? conds.some((c) => test(row[c.i], c.cmp, c.value))
          : conds.every((c) => test(row[c.i], c.cmp, c.value));
      return { columns: t.columns, rows: t.rows.filter(pass) };
    }
    case 'group': {
      const byIdx = step.by.map((c) => colIndex(t, c));
      const aggs = step.agg.map((a) => {
        if (a.fn !== 'count' && !a.col) throw new Error(`집계 ${a.fn}에는 col이 필요합니다`);
        return { ...a, i: a.col ? colIndex(t, a.col) : -1 };
      });
      const groups = new Map<string, { key: Cell[]; rows: Cell[][] }>();
      for (const row of t.rows) {
        const key = byIdx.map((i) => row[i]);
        const id = key.join('\u0001');
        let g = groups.get(id);
        if (!g) groups.set(id, (g = { key, rows: [] }));
        g.rows.push(row);
      }
      const rows = [...groups.values()].map((g) => [
        ...g.key,
        ...aggs.map((a): Cell => {
          if (a.fn === 'count') return g.rows.length;
          const nums = g.rows.map((r) => toNumber(r[a.i])).filter((n) => !Number.isNaN(n));
          if (nums.length === 0) return '';
          const sum = nums.reduce((x, y) => x + y, 0);
          if (a.fn === 'sum') return sum;
          if (a.fn === 'avg') return sum / nums.length;
          return a.fn === 'min' ? Math.min(...nums) : Math.max(...nums);
        }),
      ]);
      return { columns: [...step.by, ...aggs.map((a) => a.as)], rows };
    }
    case 'sort': {
      const i = colIndex(t, step.by);
      const numeric = t.rows.every((r) => !Number.isNaN(toNumber(r[i])));
      const dir = step.desc ? -1 : 1;
      const rows = [...t.rows].sort((a, b) =>
        numeric
          ? (toNumber(a[i]) - toNumber(b[i])) * dir
          : String(a[i]).localeCompare(String(b[i]), 'ko') * dir,
      );
      return { columns: t.columns, rows };
    }
    case 'select': {
      const idx = step.cols.map((c) => colIndex(t, c));
      return { columns: step.cols, rows: t.rows.map((r) => idx.map((i) => r[i])) };
    }
    case 'limit':
      return { columns: t.columns, rows: t.rows.slice(0, step.n) };
  }
}

export function transform(source: Table, steps: TransformStep[]): Table {
  return steps.reduce(applyStep, { columns: source.columns, rows: source.rows });
}
