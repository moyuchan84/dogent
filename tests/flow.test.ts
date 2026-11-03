import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  addInput,
  canRedo,
  canUndo,
  composeStart,
  describeBlock,
  draftSkill,
  duplicateBlock,
  insertBlock,
  moveBlock,
  newHistory,
  parseFlow,
  parseSkill,
  pushHistory,
  redoHistory,
  removeBlock,
  removeInput,
  renderFlow,
  renderSpec,
  setInput,
  setMeta,
  spliceFlow,
  trialSource,
  updateBlock,
  undeclaredInputs,
  undoHistory,
  type AuthorStep,
  type ComposeSpec,
  type Flow,
} from '../src/core';

function open(source: string): Flow {
  const f = parseFlow(source);
  if (!f.ok) throw new Error(f.reason);
  return f;
}

const meta = { id: 'wip-check', name: '재공 확인', description: '재공을 조회한다', owner: '생산관리' };
const start = { url: 'http://localhost:4173/wip.html', heading: '재공 현황 조회' };

/** 입력 하나, 저장 버튼, 표 읽기가 있는 녹화 초안 */
const recorded: AuthorStep[] = [
  { kind: 'select', name: '라인', value: '7라인', options: ['7라인', '8라인'], variable: true, param: { name: 'line', description: '조회할 라인' } } as AuthorStep,
  { kind: 'click', name: '조회', expect: '총' } as AuthorStep,
  { kind: 'extract', name: '재공 목록', next: '다음' },
  { kind: 'goal', text: 'HOLD인 Lot의 사유를 확인한다' },
  { kind: 'click', name: '저장' } as AuthorStep,
];
// 구조: 이동, 선택, 조회, 표 읽기, (말로 적은 단계), 저장, 엑셀 저장, 보고
const draft = () => draftSkill(meta, start, recorded).source;

const root = join(__dirname, '..');
function skillFiles(): { name: string; source: string }[] {
  const out: { name: string; source: string }[] = [];
  const walk = (dir: string) => {
    if (!existsSync(dir)) return;
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name === 'SKILL.md') out.push({ name: p.slice(root.length + 1), source: readFileSync(p, 'utf8') });
    }
  };
  walk(join(root, 'skills'));
  walk(join(root, 'samples'));
  return out;
}

describe('흐름 읽기·쓰기 라운드트립', () => {
  it('draftSkill이 낸 문서는 그대로 돌아온다', () => {
    const s = draft();
    expect(renderFlow(open(s))).toBe(s);
  });

  it('renderSpec이 낸 문서(빠른 경로, 목표 단계, 저장 단계)는 그대로 돌아온다', () => {
    const spec: ComposeSpec = {
      id: 'wip-count',
      name: '재공 건수',
      description: '라인을 골라 조회한다',
      risk: 'R3',
      tags: ['재공'],
      inputs: [{ name: 'line', label: '라인', description: '조회할 라인', type: 'string', default: '7라인', required: true }],
      steps: [{ text: '"라인"에서 {line}을 선택한다' }, { text: '"조회" 버튼을 누른다', check: 'text("총")' }, { text: '"저장" 버튼을 누른다' }, { text: '결과를 정리해 보고한다' }].map((s) => ({ check: undefined, script: undefined, ...s })),
      submit: { step: 3, labels: ['저장'] },
      exceptions: ['오류가 나오면 알린다'],
      result: '건수',
      scripts: [],
    };
    const elements = [
      { role: 'combobox', name: '라인', options: ['7라인', '8라인'] },
      { role: 'button', name: '조회' },
      { role: 'button', name: '저장' },
    ];
    const { source } = renderSpec(spec, composeStart('http://localhost:4173/wip.html', '재공', undefined, '생산관리'));
    expect(renderFlow(open(source))).toBe(source);
    const fast = renderSpec(spec, { url: 'http://localhost:4173/wip.html', heading: '재공 현황 조회', owner: '생산관리', seen: '', elements }).source;
    expect(fast).toContain('select로');
    expect(renderFlow(open(fast))).toBe(fast);
    expect(open(fast).blocks.some((b) => b.submit)).toBe(true);
  });

  it('번들·샘플 스킬 전부 라운드트립하고 열린 단계 수가 parseSkill과 같다', () => {
    const files = skillFiles();
    expect(files.length).toBeGreaterThanOrEqual(10);
    for (const { name, source } of files) {
      const f = open(source);
      const skill = parseSkill(source);
      expect(f.blocks.length, name).toBe(skill.steps.length);
      expect(f.blocks.map((_, i) => f.blocks[i].submit ? i + 1 : 0).filter(Boolean), name).toEqual(skill.submit_steps);
      expect(renderFlow(f), name).toBe(source.replace(/\r\n/g, '\n'));
    }
  });

  it('모르는 줄(- 확인:)과 목적·검사·기록의 자리를 그대로 보존한다', () => {
    const src = skillFiles().find((f) => f.name.includes('wip-adjust'))!.source;
    const f = open(src);
    const save = f.blocks[2];
    expect(save.extra.some((l) => l.includes('확인:'))).toBe(true);
    expect(save.record).toContain('saved = page_text');
    expect(save.submit).toBe(true);
    expect(f.after.join('\n')).toContain('## 예외');
  });

  it('열 수 없으면 오류를 던지지 않고 이유를 돌려준다', () => {
    expect(parseFlow('그냥 글')).toMatchObject({ ok: false });
    expect(parseFlow('---\nid: a\n---\n\n## 예외\n\n- x\n')).toMatchObject({ ok: false, reason: expect.stringContaining('단계') });
    expect(parseFlow('---\nid: [\n---\n## 단계\n1. a\n')).toMatchObject({ ok: false });
    expect(parseFlow('---\nid: a\n---\n## 단계\n\n설명만\n')).toMatchObject({ ok: false });
  });

  it('CRLF와 BOM이 있어도 연다', () => {
    const f = open('﻿' + draft().replace(/\n/g, '\r\n'));
    expect(renderFlow(f)).toBe(draft());
  });
});

describe('연산', () => {
  it('단계를 옮기면 번호를 다시 매기고 submit_steps를 따라 바꾼다', () => {
    const f = open(draft());
    const saveAt = f.blocks.findIndex((b) => b.submit);
    expect(saveAt).toBe(5);
    const moved = moveBlock(f, saveAt, 2);
    const out = renderFlow(moved);
    expect(parseSkill(out).submit_steps).toEqual([3]);
    const reopened = open(out);
    expect(reopened.blocks[2].submit).toBe(true);
    expect(reopened.blocks[2].head).toContain('"저장"');
    expect(out).toMatch(/^3\. click으로 "저장"/m);
  });

  it('삽입은 번호를 밀고 submit_steps를 맞추며 max_steps를 올린다', () => {
    let f = open(draft());
    const max = f.meta.limits.max_steps!;
    expect(max).toBeGreaterThanOrEqual(f.blocks.length * 3);
    for (let i = 0; i < 12; i++) f = insertBlock(f, 2, { head: `단계 ${i}을(를) 한다` });
    const out = renderFlow(f);
    const skill = parseSkill(out);
    expect(skill.steps).toHaveLength(f.blocks.length);
    expect(skill.limits.max_steps).toBeGreaterThanOrEqual(f.blocks.length * 3);
    expect(skill.submit_steps).toEqual([f.blocks.findIndex((b) => b.submit) + 1]);
  });

  it('복제본은 새 key이고 제출 표시를 물려받지 않는다', () => {
    const f = open(draft());
    const i = f.blocks.findIndex((b) => b.submit);
    const d = duplicateBlock(f, i);
    expect(d.blocks).toHaveLength(f.blocks.length + 1);
    expect(d.blocks[i + 1].key).not.toBe(f.blocks[i].key);
    expect(d.blocks[i + 1].submit).toBe(false);
    expect(d.blocks[i].submit).toBe(true);
    expect(d.notices.join()).toContain('승인 필요');
    // 복제본이 저장 버튼을 또 누르는 단계라 경고가 난다
    expect(d.warnings.some((w) => w.key === d.blocks[i + 1].key)).toBe(true);
    expect(parseSkill(renderFlow(d)).submit_steps).toEqual([i + 1]);
  });

  it('목적·검사·기록을 고치고 지운다', () => {
    let f = open(draft());
    const i = f.blocks.findIndex((b) => b.literal === null); // 말로 적은 단계 (목적·검사 없음)
    expect(f.blocks[i].literal).toBeNull();
    f = updateBlock(f, i, { head: '상태가 HOLD인 Lot을 열어 사유를 확인한다', check: 'text("사유")', note: '사유 확인' });
    const out = renderFlow(f);
    expect(out).toContain(`${i + 1}. 상태가 HOLD인 Lot을 열어 사유를 확인한다\n   - 목적: 사유 확인\n   - 검사: text("사유")`);
    expect(() => parseSkill(out)).not.toThrow();
    const cleared = renderFlow(updateBlock(f, i, { check: null }));
    expect(cleared).not.toContain('text("사유")');
  });

  it('스킬 정보를 고치되 사이트(domains)는 건드리지 않는다', () => {
    const f = setMeta(open(draft()), { name: '새 이름', owner: '설비', tags: ['재공', 'HOLD'] });
    const out = renderFlow(f);
    const skill = parseSkill(out);
    expect(skill.name).toBe('새 이름');
    expect(skill.owner).toBe('설비');
    expect(skill.tags).toEqual(['재공', 'HOLD']);
    expect(skill.domains).toEqual(['localhost:4173']);
    expect(out).toContain('http://localhost:4173/wip.html');
  });
});

describe('보호 규칙 (통제)', () => {
  it('(a) 1번 시작 화면 단계는 옮기거나 지울 수 없고 그 앞에 넣을 수 없다', () => {
    const f = open(draft());
    const heads = f.blocks.map((b) => b.head);
    expect(describeBlock(f.blocks[0]).kind).toBe('navigate');
    expect(moveBlock(f, 0, 2).blocks.map((b) => b.head)).toEqual(heads);
    expect(moveBlock(f, 2, 0).blocks.map((b) => b.head)).toEqual(heads);
    expect(moveBlock(f, 2, 0).notices.join()).toContain('시작 화면');
    expect(removeBlock(f, 0).blocks).toHaveLength(f.blocks.length);
    expect(duplicateBlock(f, 0).blocks).toHaveLength(f.blocks.length);
    const ins = insertBlock(f, 0, { head: '먼저 뭔가 한다' });
    expect(ins.blocks[0].head).toBe(heads[0]);
    expect(ins.blocks[1].head).toBe('먼저 뭔가 한다');
  });

  it('(b) 저장·상신 단계를 지우면 선언을 정리하고 위험 등급은 그대로 두며 알린다', () => {
    const f = open(draft());
    const i = f.blocks.findIndex((b) => b.submit);
    expect(f.meta.risk).toBe('R3');
    const r = removeBlock(f, i);
    expect(r.blocks).toHaveLength(f.blocks.length - 1);
    expect(r.meta.submit_steps).toEqual([]);
    expect(r.meta.submit_labels).toEqual([]);
    expect(r.meta.risk).toBe('R3');
    expect(r.notices.join()).toContain('위험 등급');
    const out = renderFlow(r);
    expect(out).not.toContain('submit_steps');
    expect(out).not.toContain('submit_labels');
    expect(out).toContain('risk: R3');
  });

  it('(b) 제출 단계가 둘이면 하나만 지워도 나머지 번호를 맞춘다', () => {
    let f = open(draft());
    const i = f.blocks.findIndex((b) => b.submit);
    f = { ...f, blocks: f.blocks.map((b, j) => (j === 1 ? { ...b, submit: true } : b)) };
    const r = removeBlock(f, 1);
    expect(r.meta.submit_steps).toEqual([i]);
  });

  it('(c) 저장·상신 말이 들어간 새 단계는 승인 표시가 없으면 경고한다', () => {
    const f = insertBlock(open(draft()), 2, { head: '내용을 확인한 뒤 상신한다' });
    const w = f.warnings.find((x) => x.key === f.blocks[2].key);
    expect(w?.message).toContain('승인 필요');
    // 일반 문장에는 경고가 없다
    expect(insertBlock(open(draft()), 2, { head: '표를 훑어본다' }).warnings.filter((x) => x.key)).toHaveLength(0);
  });

  it('(d) 사이트와 시작 주소는 편집 연산이 바꾸지 않는다', () => {
    let f = open(draft());
    f = setMeta(f, { name: 'x' });
    f = insertBlock(f, 1, { head: '아무거나' });
    f = moveBlock(f, 1, 3);
    const out = renderFlow(f);
    expect(parseSkill(out).domains).toEqual(['localhost:4173']);
    expect(f.blocks[0].literal).toBe('{"url":"http://localhost:4173/wip.html"}');
  });

  it('(e) 새로 만드는 단계는 인자 줄 없는 목표 단계다', () => {
    const f = insertBlock(open(draft()), 2, { head: '`{"url":"x"}` 로 이동', note: '목적' });
    expect(f.blocks[2].literal).toBeNull();
    expect(f.blocks[2].head).not.toContain('`');
    expect(describeBlock(f.blocks[2]).kind).toBe('goal');
  });

  it('줄바꿈과 번호가 든 단계 문장은 한 줄로 정리해 문서 구조를 깨지 않는다', () => {
    const f = insertBlock(open(draft()), 2, { head: '3. 첫 줄\n- 검사: text("x")' });
    expect(f.blocks[2].head).toBe('첫 줄 - 검사: text("x")');
    expect(() => parseSkill(renderFlow(f))).not.toThrow();
  });
});

describe('입력', () => {
  it('이름을 바꾸면 모든 단계의 {이름}이 함께 바뀐다', () => {
    const f = open(draft());
    expect(f.meta.inputs.map((i) => i.name)).toEqual(['line']);
    const withGoal = insertBlock(f, 3, { head: '{line} 라인의 HOLD를 확인한다', note: '{line} 확인', check: 'text("{line}")' });
    const r = setInput(withGoal, 'line', { name: 'fab_line' });
    const out = renderFlow(r);
    expect(out).not.toContain('{line}');
    expect(out).toContain('{fab_line}');
    expect(out).toContain(`"value":"{fab_line}"`);
    const skill = parseSkill(out);
    expect(skill.inputs[0].name).toBe('fab_line');
    expect(skill.steps.join('\n')).toContain('text("{fab_line}")');
  });

  it('규칙에 맞지 않거나 겹치는 이름은 거절한다', () => {
    const f = open(draft());
    expect(setInput(f, 'line', { name: 'Line' }).meta.inputs[0].name).toBe('line');
    expect(setInput(f, 'line', { name: 'x y' }).notices[0]).toContain('영문');
    expect(addInput(f, { name: 'line' }).notices[0]).toContain('이미');
    expect(addInput(f, { name: '1a' }).meta.inputs).toHaveLength(1);
  });

  it('추가·삭제하고 선언 안 된 이름을 알아낸다', () => {
    let f = open(draft());
    f = addInput(f, { name: 'product', label: '제품', description: '제품 코드', type: 'string', default: 'A100' });
    const skill = parseSkill(renderFlow(f));
    expect(skill.inputs.map((i) => i.name)).toEqual(['line', 'product']);
    expect(skill.inputs[1]).toMatchObject({ default: 'A100', required: false, label: '제품' });
    const g = insertBlock(f, 2, { head: '"제품"에 {product}과(와) {lot}을 넣는다' });
    expect(undeclaredInputs(g)).toEqual([{ name: 'lot', keys: [g.blocks[2].key] }]);
    const removed = removeInput(g, 'product');
    expect(removed.notices[0]).toContain('{product}');
    expect(removeInput(removed, 'line').meta.inputs).toHaveLength(0);
    expect(renderFlow(removeInput(removeInput(removed, 'line'), 'zzz'))).not.toContain('inputs:');
  });
});

describe('spliceFlow', () => {
  const fragmentOf = (steps: AuthorStep[]) => open(draftSkill(meta, start, steps).source);

  it('다른 흐름의 단계를 끼우고(시작·보고 제외) 입력 이름 충돌을 해결한다', () => {
    const target = open(draft());
    const frag = fragmentOf([
      { kind: 'select', name: '공정', value: 'CMP', options: ['CMP', 'ETCH'], variable: true, param: { name: 'line' } } as AuthorStep,
      { kind: 'click', name: '검색' } as AuthorStep,
    ]);
    expect(frag.meta.inputs.map((i) => i.name)).toEqual(['line']);
    const r = spliceFlow(target, frag, 2);
    expect(r.blocks).toHaveLength(target.blocks.length + 2);
    expect(r.blocks[2].head).toContain('"공정"');
    expect(r.meta.inputs.map((i) => i.name)).toEqual(['line', 'line2']);
    expect(r.blocks[2].literal).toContain('{line2}');
    expect(r.notices.join()).toContain('겹쳐');
    // 원래 단계의 {line}은 그대로
    expect(target.blocks[1].literal).toContain('{line}');
    expect(r.blocks.filter((b) => b.head.startsWith('navigate'))).toHaveLength(1);
    const out = renderFlow(r);
    expect(() => parseSkill(out)).not.toThrow();
    expect(parseSkill(out).submit_steps).toEqual([r.blocks.findIndex((b) => b.submit) + 1]);
  });

  it('조각의 저장·상신 표시가 새 번호로 따라온다', () => {
    const target = open(draft());
    const frag = fragmentOf([{ kind: 'click', name: '삭제' } as AuthorStep]);
    expect(frag.blocks.some((b) => b.submit)).toBe(true);
    const r = spliceFlow(target, frag, 1);
    expect(r.notices.join()).toContain('저장·상신');
    const skill = parseSkill(renderFlow(r));
    expect(skill.submit_steps).toEqual([2, target.blocks.findIndex((b) => b.submit) + 2]);
    expect(skill.submit_labels).toEqual(['저장', '삭제']);
  });

  it('데이터셋 이름이 겹치면 조각 쪽을 바꾼다', () => {
    const target = open(draft());
    const frag = fragmentOf([{ kind: 'extract', name: '다른 표' }]);
    expect(frag.blocks[1].literal).toContain('data1');
    const r = spliceFlow(target, frag, 1);
    const added = r.blocks[1];
    expect(added.literal).toContain('data1_2');
    expect(added.check).toContain('data1_2');
    expect(r.notices.join()).toContain('data1_2');
  });

  it('시작 단계 앞으로는 끼우지 않는다', () => {
    const target = open(draft());
    const frag = fragmentOf([{ kind: 'goal', text: '무언가 한다' }]);
    expect(spliceFlow(target, frag, 0).blocks[0].head).toContain('navigate');
  });
});

describe('trialSource', () => {
  it('그 단계까지와 보고 단계만으로 읽을 수 있는 임시 문서를 만든다', () => {
    const f = open(draft());
    const src = trialSource(f, 2);
    const skill = parseSkill(src);
    expect(skill.steps).toHaveLength(4);
    expect(skill.steps[3]).toMatch(/^finish로/);
    expect(skill.submit_steps).toEqual([]);
    // 저장 단계까지 시험하면 표시가 남아 시험 실행이 그 버튼 직전에서 멈춘다
    const upToSave = parseSkill(trialSource(f, f.blocks.findIndex((b) => b.submit)));
    expect(upToSave.submit_steps).toEqual([upToSave.steps.length - 1]);
  });
});

describe('History', () => {
  it('쌓고 되돌리고 다시 한다', () => {
    let h = newHistory(1);
    h = pushHistory(h, 2);
    h = pushHistory(h, 3);
    expect(h.present).toBe(3);
    expect(canUndo(h)).toBe(true);
    h = undoHistory(h);
    expect(h.present).toBe(2);
    expect(canRedo(h)).toBe(true);
    h = redoHistory(h);
    expect(h.present).toBe(3);
    h = undoHistory(undoHistory(h));
    h = pushHistory(h, 9);
    expect(canRedo(h)).toBe(false);
    expect(undoHistory(h).present).toBe(1);
    expect(undoHistory(newHistory(0)).present).toBe(0);
  });

  it('같은 종류의 연속 편집은 한 번으로 합친다', () => {
    let h = newHistory('');
    for (const s of ['a', 'ab', 'abc']) h = pushHistory(h, s, { coalesceKey: 'typing:1' });
    expect(h.present).toBe('abc');
    expect(h.past).toEqual(['']);
    h = pushHistory(h, 'abcd', { coalesceKey: 'typing:2' });
    expect(h.past).toEqual(['', 'abc']);
    h = pushHistory(h, 'x');
    h = pushHistory(h, 'xy', { coalesceKey: 'typing:2' });
    expect(h.past).toHaveLength(4);
    expect(undoHistory(h).present).toBe('x');
  });

  it('최대 개수를 넘으면 오래된 것부터 버린다', () => {
    let h = newHistory(0);
    for (let i = 1; i <= 10; i++) h = pushHistory(h, i, { max: 3 });
    expect(h.past).toEqual([7, 8, 9]);
  });
});

describe('describeBlock', () => {
  it('종류와 제목을 문서에서 읽는다', () => {
    const steps: AuthorStep[] = [
      { kind: 'select', name: '라인', value: '7라인', options: ['7라인'], variable: false } as AuthorStep,
      { kind: 'type', name: '제품코드', value: 'A100', variable: true, param: { name: 'code' } } as AuthorStep,
      { kind: 'click', name: '조회' } as AuthorStep,
      { kind: 'click', name: '엑셀 저장' } as AuthorStep,
      { kind: 'extract', name: '재공 목록', next: '다음' },
      { kind: 'fill', name: '조정 목록', columns: ['Lot ID'], add: '행 추가' },
      { kind: 'summarize', instruction: '공정별 건수를 정리한다', source: 'page' },
      { kind: 'goal', text: '마지막에 결과를 알려 준다' },
    ];
    const f = open(draftSkill(meta, start, steps).source);
    const kinds = f.blocks.map((b) => describeBlock(b).kind);
    expect(kinds).toEqual(['navigate', 'select', 'type', 'click', 'download', 'extract', 'fill', 'summarize', 'other', 'goal']);
    const titles = f.blocks.map((b) => describeBlock(b).title);
    expect(titles[0]).toBe('"재공 현황 조회" 화면으로 이동');
    expect(titles[1]).toBe('"라인"에서 선택: 7라인');
    expect(titles[2]).toBe('"제품코드"에 입력: {code}');
    expect(titles[3]).toBe('"조회" 누름');
    expect(titles[5]).toBe('"재공 목록" 표 읽기 ("다음" 버튼으로 끝 페이지까지)');
    expect(titles[6]).toBe('"조정 목록" 표에 엑셀 채우기');
    expect(titles[7]).toBe('정리: 공정별 건수를 정리한다');
    const closed = open(draft());
    expect(describeBlock(closed.blocks.at(-1)!)).toMatchObject({ kind: 'report', label: '보고' });
    expect(describeBlock(closed.blocks[0])).toMatchObject({ label: '이동', icon: 'navigate' });
  });
});
