import { beforeEach, describe, expect, it } from 'vitest';
import {
  DatasetStore,
  buildWorkbook,
  readTable,
  runSkill,
  type ApprovalRequest,
  type Cell,
  type RunEvent,
} from '../src/core';
import { JsdomBrowser, adjustLog, adjustSkill, memoryFiles, mockLlm, scriptedLlm } from './helpers';

const COLUMNS = ['Lot ID', '공정', '조정수량', '사유'];
const ROWS: Cell[][] = [
  ['P7-00012', 'PHOTO', -25, '검사 불량 폐기'],
  ['P7-00031', 'ETCH', 100, '재작업 투입'],
  ['P7-00044', 'CMP', -3, '샘플 반출'],
  ['P7-00058', 'IMP', 12, '수량 정정'],
  ['P7-00071', 'DIFF', -8, '파손'],
];
const AS_TEXT = ROWS.map((r) => r.map(String));
const INPUTS = { source: '조정.xlsx' };

function store(columns = COLUMNS, rows = ROWS) {
  const datasets = new DatasetStore();
  datasets.set('src', columns, rows);
  return datasets;
}

function approver(answer: boolean) {
  const requests: ApprovalRequest[] = [];
  return {
    requests,
    ask: async () => '',
    approve: async (r: ApprovalRequest) => {
      requests.push(r);
      return answer;
    },
  };
}

const step = (tool: string, args: object = {}) => ({ tool, args });

beforeEach(() => {
  adjustLog.length = 0;
});

describe('엑셀·CSV 읽기', () => {
  it('엑셀 파일의 첫 시트를 표로 읽는다', async () => {
    const file = await buildWorkbook([{ name: '조정', dataset: { columns: COLUMNS, rows: ROWS } }]);
    expect(await readTable(file, '조정.xlsx')).toEqual({ columns: COLUMNS, rows: ROWS });
  });

  it('CSV의 따옴표, 칸 안 쉼표와 줄바꿈, BOM을 처리한다', async () => {
    const csv = '﻿Lot ID,사유\r\nP7-1,"파손, 폐기"\r\nP7-2,"그는 ""긴급""이라 함\n둘째 줄"\r\n\r\n';
    const table = await readTable(new TextEncoder().encode(csv).buffer as ArrayBuffer, 'a.csv');
    expect(table).toEqual({
      columns: ['Lot ID', '사유'],
      rows: [
        ['P7-1', '파손, 폐기'],
        ['P7-2', '그는 "긴급"이라 함\n둘째 줄'],
      ],
    });
  });

  it('읽을 수 없는 파일은 이유를 알려준다', async () => {
    const enc = (s: string) => new TextEncoder().encode(s).buffer as ArrayBuffer;
    await expect(readTable(enc('x'), 'a.pdf')).rejects.toThrow('xlsx 또는 csv');
    await expect(readTable(enc(''), 'a.csv')).rejects.toThrow('내용이 없습니다');
    await expect(readTable(enc('a,,c\n1,2,3'), 'a.csv')).rejects.toThrow('빈 칸');
    await expect(readTable(enc('a,a\n1,2'), 'a.csv')).rejects.toThrow('두 번');
  });
});

describe('재공 수량 조정 입력 (모의 화면 + 모의 모델)', () => {
  it('엑셀 내용을 표에 채우고 승인 후 그대로 저장한다', async () => {
    const ui = approver(true);
    const result = await runSkill(adjustSkill(), INPUTS, {
      llm: mockLlm,
      browser: new JsdomBrowser(),
      ui,
      files: memoryFiles(),
      datasets: store(),
    });

    expect(result.status, result.message).toBe('done');
    expect(result.message).toBe('5건을 저장했습니다.');
    expect(result.outputs).toEqual({ saved: '5' });
    // 화면의 빈 행은 3개뿐이라 행 추가를 두 번 눌러야 한다. 저장은 한 번, 값은 원본 그대로.
    expect(adjustLog).toEqual([AS_TEXT]);
    // 승인 요청에는 채운 표의 요약이 담긴다.
    expect(ui.requests).toHaveLength(1);
    expect(ui.requests[0].button).toBe('저장');
    expect(ui.requests[0].tables).toEqual([
      { name: '조정 목록', dataset: 'src', columns: COLUMNS, rowCount: 5, preview: AS_TEXT },
    ]);
  });

  it('승인하지 않으면 저장하지 않고, 시험 실행은 승인을 묻지 않는다', async () => {
    const declined = await runSkill(adjustSkill(), INPUTS, {
      llm: mockLlm,
      browser: new JsdomBrowser(),
      ui: approver(false),
      files: memoryFiles(),
      datasets: store(),
    });
    expect(declined.status).toBe('aborted');

    const ui = approver(true);
    const dry = await runSkill(adjustSkill(), INPUTS, {
      llm: mockLlm,
      browser: new JsdomBrowser(),
      ui,
      files: memoryFiles(),
      datasets: store(),
      dryRun: true,
    });
    expect(dry.status).toBe('dryrun');
    expect(ui.requests).toEqual([]);
    expect(adjustLog).toEqual([]);
  });

  it('파일을 읽은 데이터셋이 없으면 시작하지 않는다', async () => {
    const llm = scriptedLlm([step('abort', { reason: 'x' })]);
    const result = await runSkill(adjustSkill(), INPUTS, {
      llm,
      browser: new JsdomBrowser(),
      ui: approver(true),
      files: memoryFiles(),
    });
    expect(result.status).toBe('aborted');
    expect(result.message).toContain('데이터셋 "src"');
    expect(llm.calls).toBe(0);
  });
});

describe('표 입력 통제', () => {
  async function run(datasets: DatasetStore, replies: object[], prepare?: (b: JsdomBrowser) => void) {
    const browser = await JsdomBrowser.open('/adjust.html');
    prepare?.(browser);
    const ui = approver(true);
    const events: RunEvent[] = [];
    const result = await runSkill(adjustSkill(), INPUTS, {
      llm: scriptedLlm([...replies, step('abort', { reason: '끝' })]),
      browser,
      ui,
      files: memoryFiles(),
      datasets,
      onEvent: (e) => events.push(e),
    });
    const actions = events.flatMap((e) => (e.type === 'action' ? [e.entry] : []));
    return { result, ui, actions, browser };
  }
  const fill = step('fill_table', { ref: '조정 목록', dataset: 'src', add_ref: '행 추가' });
  const save = step('click', { ref: '저장' });

  it('표에 없는 컬럼이 있으면 아무것도 넣지 않는다', async () => {
    const { actions, browser } = await run(store(['Lot ID', '공정', '수량', '사유']), [fill]);
    expect(actions[0]).toMatchObject({ tool: 'fill_table', ok: false });
    expect(actions[0].result).toContain('표에 "수량" 컬럼이 없습니다');
    expect([...browser.document.querySelectorAll('td input')].every((i) => (i as HTMLInputElement).value === '')).toBe(true);
  });

  it('선택할 수 없는 값은 몇 행의 무슨 칸인지 알려준다', async () => {
    const rows = ROWS.map((r) => [...r]);
    rows[1][1] = 'WET';
    const { actions, ui, browser } = await run(store(COLUMNS, rows), [fill, save]);
    expect(actions[0].ok).toBe(false);
    expect(actions[0].result).toContain('2행 "공정": "WET"은(는) 선택할 수 없는 값입니다');
    // 문제가 있으면 앞의 멀쩡한 행도 넣지 않는다 (일부만 채워진 표를 남기지 않는다).
    const values = [...browser.document.querySelectorAll('td input, td select')].map((el) => (el as HTMLInputElement).value);
    expect(values.every((v) => v === '')).toBe(true);
    // 입력 단계가 끝나지 않았으므로 저장 단계로 넘어가지 못한다.
    expect(actions[1]).toMatchObject({ step: 2, tool: 'click', ok: false });
    expect(ui.requests).toEqual([]);
    expect(adjustLog).toEqual([]);
  });

  it('숫자 칸에 숫자가 아닌 값은 넣지 않는다', async () => {
    const rows = ROWS.map((r) => [...r]);
    rows[0][2] = '많이';
    const { actions } = await run(store(COLUMNS, rows), [fill]);
    expect(actions[0].ok).toBe(false);
    expect(actions[0].result).toContain('1행 "조정수량"');
  });

  it('이미 값이 들어 있는 표에는 입력하지 않는다', async () => {
    const { actions } = await run(store(), [fill], (b) => {
      (b.document.querySelector('td input') as HTMLInputElement).value = '기존값';
    });
    expect(actions[0].ok).toBe(false);
    expect(actions[0].result).toContain('이미 입력된 값이 있습니다');
  });

  it('행 추가 버튼을 주지 않았는데 빈 행이 모자라면 실패한다', async () => {
    const { actions } = await run(store(), [step('fill_table', { ref: '조정 목록', dataset: 'src' })]);
    expect(actions[0].ok).toBe(false);
    expect(actions[0].result).toContain('빈 행은 3개');
  });

  it('채운 뒤 화면 값이 바뀌면 저장 전 대조에서 걸린다', async () => {
    const browser = await JsdomBrowser.open('/adjust.html');
    const ui = approver(true);
    const events: RunEvent[] = [];
    let calls = 0;
    const result = await runSkill(adjustSkill(), INPUTS, {
      llm: {
        async complete() {
          calls++;
          if (calls === 1) return JSON.stringify(fill);
          if (calls === 2) {
            // 입력이 끝난 뒤 누군가(사용자, 화면 스크립트) 값을 바꾼 상황
            (browser.document.querySelectorAll('td input[type=number]')[2] as HTMLInputElement).value = '-300';
            return JSON.stringify(save);
          }
          return JSON.stringify(step('abort', { reason: '끝' }));
        },
      },
      browser,
      ui,
      files: memoryFiles(),
      datasets: store(),
      onEvent: (e) => events.push(e),
    });
    const actions = events.flatMap((e) => (e.type === 'action' ? [e.entry] : []));
    expect(actions[0]).toMatchObject({ tool: 'fill_table', ok: true });
    expect(actions[1]).toMatchObject({ tool: 'click', ok: false });
    expect(actions[1].result).toContain('3행 "조정수량": 화면 "-300", 원본 "-3"');
    expect(ui.requests).toEqual([]);
    expect(adjustLog).toEqual([]);
    expect(result.status).toBe('aborted');
  });

  it('조회 전용 스킬은 표에 값을 넣을 수 없다', async () => {
    const events: RunEvent[] = [];
    await runSkill({ ...adjustSkill(), risk: 'R1' }, INPUTS, {
      llm: scriptedLlm([fill, step('abort', { reason: '끝' })]),
      browser: await JsdomBrowser.open('/adjust.html'),
      ui: approver(true),
      files: memoryFiles(),
      datasets: store(),
      onEvent: (e) => events.push(e),
    });
    expect(events.filter((e) => e.type === 'blocked')).toMatchObject([{ tool: 'fill_table' }]);
  });
});
