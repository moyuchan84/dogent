import { describe, expect, it } from 'vitest';
import {
  buildFreeSkill,
  buildTurnMessages,
  describeDocs,
  noBrowser,
  officeIntent,
  parseSkill,
  runSkill,
  skillUsesOffice,
  type Cell,
  type OfficePort,
  type RunEvent,
} from '../src/core';
import { JsdomBrowser, memoryFiles, scriptedLlm } from './helpers';

const step = (tool: string, args: object = {}) => ({ tool, args });

/** 사용자 Excel 대신 메모리에 문서 몇 개를 둔 통로. 쓴 내용과 저장 호출을 기록한다. */
function fakeOffice() {
  const books: Record<string, { sheets: Record<string, { columns: string[]; rows: Cell[][] }>; readOnly?: boolean }> = {
    '재공.xlsx': {
      sheets: {
        Sheet1: {
          columns: ['LOT', '수량'],
          rows: [
            ['L1', 10],
            ['L2', 20],
            ['L3', 5],
          ],
        },
        메모: { columns: ['글'], rows: [['a']] },
      },
    },
  };
  const calls: string[] = [];
  const port: OfficePort = {
    docs: async () => Object.entries(books).map(([name, b]) => ({ name, fullName: `C:\\edm\\${name}`, readOnly: !!b.readOnly })),
    read: async (doc, opts) => {
      calls.push(`read ${doc}`);
      const b = books[doc];
      if (!b) throw new Error(`열린 엑셀 문서 "${doc}"을(를) 잡지 못했습니다`);
      const name = opts.sheet ?? Object.keys(b.sheets)[0];
      const t = b.sheets[name];
      return { sheet: name, sheets: Object.keys(b.sheets), columns: t.columns, rows: t.rows.map((r) => [...r]), total: t.rows.length };
    },
    write: async (doc, sheet, table, start) => {
      calls.push(`write ${doc} ${sheet} ${start ?? 'A1'}`);
      books[doc].sheets[sheet] = { columns: table.columns, rows: table.rows.map((r) => [...r]) };
      return `${doc}의 "${sheet}" 시트`;
    },
    save: async (doc, path) => {
      calls.push(`save ${doc} ${path ?? '(원본)'}`);
      return path ?? `C:\\edm\\${doc}`;
    },
  };
  return { port, books, calls };
}

const ui = (answer: boolean) => ({
  ask: async () => '',
  approve: async () => false,
  confirm: async () => answer,
});

const run = (llm: ReturnType<typeof scriptedLlm>, o: { office?: OfficePort; allowWrite?: boolean; answer?: boolean; dryRun?: boolean; request?: string }) => {
  const events: RunEvent[] = [];
  const files = memoryFiles();
  const done = runSkill(
    buildFreeSkill(null, o.allowWrite ?? false, undefined, true),
    { request: o.request ?? '엑셀 정리' },
    { llm, browser: noBrowser(), office: o.office, ui: ui(o.answer ?? true), files, onEvent: (e) => events.push(e), dryRun: o.dryRun },
  );
  return done.then((result) => ({ result, events, files }));
};

describe('엑셀 도구 (자유 요청, 브라우저 없음)', () => {
  it('열린 문서를 읽고 가공해 새 엑셀로 저장한다', async () => {
    const { port, calls } = fakeOffice();
    const llm = scriptedLlm([
      step('excel_read', { doc: '재공.xlsx', dataset: 'wip' }),
      step('transform', { source: 'wip', target: 'big', steps: [{ op: 'filter', match: 'all', where: [{ col: '수량', cmp: '>=', value: 10 }] }] }),
      step('write_excel', { filename: '큰것', sheets: [{ name: '결과', dataset: 'big' }] }),
      step('finish', { summary: '{rows.big}건 정리' }),
    ]);
    const { result, files } = await run(llm, { office: port });
    expect(result.status, result.message).toBe('done');
    expect(result.message).toBe('2건 정리');
    expect(calls).toEqual(['read 재공.xlsx']);
    expect([...files.saved.keys()]).toEqual(['큰것.xlsx']);
  });

  it('없는 문서는 실패 결과를 돌려주고 모델이 이어서 판단한다', async () => {
    const { port } = fakeOffice();
    const llm = scriptedLlm([step('excel_read', { doc: '없는.xlsx', dataset: 'x' }), step('abort', { reason: '문서가 없음' })]);
    const { result, events } = await run(llm, { office: port });
    expect(result.status).toBe('aborted');
    const action = events.find((e) => e.type === 'action' && !e.entry.ok);
    expect(action && action.type === 'action' && action.entry.result).toContain('잡지 못했습니다');
  });

  it('엑셀 문서를 바꾸는 도구는 쓰기를 허용하지 않으면 막힌다', async () => {
    const { port, calls } = fakeOffice();
    const llm = scriptedLlm([
      step('excel_read', { doc: '재공.xlsx', dataset: 'wip' }),
      step('excel_write', { doc: '재공.xlsx', dataset: 'wip', sheet: '새시트' }),
      step('abort', { reason: '막힘' }),
    ]);
    const { events } = await run(llm, { office: port, allowWrite: false });
    expect(events.some((e) => e.type === 'blocked' && e.tool === 'excel_write')).toBe(true);
    expect(calls.some((c) => c.startsWith('write'))).toBe(false);
  });

  it('쓰기를 허용해도 사용자가 허락해야 쓴다', async () => {
    const yes = fakeOffice();
    const steps = [
      step('excel_read', { doc: '재공.xlsx', dataset: 'wip' }),
      step('excel_write', { doc: '재공.xlsx', dataset: 'wip', sheet: '정리', start: 'B2' }),
      step('finish', { summary: '끝' }),
    ];
    await run(scriptedLlm(steps), { office: yes.port, allowWrite: true, answer: true });
    expect(yes.calls).toContain('write 재공.xlsx 정리 B2');
    expect(yes.books['재공.xlsx'].sheets['정리'].rows).toHaveLength(3);

    const no = fakeOffice();
    const { events } = await run(scriptedLlm([...steps.slice(0, 2), step('abort', { reason: '거절됨' })]), { office: no.port, allowWrite: true, answer: false });
    expect(no.calls.some((c) => c.startsWith('write'))).toBe(false);
    const refused = events.find((e) => e.type === 'action' && e.entry.tool === 'excel_write');
    expect(refused && refused.type === 'action' && refused.entry.result).toContain('허락하지 않았습니다');
  });

  it('열린 곳에 저장은 쓰기 허용이 필요하고, 다른 이름 저장은 늘 허락을 거쳐 된다', async () => {
    const a = fakeOffice();
    const { events } = await run(scriptedLlm([step('excel_save', { doc: '재공.xlsx' }), step('abort', { reason: 'x' })]), { office: a.port });
    expect(events.some((e) => e.type === 'blocked' && e.tool === 'excel_save')).toBe(true);
    expect(a.calls).toEqual([]);

    const b = fakeOffice();
    await run(scriptedLlm([step('excel_save', { doc: '재공.xlsx', path: 'D:\\out\\사본.xlsx' }), step('finish', { summary: '저장' })]), { office: b.port });
    expect(b.calls).toEqual(['save 재공.xlsx D:\\out\\사본.xlsx']);
  });

  it('시험 실행이면 쓰기 직전에 멈추고 쓰지 않는다', async () => {
    const { port, calls } = fakeOffice();
    const llm = scriptedLlm([
      step('excel_read', { doc: '재공.xlsx', dataset: 'wip' }),
      step('excel_write', { doc: '재공.xlsx', dataset: 'wip', sheet: '정리' }),
    ]);
    const { result } = await run(llm, { office: port, allowWrite: true, dryRun: true });
    expect(result.status).toBe('dryrun');
    expect(calls.some((c) => c.startsWith('write'))).toBe(false);
  });

  it('브라우저 화면 동작은 막힌다', async () => {
    const { port } = fakeOffice();
    const llm = scriptedLlm([step('click', { ref: 1 }), step('abort', { reason: '브라우저 없음' })]);
    const { events } = await run(llm, { office: port });
    expect(events.some((e) => e.type === 'blocked' && e.tool === 'click')).toBe(true);
  });

  it('오피스 도구가 없으면 엑셀 도구는 실패한다', async () => {
    const llm = scriptedLlm([step('excel_docs'), step('abort', { reason: '없음' })]);
    const { events } = await run(llm, {});
    const a = events.find((e) => e.type === 'action' && e.entry.tool === 'excel_docs');
    expect(a && a.type === 'action' && a.entry.result).toContain('엑셀 도구를 쓸 수 없습니다');
  });
});

describe('엑셀과 브라우저를 함께', () => {
  it('엑셀을 읽어 화면의 표에 채운다', async () => {
    const { port } = fakeOffice();
    const browser = await JsdomBrowser.open('/adjust.html');
    const snap = await browser.snapshot();
    const table = snap.items.find((i) => i.kind === 'el' && i.role === 'table');
    expect(table).toBeTruthy();
    const llm = scriptedLlm([
      step('excel_read', { doc: '재공.xlsx', dataset: 'wip' }),
      step('transform', { source: 'wip', target: 'rows', steps: [{ op: 'select', cols: ['LOT', '수량'] }] }),
      step('finish', { summary: '{rows.rows}행 준비' }),
    ]);
    const result = await runSkill(
      buildFreeSkill('http://localhost:4173/adjust.html', false, undefined, true),
      { request: '열린 재공 엑셀을 조정 화면에 입력' },
      { llm, browser, office: port, ui: ui(true), files: memoryFiles() },
    );
    expect(result.status, result.message).toBe('done');
    expect(result.message).toBe('3행 준비');
  });
});

describe('프롬프트와 판정', () => {
  const skill = buildFreeSkill(null, false, undefined, true);
  const base = { skill, body: skill.body, inputs: {}, history: [], datasets: '(없음)', page: '', step: { n: 1, total: 1, text: 'x', unmet: null }, changes: null };

  it('엑셀을 쓸 수 있을 때만 엑셀 도구와 열린 문서를 보여 준다', () => {
    const on = buildTurnMessages({ ...base, office: describeDocs([{ name: '재공.xlsx', fullName: 'C:\\edm\\재공.xlsx', readOnly: true }]) });
    expect(on[0].content).toContain('excel_read');
    expect(on[1].content).toContain('## 열려 있는 엑셀 문서');
    expect(on[1].content).toContain('재공.xlsx (읽기 전용)');
    const off = buildTurnMessages(base);
    expect(off[0].content).not.toContain('excel_read');
    expect(off[1].content).not.toContain('## 열려 있는 엑셀 문서');
  });

  it('요청에서 엑셀과 브라우저 필요 여부를 가린다', () => {
    expect(officeIntent('열린 엑셀에서 라인별 합계 구해줘')).toEqual({ excel: true, web: false });
    expect(officeIntent('D:\\자료\\재공.xlsx 정리해줘')).toEqual({ excel: true, web: false });
    expect(officeIntent('재공현황 문서 정리해줘', { openDocs: ['재공현황.xlsx'] })).toEqual({ excel: true, web: false });
    expect(officeIntent('엑셀 값을 MES 화면에 입력해줘')).toEqual({ excel: true, web: true });
    expect(officeIntent('엑셀 정리해서 올려줘', { hasSystem: true })).toEqual({ excel: true, web: true });
    expect(officeIntent('8라인 재공 조회해줘')).toEqual({ excel: false, web: false });
  });

  it('엑셀 도구나 파일 입력을 쓰는 스킬을 알아본다', () => {
    const make = (extra: string, input = '') =>
      parseSkill(`---\nid: t\nname: t\ndescription: d\nversion: 0.1.0\nowner: x\nrisk: R1\ndomains: [a.b]\ninputs:\n${input || '  - name: q\n    label: q\n    type: text'}\n---\n\n## 단계\n\n1. ${extra}\n`);
    expect(skillUsesOffice(make('excel_read로 읽는다.'))).toBe(true);
    expect(skillUsesOffice(make('화면을 본다.'))).toBe(false);
    expect(skillUsesOffice(make('화면을 본다.', '  - name: f\n    label: f\n    type: file\n    dataset: d'))).toBe(true);
  });
});
