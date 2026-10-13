import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'vitest';
import { mergeFrames, renderSnapshot } from '../src/core';
import { createPageAgent } from '../src/page/agent';

function page(html: string) {
  const dom = new JSDOM(`<!doctype html><title>시험</title><body>${html}</body>`, { url: 'http://localhost:4173/t' });
  const agent = createPageAgent(dom.window as any);
  const render = () => renderSnapshot(mergeFrames([{ frame: 0, snap: agent.snapshot() }]).snapshot);
  return { dom, doc: dom.window.document, agent, render };
}

describe('snapshot', () => {
  it('조작 가능한 요소에 ref를 붙이고 이름을 찾는다', () => {
    const { render } = page(`
      <h1>재공 현황</h1>
      <label for="line">라인</label>
      <select id="line"><option>6라인</option><option selected>8라인</option></select>
      <label>제품 <input value="DR5"></label>
      <input placeholder="검색어">
      <button>조회</button>
      <input type="submit" value="엑셀" disabled>
      <a href="/x">도움말</a>
      <div role="tab" aria-label="요약 탭">요약</div>
      <p>총 128건</p>
    `);
    expect(render()).toBe(
      [
        '[page] 시험 — http://localhost:4173/t',
        '# 재공 현황',
        '[1] combobox "라인" value="8라인" options=[6라인, 8라인]',
        '[2] textbox "제품" value="DR5"',
        '[3] textbox "검색어" value=""',
        '[4] button "조회"',
        '[5] button "엑셀" (비활성)',
        '[6] link "도움말"',
        '[7] tab "요약 탭"',
        '총 128건',
      ].join('\n'),
    );
  });

  it('숨겨진 요소와 스크립트는 빼고, 비밀번호 입력란은 값 없이 존재만 알린다', () => {
    const { agent } = page(`
      <button style="display:none">숨김1</button>
      <div hidden><button>숨김2</button></div>
      <div aria-hidden="true"><button>숨김3</button></div>
      <script>var x = "스크립트"</script>
      <input type="hidden" value="토큰">
      <input type="password" value="비밀">
      <button>보임</button>
    `);
    const snap = agent.snapshot();
    expect(snap.hasPassword).toBe(true);
    expect(JSON.stringify(snap.items)).not.toMatch(/숨김|스크립트|토큰|비밀/);
    expect(snap.items).toEqual([{ kind: 'el', ref: 1, role: 'button', name: '보임' }]);
  });

  it('표는 내용 대신 행 수와 컬럼만 요약한다', () => {
    const { render } = page(`
      <table aria-label="재공 목록">
        <thead><tr><th>Lot ID</th><th>수량</th></tr></thead>
        <tbody><tr><td>P8-1</td><td>1,200</td></tr><tr><td>P8-2</td><td>30</td></tr></tbody>
      </table>
    `);
    const text = render();
    expect(text).toContain('[1] table "재공 목록" rows=2 cols=[Lot ID, 수량]');
    expect(text).not.toContain('P8-1');
  });
});

describe('actions', () => {
  it('select는 보이는 글자로 고르고 change 이벤트를 낸다', () => {
    const { agent, doc } = page(`<select id="s"><option value="a">6라인</option><option value="b">8라인</option></select>`);
    let changed = 0;
    doc.getElementById('s')!.addEventListener('change', () => changed++);
    agent.snapshot();
    expect(agent.select(1, '8라인')).toEqual({ ok: true, message: '"8라인" 선택함' });
    expect((doc.getElementById('s') as HTMLSelectElement).value).toBe('b');
    expect(changed).toBe(1);
    const miss = agent.select(1, '9라인');
    expect(miss.ok).toBe(false);
    expect(miss.message).toContain('6라인, 8라인');
  });

  it('type은 값을 바꾸고 input 이벤트를 낸다', () => {
    const { agent, doc } = page(`<input id="i" value="전">`);
    const seen: string[] = [];
    doc.getElementById('i')!.addEventListener('input', (e) => seen.push((e.target as HTMLInputElement).value));
    agent.snapshot();
    expect(agent.type(1, '후').ok).toBe(true);
    expect(seen).toEqual(['후']);
  });

  it('화면에서 사라진 요소는 오류로 알린다', () => {
    const { agent, doc } = page(`<button id="b">가</button>`);
    agent.snapshot();
    doc.getElementById('b')!.remove();
    expect(agent.click(1)).toEqual({ ok: false, message: 'ref 1 요소가 화면에서 사라졌습니다' });
  });
});

describe('extractTable', () => {
  it('table 요소를 읽는다', () => {
    const { agent } = page(`
      <table>
        <thead><tr><th>Lot ID</th><th>수량</th></tr></thead>
        <tbody><tr><td> P8-1 </td><td>1,200</td></tr><tr><td>P8-2</td><td>30</td></tr></tbody>
        <tfoot><tr><td>합계</td><td>1,230</td></tr></tfoot>
      </table>
    `);
    agent.snapshot();
    expect(agent.extractTable(1)).toEqual({ columns: ['Lot ID', '수량'], rows: [['P8-1', '1,200'], ['P8-2', '30']] });
  });

  it('thead 없이 첫 행이 th인 표를 읽는다', () => {
    const { agent } = page(`<table><tr><th>a</th><th>b</th></tr><tr><td>1</td><td>2</td></tr></table>`);
    agent.snapshot();
    expect(agent.extractTable(1)).toEqual({ columns: ['a', 'b'], rows: [['1', '2']] });
  });

  it('role=grid로 만든 표를 읽는다', () => {
    const { agent, render } = page(`
      <div role="grid" aria-label="그리드">
        <div role="row"><span role="columnheader">Lot</span><span role="columnheader">상태</span></div>
        <div role="row"><span role="gridcell">A</span><span role="gridcell">RUN</span></div>
      </div>
    `);
    expect(render()).toContain('[1] table "그리드" rows=1 cols=[Lot, 상태]');
    expect(agent.extractTable(1)).toEqual({ columns: ['Lot', '상태'], rows: [['A', 'RUN']] });
  });
});
