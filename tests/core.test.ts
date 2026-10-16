import { describe, expect, it } from 'vitest';
import {
  DatasetStore,
  buildWorkbook,
  checkAction,
  evalCheck,
  extractJson,
  fillTemplate,
  hostAllowed,
  parseAction,
  parseSkill,
  resolveInputs,
  stepCheck,
  stripCheckLines,
  toExcelValue,
  transform,
  type Action,
  type PageSnapshot,
} from '../src/core';
import { readWorkbook, wipSkill } from './helpers';

describe('skill', () => {
  it('번들된 재공 확인 스킬을 읽는다', () => {
    const skill = wipSkill();
    expect(skill.id).toBe('wip-check');
    expect(skill.risk).toBe('R1');
    expect(skill.steps).toHaveLength(9);
    expect(skill.steps[3]).toContain('조회');
  });

  it('입력값을 검증하고 기본값을 채운다', () => {
    const skill = wipSkill();
    expect(resolveInputs(skill, {}).errors).toEqual(['라인: 필수 입력입니다']);
    expect(resolveInputs(skill, { line: '8라인', hold_hours: 'abc' }).errors).toEqual([
      '정체 기준(시간): 숫자여야 합니다',
    ]);
    expect(resolveInputs(skill, { line: ' 8라인 ', step: '' }).values).toEqual({ line: '8라인', hold_hours: 24 });
  });

  it('본문의 자리표시자를 입력값으로 바꾼다', () => {
    const skill = wipSkill();
    const body = fillTemplate(skill, { line: '8라인', hold_hours: 24 });
    expect(body).toContain('{"ref": "라인", "value": "8라인"}');
    expect(body).toContain('"value": "(미지정)"');
    expect(body).toContain('재공확인_8라인');
    expect(body).not.toMatch(/\{(line|step|hold_hours)\}/);
  });

  it('선언부가 잘못되면 이유를 알려준다', () => {
    expect(() => parseSkill('본문만 있음')).toThrow('선언부');
    const bad = `---\nid: x\nname: n\ndescription: d\nversion: 1.0.0\nowner: o\nrisk: R9\ndomains: [a]\n---\n## 단계\n1. 한다`;
    expect(() => parseSkill(bad)).toThrow('risk');
    const noSteps = bad.replace('R9', 'R0').replace('## 단계\n1. 한다', '설명');
    expect(() => parseSkill(noSteps)).toThrow('단계');
  });
});

describe('transform', () => {
  const table = {
    columns: ['Lot', '공정', '수량', '상태', '정체시간'],
    rows: [
      ['A', 'PHOTO', '1,200', 'RUN', '3'],
      ['B', 'ETCH', '300', 'HOLD', '1.5'],
      ['C', 'PHOTO', '50', 'WAIT', '30'],
      ['D', 'ETCH', '700', 'RUN', '24'],
    ],
  };

  it('any 조건으로 거르고 숫자로 정렬한다', () => {
    const out = transform(table, [
      {
        op: 'filter',
        match: 'any',
        where: [
          { col: '정체시간', cmp: '>=', value: 24 },
          { col: '상태', cmp: '==', value: 'HOLD' },
        ],
      },
      { op: 'sort', by: '정체시간', desc: true },
    ]);
    expect(out.rows.map((r) => r[0])).toEqual(['C', 'D', 'B']);
  });

  it('쉼표가 있는 숫자를 합산한다', () => {
    const out = transform(table, [
      { op: 'group', by: ['공정'], agg: [{ fn: 'count', as: 'Lot수' }, { fn: 'sum', col: '수량', as: '합계' }] },
      { op: 'sort', by: '합계', desc: true },
    ]);
    expect(out).toEqual({ columns: ['공정', 'Lot수', '합계'], rows: [['PHOTO', 2, 1250], ['ETCH', 2, 1000]] });
  });

  it('없는 컬럼은 사용 가능한 컬럼과 함께 알려준다', () => {
    expect(() => transform(table, [{ op: 'sort', by: '정체', desc: false }])).toThrow('사용 가능한 컬럼');
  });

  it('원본을 바꾸지 않는다', () => {
    const before = JSON.stringify(table);
    transform(table, [{ op: 'sort', by: '수량', desc: true }, { op: 'limit', n: 1 }]);
    expect(JSON.stringify(table)).toBe(before);
  });
});

describe('dataset', () => {
  it('append는 컬럼이 같을 때만 이어 붙인다', () => {
    const store = new DatasetStore();
    store.put('d', { columns: ['a', 'b'], rows: [['1', '2']] }, false);
    store.put('d', { columns: ['a', 'b'], rows: [['3', '4']] }, true);
    expect(store.get('d').rows).toHaveLength(2);
    expect(() => store.put('d', { columns: ['a', 'c'], rows: [] }, true)).toThrow('다릅니다');
    expect(() => store.get('없음')).toThrow('현재 데이터셋: d');
  });

  it('모델용 요약에는 샘플 행만 들어간다', () => {
    const store = new DatasetStore();
    store.set('d', ['a'], Array.from({ length: 100 }, (_, i) => [`v${i}`]));
    const text = store.describe(3);
    expect(text).toContain('100행');
    expect(text).toContain('v2');
    expect(text).not.toContain('v3');
  });
});

describe('excel', () => {
  it('숫자처럼 보이는 값만 숫자로 바꾼다', () => {
    expect(toExcelValue('1,234')).toBe(1234);
    expect(toExcelValue('12.5')).toBe(12.5);
    expect(toExcelValue('0')).toBe(0);
    expect(toExcelValue('00123')).toBe('00123');
    expect(toExcelValue('P8-00001')).toBe('P8-00001');
    expect(toExcelValue('12,34')).toBe('12,34');
    expect(toExcelValue('')).toBe('');
  });

  it('여러 시트를 쓰고 다시 읽을 수 있다', async () => {
    const data = await buildWorkbook([
      { name: '원본', dataset: { columns: ['Lot', '수량'], rows: [['00123', '1,000']] } },
      { name: '집계', dataset: { columns: ['공정', '합계'], rows: [['PHOTO', 5]] } },
    ]);
    expect(await readWorkbook(data)).toEqual({
      원본: [['Lot', '수량'], ['00123', 1000]],
      집계: [['공정', '합계'], ['PHOTO', 5]],
    });
  });
});

describe('actions', () => {
  it('설명이나 코드 펜스가 붙어도 JSON을 꺼낸다', () => {
    expect(extractJson('네.\n```json\n{"a": "}{", "b": {"c": 1}}\n```\n끝')).toBe('{"a": "}{", "b": {"c": 1}}');
    expect(extractJson('JSON 없음')).toBeNull();
  });

  it('도구별 인자를 검증한다', () => {
    const ok = parseAction('{"step":"2","thought":"t","tool":"click","args":{"ref":"12"}}');
    expect(ok).toEqual({ ok: true, action: { step: 2, thought: 't', tool: 'click', args: { ref: 12 } } });
    expect(parseAction('{"tool":"fly","args":{}}')).toMatchObject({ ok: false });
    expect(parseAction('{"tool":"click","args":{}}')).toMatchObject({ ok: false });
    expect(parseAction('{"tool":"navigate","args":{"url":"wip.html"}}')).toMatchObject({ ok: false });
    expect(parseAction('{"tool": "click", ')).toMatchObject({ ok: false });
  });

  it('작은 모델이 흔히 내는 모양 차이는 다시 묻지 않고 받는다', () => {
    const click = { ok: true, action: { tool: 'click', args: { ref: 4 } } };
    // 설명 글에 { } 가 먼저 나옴
    expect(parseAction('{조회} 버튼을 누릅니다.\n{"thought":"조회","tool":"click","args":{"ref":4}}')).toMatchObject(click);
    // 끝의 쉼표
    expect(parseAction('{"tool":"click","args":{"ref":4,},}')).toMatchObject(click);
    // thought 안의 날 줄바꿈
    expect(parseAction('{"thought":"라인을 고른 뒤\n조회를 누른다","tool":"click","args":{"ref":4}}')).toMatchObject({
      ok: true,
      action: { thought: '라인을 고른 뒤\n조회를 누른다', tool: 'click' },
    });
    // args 없이 바로 적은 인자, args를 글자로 준 경우, 도구 이름의 대소문자·괄호
    expect(parseAction('{"tool":"click","ref":4}')).toMatchObject(click);
    expect(parseAction('{"tool":"click","args":"{\\"ref\\":4}"}')).toMatchObject(click);
    expect(parseAction('{"tool":" Click() ","args":{"ref":4}}')).toMatchObject(click);
  });

  it('다시 물어야 할 때는 무엇이 문제인지 알려 준다', () => {
    expect(parseAction('{"thought":"길게 설명하다가 끊긴 응답… ","tool":"cli')).toMatchObject({ ok: false, error: expect.stringMatching(/중간에 끊겼습니다/) });
    expect(parseAction('조회 버튼을 누르면 됩니다')).toMatchObject({ ok: false, error: 'JSON 객체가 없습니다' });
    expect(parseAction("{'tool': 'click'}")).toMatchObject({ ok: false, error: expect.stringMatching(/JSON 문법 오류/) });
  });

  it('이름이나 대괄호로 적힌 ref를 현재 화면의 번호로 바꾼다', () => {
    const snap: PageSnapshot = {
      url: 'http://localhost:4173/wip.html',
      title: '',
      hasPassword: false,
      items: [
        { kind: 'el', ref: 1, role: 'combobox', name: '라인' },
        { kind: 'el', ref: 2, role: 'button', name: '조회' },
        { kind: 'el', ref: 3, role: 'button', name: '다음' },
        { kind: 'el', ref: 4, role: 'link', name: '다음' },
        { kind: 'el', ref: 5, role: 'table', name: '조회' },
      ],
    };
    const ref = (tool: string, r: unknown) => {
      const p = parseAction(JSON.stringify({ tool, args: { ref: r, value: 'v', dataset: 'd' } }), snap);
      return p.ok ? (p.action.args as { ref: number }).ref : p.error;
    };
    expect(ref('select', '라인')).toBe(1);
    expect(ref('click', '[2]')).toBe(2);
    expect(ref('click', ' 3 ')).toBe(3);
    expect(ref('extract_table', '조회')).toBe(5);
    expect(ref('click', '다음')).toContain('여러 개');
    expect(ref('click', '없는 버튼')).toContain('[1] combobox "라인"');
  });
});

describe('policy', () => {
  const skill = wipSkill();
  const snap: PageSnapshot = {
    url: 'http://localhost:4173/wip.html',
    title: '재공',
    hasPassword: false,
    items: [
      { kind: 'el', ref: 1, role: 'button', name: '조회' },
      { kind: 'el', ref: 2, role: 'button', name: '조건 저장' },
      { kind: 'el', ref: 3, role: 'button', name: '다음', disabled: true },
      { kind: 'el', ref: 4, role: 'table', name: '재공 목록' },
    ],
  };
  const click = (ref: number): Action => ({ step: 3, thought: '', tool: 'click', args: { ref } });

  it('호스트 패턴을 비교한다', () => {
    expect(hostAllowed('http://localhost:4173/a', ['localhost:4173'])).toBe(true);
    expect(hostAllowed('http://localhost:9999/a', ['localhost:4173'])).toBe(false);
    expect(hostAllowed('https://mes.fab.internal/x', ['*.fab.internal'])).toBe(true);
    expect(hostAllowed('https://fab.internal.evil.com/x', ['*.fab.internal'])).toBe(false);
    expect(hostAllowed('https://evil.com/?u=mes.fab.internal', ['mes.fab.internal'])).toBe(false);
    expect(hostAllowed('javascript:alert(1)', ['localhost:4173'])).toBe(false);
    expect(hostAllowed('file:///c:/x', ['localhost:4173'])).toBe(false);
  });

  it('허용 도메인 밖으로의 이동과 밖에서의 조작을 막는다', () => {
    const nav = (url: string): Action => ({ step: 1, thought: '', tool: 'navigate', args: { url } });
    expect(checkAction(nav('http://localhost:4173/other.html'), snap, skill).ok).toBe(true);
    expect(checkAction(nav('http://localhost:4173/wip.html'), snap, skill).ok).toBe(false);
    const framed: PageSnapshot = {
      ...snap,
      url: 'http://localhost:4173/portal.html',
      items: [{ kind: 'frame', url: 'http://localhost:4173/wip.html' }],
    };
    expect(checkAction(nav('http://localhost:4173/wip.html'), framed, skill).ok).toBe(false);
    expect(checkAction(nav('https://example.com/'), snap, skill).ok).toBe(false);
    expect(checkAction(click(1), { ...snap, url: 'https://example.com/' }, skill).ok).toBe(false);
  });

  it('저장 계열 버튼, 비활성 요소, 없는 ref를 막는다', () => {
    expect(checkAction(click(1), snap, skill).ok).toBe(true);
    expect(checkAction(click(2), snap, skill)).toMatchObject({ ok: false });
    expect(checkAction(click(3), snap, skill)).toMatchObject({ ok: false });
    expect(checkAction(click(99), snap, skill)).toMatchObject({ ok: false });
  });

  it('표가 아닌 요소에서 추출을 막는다', () => {
    const extract = (ref: number): Action => ({
      step: 4,
      thought: '',
      tool: 'extract_table',
      args: { ref, dataset: 'd', append: false },
    });
    expect(checkAction(extract(4), snap, skill).ok).toBe(true);
    expect(checkAction(extract(1), snap, skill).ok).toBe(false);
  });
});

describe('check', () => {
  const snap: PageSnapshot = {
    url: 'http://localhost:4173/wip.html',
    title: '',
    hasPassword: false,
    items: [
      { kind: 'heading', text: '재공 현황 조회' },
      { kind: 'el', ref: 1, role: 'combobox', name: '라인', value: '7라인' },
      { kind: 'el', ref: 2, role: 'combobox', name: '공정', value: '전체' },
      { kind: 'text', text: '총 1,128건' },
    ],
  };
  const ctx = (rows = 0, did: string[] = []) => {
    const datasets = new DatasetStore();
    if (rows) datasets.set('wip', ['a'], Array.from({ length: rows }, () => ['x']));
    return { snap, datasets, didTools: new Set(did) };
  };
  const run = (expr: string, c = ctx()) => evalCheck(stepCheck(`단계\n   - 검사: ${expr}`)!, c);

  it('검사 줄이 없으면 null, 문법이 틀리면 오류', () => {
    expect(stepCheck('조회한다\n   - 확인: 보인다')).toBeNull();
    expect(() => stepCheck('x\n   - 검사: rows(wip) > 3')).toThrow('검사 식');
    const bad = `---\nid: x\nname: n\ndescription: d\nversion: 1.0.0\nowner: o\nrisk: R0\ndomains: [a]\n---\n## 단계\n1. 한다\n   - 검사: 아무말`;
    expect(() => parseSkill(bad)).toThrow('1단계');
  });

  it('화면 글자와 요소 값을 본다', () => {
    expect(run('text("재공 현황") and no_text("조회 중")')).toEqual([]);
    expect(run('no_text("총")')).toHaveLength(1);
    expect(run('value("라인") == "7라인"')).toEqual([]);
    expect(run('value("라인") == "8라인"')[0]).toContain('현재 "7라인"');
    expect(run('value("없는것") == "x"')[0]).toContain('요소 없음');
    expect(run('value("공정") == "(미지정)"')).toEqual([]);
  });

  it('데이터셋 행 수를 화면의 총 건수와 비교한다', () => {
    const expr = String.raw`rows("wip") == page_number("총 ([\d,]+)건")`;
    expect(run(expr)[0]).toContain('아직 없음');
    expect(run(expr, ctx(50))[0]).toContain('50행인데 화면의 총 건수는 1128');
    expect(run(expr, ctx(1128))).toEqual([]);
  });

  it('이 단계에서 한 동작과 데이터셋 존재를 본다', () => {
    expect(run('did("click")')).toHaveLength(1);
    expect(run('did("click")', ctx(0, ['click']))).toEqual([]);
    expect(run('dataset("wip") and dataset("hold")', ctx(3))).toEqual(['데이터셋 "hold"이 아직 없음']);
  });

  it('모델에게 보여줄 본문에서는 검사 줄을 뺀다', () => {
    expect(stripCheckLines('1. 한다\n   - 확인: 됨\n   - 검사: did("click")\n2. 끝')).toBe('1. 한다\n   - 확인: 됨\n2. 끝');
  });
});

describe('policy: 선택 상자 옵션', () => {
  it('값이 다른 선택 상자에 있으면 실행하지 않고 그 상자를 알려준다', () => {
    const snap: PageSnapshot = {
      url: 'http://localhost:4173/wip.html',
      title: '',
      hasPassword: false,
      items: [
        { kind: 'el', ref: 1, role: 'combobox', name: '라인', detail: 'options=[선택, 6라인, 7라인]' },
        { kind: 'el', ref: 2, role: 'combobox', name: '공정', detail: 'options=[전체, PHOTO]' },
      ],
    };
    const select = (ref: number, value: string): Action => ({ step: 2, thought: '', tool: 'select', args: { ref, value } });
    expect(checkAction(select(1, '7라인'), snap, wipSkill()).ok).toBe(true);
    expect(checkAction(select(2, '7라인'), snap, wipSkill())).toEqual({
      ok: false,
      reason: '[2] combobox "공정"에는 "7라인" 옵션이 없습니다. 이 값은 [1] combobox "라인"에 있습니다',
    });
    expect(checkAction(select(1, '9라인'), snap, wipSkill())).toMatchObject({ ok: false });
  });
});
