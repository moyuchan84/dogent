import { beforeEach, describe, expect, it } from 'vitest';
import { DatasetStore, runSkill, type ApprovalRequest, type Cell, type RunEvent } from '../src/core';
import { JsdomBrowser, adjustLog, adjustSkill, memoryFiles, scriptedLlm } from './helpers';

const COLUMNS = ['Lot ID', '공정', '조정수량', '사유'];
const ROWS: Cell[][] = [
  ['P7-00012', 'PHOTO', -25, '검사 불량 폐기'],
  ['P7-00031', 'ETCH', 100, '재작업 투입'],
  ['P7-00044', 'CMP', -3, '샘플 반출'],
  ['P7-00058', 'IMP', 12, '수량 정정'],
  ['P7-00071', 'DIFF', -8, '파손'],
];

beforeEach(() => {
  adjustLog.length = 0;
});

async function run(rows: Cell[][], prepare?: (b: JsdomBrowser) => void, columns = COLUMNS) {
  const browser = await JsdomBrowser.open('/adjust-grid.html');
  prepare?.(browser);
  const datasets = new DatasetStore();
  datasets.set('src', columns, rows);
  const requests: ApprovalRequest[] = [];
  const events: RunEvent[] = [];
  const result = await runSkill(adjustSkill(), { source: '조정.xlsx' }, {
    llm: scriptedLlm([{ tool: 'abort', args: { reason: '끝' } }]),
    browser,
    ui: { ask: async () => '', approve: async (r) => (requests.push(r), true) },
    files: memoryFiles(),
    datasets,
    direct: true,
    onEvent: (e) => events.push(e),
  });
  const actions = events.flatMap((e) => (e.type === 'action' ? [e.entry] : []));
  const grid = [...browser.document.querySelectorAll('#adjGrid [role=row]:not(.head)')].map((r) =>
    [...r.querySelectorAll('[role=gridcell]')].slice(1).map((c) => c.textContent),
  );
  return { result, actions, requests, grid };
}

describe('붙여넣기로만 값을 받는 그리드', () => {
  it('입력 칸이 없는 그리드는 첫 칸을 골라 붙여 넣고, 대조와 승인을 거쳐 저장한다', async () => {
    const { result, actions, requests, grid } = await run(ROWS);
    expect(result.status, result.message).toBe('done');
    expect(actions.find((a) => a.tool === 'fill_table')?.result).toMatch(/붙여넣음.*일치함/);
    // 빈 행은 3개였지만 그리드가 붙여넣기에 맞춰 행을 늘린다. 같은 스킬을 고치지 않고 그대로 쓴다.
    expect(grid).toEqual(ROWS.map((r) => r.map(String)));
    expect(requests).toHaveLength(1);
    expect(requests[0].tables[0]).toMatchObject({ name: '조정 목록', rowCount: 5 });
    expect(adjustLog).toEqual([ROWS.map((r) => r.map(String))]);
  });

  it('그리드가 걸러 낸 값은 대조에서 걸려 저장하지 않는다', async () => {
    const rows = ROWS.map((r) => [...r]);
    rows[1][1] = 'WET';
    const { result, actions, requests } = await run(rows);
    const fill = actions.find((a) => a.tool === 'fill_table');
    expect(fill?.ok).toBe(false);
    expect(fill?.result).toContain('2행 "공정": 화면 "", 원본 "WET"');
    expect(result.status).toBe('aborted');
    expect(requests).toEqual([]);
    expect(adjustLog).toEqual([]);
  });

  it('값이 이미 있거나, 탭·줄바꿈이 든 값은 붙여 넣지 않는다', async () => {
    const filled = await run(ROWS, (b) => {
      b.document.querySelectorAll('#adjGrid [role=gridcell]')[1].textContent = 'P7-99999';
    });
    expect(filled.actions.find((a) => a.tool === 'fill_table')?.result).toContain('이미 입력된 값이 있습니다');

    const rows = ROWS.map((r) => [...r]);
    rows[2][3] = '첫 줄\n둘째 줄';
    const multiline = await run(rows);
    expect(multiline.actions.find((a) => a.tool === 'fill_table')?.result).toContain('3행 "사유": 탭이나 줄바꿈');
    expect(multiline.grid.flat().every((v) => v === '')).toBe(true);
  });

  it('데이터셋에 일부 컬럼만 있으면 그 범위만 붙여 넣는다', async () => {
    const { actions, grid } = await run(
      ROWS.map((r) => [r[0], r[1]]),
      undefined,
      ['Lot ID', '공정'],
    );
    expect(actions.find((a) => a.tool === 'fill_table')?.ok).toBe(true);
    expect(grid.map((r) => r.slice(0, 3))).toEqual(ROWS.map((r) => [String(r[0]), String(r[1]), '']));
  });
});
