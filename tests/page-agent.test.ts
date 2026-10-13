import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'vitest';
import { addRecorded, draftSkill, mergeFrames, parseAction, renderSnapshot, type RecordedEvent } from '../src/core';
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

describe('화면 표시', () => {
  it('포인터와 조작 중 표시는 스냅샷과 글자 검색에 잡히지 않는다', () => {
    const { agent, doc, render } = page(`<button id="b">조회</button><p>총 3건</p>`);
    const before = render();
    agent.setActive(true);
    expect(agent.point(1, '클릭')).toBe(true);

    const host = doc.querySelector('[data-dogent-overlay]')!;
    expect(host).not.toBeNull();
    expect(host.parentElement).toBe(doc.documentElement);
    expect(render()).toBe(before);
    expect(agent.hasText('클릭')).toBe(false);
    expect(agent.hasText('Dogent')).toBe(false);
    expect(agent.hasText('총 3건')).toBe(true);

    // 다시 표시해도 겹쳐 만들지 않는다.
    agent.point(1, '입력');
    expect(doc.querySelectorAll('[data-dogent-overlay]')).toHaveLength(1);
  });

  it('사라진 요소는 가리키지 않는다', () => {
    const { agent, doc } = page(`<button id="b">가</button>`);
    agent.snapshot();
    doc.getElementById('b')!.remove();
    expect(agent.point(1, '클릭')).toBe(false);
    expect(doc.querySelector('[data-dogent-overlay]')).toBeNull();
  });
});

describe('표 안의 요소', () => {
  const LOTS = `
    <table>
      <caption>홀드 Lot</caption>
      <thead><tr><th>Lot ID</th><th>공정</th><th></th></tr></thead>
      <tbody>
        <tr><td>P7-00012</td><td>PHOTO</td><td><button id="a">선택</button></td></tr>
        <tr><td>P7-00031</td><td>ETCH</td><td><button id="b">선택</button> <a href="/d/31">상세</a></td></tr>
      </tbody>
    </table>
    <button>닫기</button>`;

  it('표 아래에 칸 안의 버튼·링크를 행 글자와 함께 내보낸다', () => {
    const { render } = page(LOTS);
    expect(render()).toBe(
      [
        '[page] 시험 — http://localhost:4173/t',
        '[1] table "홀드 Lot" rows=2 cols=[Lot ID, 공정, ]',
        '[2] button "선택" row="P7-00012 | PHOTO | 선택"',
        '[3] button "선택" row="P7-00031 | ETCH | 선택 상세"',
        '[4] link "상세" row="P7-00031 | ETCH | 선택 상세"',
        '[5] button "닫기"',
      ].join('\n'),
    );
  });

  it('행 안의 버튼을 ref로 누른다', () => {
    const { agent, doc } = page(LOTS);
    let clicked = '';
    doc.getElementById('b')!.addEventListener('click', () => (clicked = 'b'));
    agent.snapshot();
    expect(agent.click(3).ok).toBe(true);
    expect(clicked).toBe('b');
  });

  it('이름과 row로 적은 ref를 그 행의 요소로 바꾼다', () => {
    const { agent } = page(LOTS);
    const snap = mergeFrames([{ frame: 0, snap: agent.snapshot() }]).snapshot;
    const act = (args: object) => parseAction(JSON.stringify({ tool: 'click', args }), snap);
    expect(act({ ref: '선택', row: 'P7-00031' })).toMatchObject({ ok: true, action: { args: { ref: 3 } } });
    expect(act({ ref: '상세' })).toMatchObject({ ok: true, action: { args: { ref: 4 } } });
    const dup = act({ ref: '선택' });
    expect(dup.ok).toBe(false);
    expect(!dup.ok && dup.error).toContain('row="P7-00012');
    const none = act({ ref: '선택', row: 'P9-99999' });
    expect(!none.ok && none.error).toContain('"P9-99999" 글자가 있는 행에');
  });

  it('입력 칸이 있는 표는 칸의 값으로 행을 적고, 너무 많으면 줄인다', () => {
    const rows = Array.from({ length: 40 }, (_, i) => `<tr><td><input value="L${i}"></td><td><input value="${i}"></td></tr>`);
    const { render } = page(`<table><thead><tr><th>Lot</th><th>수량</th></tr></thead><tbody>${rows.join('')}</tbody></table>`);
    const lines = render().split('\n');
    expect(lines[2]).toBe('[2] textbox "Lot" value="L0" row="L0 | 0"');
    expect(lines.filter((l) => l.includes('textbox'))).toHaveLength(60);
    expect(lines.at(-1)).toBe('(표 안의 나머지 요소는 생략됨)');
  });

  it('머리글 없이 입력란을 담은 table은 배치용으로 보고 안을 그대로 읽는다', () => {
    const { render } = page(`
      <table><tr><td>라인</td><td><input aria-label="라인" value="8"></td><td><button>조회</button></td></tr></table>
      <table><tr><td>가</td><td>1</td></tr></table>`);
    expect(render()).toBe(
      [
        '[page] 시험 — http://localhost:4173/t',
        '라인',
        '[1] textbox "라인" value="8"',
        '[2] button "조회"',
        '[3] table "표" rows=1 cols=[]',
      ].join('\n'),
    );
  });

  it('녹화할 때 행마다 있는 버튼은 행을 가릴 글자를 함께 적는다', () => {
    const dom = new JSDOM(`<!doctype html><body>${LOTS}</body>`, { url: 'http://localhost:4173/t' });
    const events: RecordedEvent[] = [];
    createPageAgent(dom.window as any, (e) => events.push(e)).record(true);
    dom.window.document.getElementById('b')!.click();
    expect(events).toEqual([{ kind: 'click', role: 'button', name: '선택', dup: true, row: 'P7-00031' }]);
    const { source, notes } = draftSkill(
      { id: 'lot-pick', name: 'Lot 고르기', description: '표에서 Lot을 고른다', owner: '생산관리' },
      { url: 'http://localhost:4173/t' },
      addRecorded([], events[0]),
    );
    expect(source).toContain('`{"ref":"선택","row":"P7-00031"}`');
    expect(notes.join('\n')).toContain('"row"를 {입력값}으로');
  });
});
