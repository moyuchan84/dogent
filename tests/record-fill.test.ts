import { beforeEach, describe, expect, it } from 'vitest';
import {
  DatasetStore,
  addRecorded,
  addRowButtons,
  draftSkill,
  fillableColumns,
  lintSkill,
  parseSkill,
  runSkill,
  type ApprovalRequest,
  type AuthorStep,
  type LlmPort,
  type RecordedEvent,
} from '../src/core';
import { createPageAgent } from '../src/page/agent';
import { JsdomBrowser, adjustLog, memoryFiles } from './helpers';

const META = { id: 'adjust-recorded', name: '수량 조정(녹화)', description: '녹화로 만든 재공 수량 조정', owner: '생산관리' };
const COLUMNS = ['Lot ID', '공정', '조정수량', '사유'];
const ROWS = [
  ['P7-00012', 'PHOTO', -25, '검사 불량 폐기'],
  ['P7-00031', 'ETCH', 100, '재작업 투입'],
  ['P7-00044', 'CMP', -3, '샘플 반출'],
  ['P7-00058', 'IMP', 12, '수량 정정'],
];

const noLlm: LlmPort = {
  async complete() {
    throw new Error('모델이 호출되면 안 됩니다');
  },
};

beforeEach(() => {
  adjustLog.length = 0;
});

/** 사람이 한 행을 손으로 넣어 보이고, 표를 엑셀로 채우기로 한 뒤, 저장을 누른다. */
async function record() {
  const browser = await JsdomBrowser.open('/adjust.html');
  const win = browser.dom.window as unknown as Window & typeof globalThis;
  let steps: AuthorStep[] = [];
  const agent = createPageAgent(win, (e: RecordedEvent) => (steps = addRecorded(steps, e)));
  agent.record(true);
  const start = await browser.snapshot();

  const doc = browser.document;
  const controls = [...doc.querySelectorAll<HTMLInputElement | HTMLSelectElement>('#adjGrid tbody tr:first-child input, #adjGrid tbody tr:first-child select')];
  ['P7-00001', 'PHOTO', '5', '해 보이기'].forEach((value, i) => {
    controls[i].value = value;
    controls[i].dispatchEvent(new win.Event('change', { bubbles: true }));
  });
  (doc.getElementById('addRow') as HTMLElement).click();

  // 패널의 "엑셀로 표 채우기 추가"가 하는 일
  const snap = await browser.snapshot();
  const table = snap.items.find((i) => i.kind === 'el' && i.role === 'table')!;
  if (table.kind !== 'el') throw new Error('표가 없습니다');
  const columns = fillableColumns(snap, (await browser.extractTable(table.ref)).columns);
  const buttons = addRowButtons(snap);
  steps = [...steps, { kind: 'fill', name: table.name, columns, add: buttons[0] }];

  (doc.getElementById('save') as HTMLElement).click();
  await new Promise((r) => setTimeout(r, 600));
  agent.record(false);
  steps = steps.map((s) => (s.kind === 'click' && s.name === '저장' ? { ...s, expect: '저장되었습니다' } : s));
  return { steps, start, columns, buttons };
}

describe('엑셀로 표 채우기 녹화', () => {
  it('값을 넣을 수 있는 컬럼과 행 추가 버튼을 화면에서 찾는다', async () => {
    const { columns, buttons } = await record();
    // "No" 컬럼은 입력 칸이 없어 엑셀 파일에 넣지 않는다.
    expect(columns).toEqual(COLUMNS);
    expect(buttons).toEqual(['행 추가']);
  });

  it('손으로 넣어 보인 값은 빠지고 파일 입력과 fill_table 단계가 된다', async () => {
    const { steps, start } = await record();
    expect(steps.filter((s) => s.kind === 'type' || s.kind === 'select')).toHaveLength(4);
    const { source, notes } = draftSkill(META, { url: start.url, heading: '재공 수량 조정' }, steps);
    const skill = parseSkill(source);

    expect(skill.inputs).toEqual([{ name: 'file1', label: '엑셀 파일 (Lot ID, 공정, 조정수량, 사유)', type: 'file', dataset: 'src1', required: true }]);
    expect(skill.steps.map((s) => s.split('으로 ')[0].split('로 ')[0])).toEqual(['navigate', 'fill_table', 'click', 'finish']);
    expect(source).toContain('`{"ref":"조정 목록","dataset":"src1","add_ref":"행 추가"}`');
    expect([skill.risk, skill.submit_steps, skill.submit_labels]).toEqual(['R3', [3], ['저장']]);
    expect(source).toContain('{rows.src1}행을 표에 입력하고');
    expect(notes[0]).toBe('표에 직접 넣은 값과 행 추가 누름 5개는 뺐습니다. 실행할 때는 엑셀 파일의 행이 표에 들어갑니다.');

    const report = lintSkill(source);
    expect(report.findings.filter((f) => f.level === 'error')).toEqual([]);
    expect(report.deployable).toBe(true);
    expect(report.direct).toEqual({ count: 4, total: 4 });
  });

  it('만든 초안은 모델 없이 엑셀의 행을 채우고, 승인을 받은 뒤 저장한다', async () => {
    const { steps, start } = await record();
    adjustLog.length = 0;
    const skill = parseSkill(draftSkill(META, { url: start.url, heading: '재공 수량 조정' }, steps).source);
    const datasets = new DatasetStore();
    datasets.set('src1', COLUMNS, ROWS);
    const requests: ApprovalRequest[] = [];
    const r = await runSkill(skill, { file1: '조정.xlsx' }, {
      llm: noLlm,
      browser: await JsdomBrowser.open('/adjust.html'),
      ui: { ask: async () => '', approve: async (req) => (requests.push(req), true) },
      files: memoryFiles(),
      datasets,
      direct: true,
    });
    expect(r).toMatchObject({ status: 'done', message: '4행을 표에 입력하고 수량 조정(녹화)을(를) 마쳤습니다.' });
    expect(requests).toHaveLength(1);
    expect(adjustLog).toEqual([ROWS.map((row) => row.map(String))]);
  });

  it('행 추가 버튼을 정하지 않으면 그 사실을 알린다', () => {
    const { source, notes } = draftSkill(META, { url: 'http://localhost:4173/adjust.html' }, [{ kind: 'fill', name: '조정 목록', columns: COLUMNS }]);
    expect(source).toContain('`{"ref":"조정 목록","dataset":"src1"}`');
    expect(notes.some((n) => n.includes('행 추가 버튼을 정하지 않아'))).toBe(true);
    expect(lintSkill(source).findings.filter((f) => f.level === 'error')).toEqual([]);
  });
});
