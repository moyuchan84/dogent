import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'vitest';
import { diagnose, renderInspection, unreadFrames, type FrameInspection, type SiteInspection } from '../src/core';
import { createPageAgent } from '../src/page/agent';

function inspect(html: string, url = 'http://mes.example.internal/wip/list?line=7') {
  const dom = new JSDOM(`<!doctype html><title>재공 현황</title><body>${html}</body>`, { url });
  return { dom, frame: createPageAgent(dom.window as any).inspect() };
}

const site = (...frames: FrameInspection[]): SiteInspection => ({ url: frames[0].url, readable: true, frames });

const BUSY_PAGE = `
  <label for="line">라인</label><select id="line"><option>7라인</option></select>
  <button>조회</button><button>엑셀 다운로드</button><button>다음</button>
  <button class="icon"></button><button class="icon"></button><input class="bare"><label>사유 <input value="비밀값-입력"></label>
  <table id="wipTable"><thead><tr><th>Lot ID</th><th>공정</th></tr></thead>
    <tbody><tr><td>P7-00012</td><td>PHOTO</td></tr><tr><td>P7-00031</td><td>ETCH</td></tr></tbody></table>
  <table id="adjTable"><thead><tr><th>Lot ID</th><th>수량</th></tr></thead>
    <tbody><tr><td><input></td><td><input></td></tr><tr><td><input></td><td><input></td></tr><tr><td></td><td></td></tr></tbody></table>
  <div role="grid" aria-label="붙여넣기 그리드">
    <div role="row"><span role="columnheader">Lot ID</span><span role="columnheader">사유</span></div>
    <div role="row"><span role="gridcell"></span><span role="gridcell"></span></div>
  </div>
  <canvas width="900" height="400"></canvas><canvas width="24" height="24"></canvas>
  <x-picker></x-picker>
  <iframe src="http://report.example.internal/frame"></iframe>
  <iframe src="/same-origin"></iframe>
`;

describe('화면 점검: 페이지 쪽', () => {
  it('표·그리드·canvas·웹 컴포넌트·iframe·내려받기·페이지 버튼과 이름 없는 요소를 센다', () => {
    const { dom, frame } = (() => {
      const r = inspect('');
      r.dom.window.document.body.innerHTML = BUSY_PAGE;
      const picker = r.dom.window.document.querySelector('x-picker')!;
      picker.attachShadow({ mode: 'open' }).innerHTML = '<input><button>선택</button>';
      return { dom: r.dom, frame: createPageAgent(r.dom.window as any).inspect() };
    })();
    expect(dom).toBeTruthy();
    expect(frame.title).toBe('재공 현황');
    expect(frame.hasPassword).toBe(false);
    expect(frame.tables).toEqual([
      { name: 'wipTable', kind: 'table', rows: 2, columns: ['Lot ID', '공정'], inputRows: 0 },
      { name: 'adjTable', kind: 'table', rows: 3, columns: ['Lot ID', '수량'], inputRows: 2 },
      { name: '붙여넣기 그리드', kind: 'grid', rows: 1, columns: ['Lot ID', '사유'], inputRows: 0 },
    ]);
    expect(frame.canvases).toEqual([{ width: 900, height: 400 }]);
    expect(frame.shadowHosts).toEqual([{ tag: 'x-picker', controls: 2 }]);
    expect(frame.frames).toEqual(['http://report.example.internal/frame', 'http://mes.example.internal/same-origin']);
    expect(frame.downloads).toEqual(['엑셀 다운로드']);
    expect(frame.pagers).toEqual(['다음']);
    expect(frame.unnamed).toEqual({ button: 2, textbox: 1 });
  });

  it('비밀번호 칸이 있으면 로그인 화면으로 본다', () => {
    const { frame } = inspect('<input name="id"><input type="password"><button>로그인</button>');
    expect(frame.hasPassword).toBe(true);
  });
});

describe('화면 점검: 판정과 보고서', () => {
  function busy() {
    const r = inspect('');
    r.dom.window.document.body.innerHTML = BUSY_PAGE;
    r.dom.window.document.querySelector('x-picker')!.attachShadow({ mode: 'open' }).innerHTML = '<input><button>선택</button>';
    return r.dom.window;
  }

  it('허용 목록 밖의 탭은 막힘이고, 넣어야 할 줄을 알려 준다', () => {
    const d = diagnose({ url: 'https://mes.example.internal/wip?id=3', readable: false, frames: [] });
    expect(d.verdict).toBe('blocked');
    expect(d.findings[0].fix).toContain("'https://mes.example.internal/*'");
  });

  it('읽지 못한 iframe의 출처를 찾아 막힘으로 판정한다', () => {
    const top = createPageAgent(busy() as any).inspect();
    const inner = inspect('<button>조회</button>', 'http://mes.example.internal/same-origin').frame;
    expect(unreadFrames([top, inner])).toEqual(['http://report.example.internal']);
    const d = diagnose(site(top, inner));
    expect(d.verdict).toBe('blocked');
    const frameFinding = d.findings.find((f) => f.title.startsWith('읽지 못한 iframe'))!;
    expect(frameFinding.fix).toContain("'http://report.example.internal/*'");
    // 막힘이 맨 앞에, 그다음 확인할 것
    expect(d.findings.map((f) => f.level)).toEqual([...d.findings.map((f) => f.level)].sort((a, b) => ['fail', 'warn', 'ok', 'info'].indexOf(a) - ['fail', 'warn', 'ok', 'info'].indexOf(b)));
    expect(d.findings.some((f) => f.title === '그림으로 그린 영역 1개' && f.fix?.includes('엑셀 다운로드'))).toBe(true);
    expect(d.findings.some((f) => f.title.startsWith('웹 컴포넌트 안의 요소 2개'))).toBe(true);
    expect(d.findings.some((f) => f.title.startsWith('표 "adjTable" (http://mes.example.internal/wip/list)') && f.title.endsWith('3행, 열 2개') && f.detail?.includes('fill_table'))).toBe(true);
  });

  it('막힌 곳이 없고 평범한 화면이면 녹화해 볼 만하다고 본다', () => {
    const { frame } = inspect(`
      <label for="line">라인</label><select id="line"><option>7라인</option></select><button>조회</button>
      <table><thead><tr><th>Lot ID</th></tr></thead><tbody><tr><td>P7-1</td></tr></tbody></table>`);
    expect(diagnose(site(frame)).verdict).toBe('ready');
  });

  it('보고서에는 화면의 값이 들어가지 않고, 가리면 라벨과 주소도 빠진다', () => {
    const top = createPageAgent(busy() as any).inspect();
    const plain = renderInspection(site(top), { hide: false, at: new Date('2026-10-16T00:00:00Z') });
    expect(plain).toContain('http://mes.example.internal/wip/list');
    expect(plain).not.toContain('line=7');
    expect(plain).toContain('Lot ID');
    for (const value of ['P7-00012', 'PHOTO', '비밀값-입력']) expect(plain).not.toContain(value);

    const hidden = renderInspection(site(top), { hide: true, at: new Date('2026-10-16T00:00:00Z') });
    for (const text of ['mes.example.internal', 'report.example.internal', 'Lot ID', 'adjTable', '엑셀 다운로드', '재공 현황', 'P7-00012']) {
      expect(hidden).not.toContain(text);
    }
    expect(hidden).toContain('호스트 A/…(2단계)');
    expect(hidden).toContain('표 "‹8자›": 3행, 열 2개');
    expect(hidden).toContain('[막힘] 읽지 못한 iframe 1개');
  });
});
