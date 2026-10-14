import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'vitest';
import { draftSkill, lintSkill, parseSkill, type AuthorStep } from '../src/core';
import { dialogHook } from '../src/page/dialogs';

const META = { id: 'hold-recorded', name: '홀드 해제(녹화)', description: '녹화로 만든 홀드 해제 요청', owner: '생산관리' };
const START = { url: 'http://localhost:4173/hold.html', heading: 'Lot 홀드 해제 요청' };
const click = (name: string, more: object = {}): AuthorStep => ({ kind: 'click', role: 'button', name, dup: false, ...more });

describe('새 창과 알림·확인 창이 낀 조작의 초안', () => {
  it('팝업에서 행을 고르고, 확인 창을 거쳐 상신한 조작이 그대로 실행되는 스킬이 된다', () => {
    const steps: AuthorStep[] = [
      click('Lot 찾기', { expect: '홀드 Lot 찾기' }),
      click('선택', { dup: true, row: 'P7-00031', expect: 'Lot 홀드 해제 요청' }),
      { kind: 'type', name: '해제 사유', value: '설비 점검이 끝나 공정을 다시 진행함', dup: false, multiline: true, numeric: false, variable: true },
      click('상신', {
        dialogs: [
          { kind: 'confirm', message: '상신하시겠습니까?', accepted: true },
          { kind: 'alert', message: '접수되었습니다. 접수 번호: HR-000001', accepted: true },
        ],
      }),
    ];
    const { source, notes } = draftSkill(META, START, steps);
    expect(source).toContain('`{"ref":"선택","row":"P7-00031"}`');
    expect(source).toContain('- 검사: did("click") and text("홀드 Lot 찾기")');
    // 접수 번호는 매번 달라지므로 알림 창의 첫 문장만 검사한다.
    expect(source).toContain('- 검사: did("click") and dialog("접수되었습니다")');
    // 상신은 승인받은 제출이라 확인 창을 따로 넘기라고 적지 않는다.
    expect(source).toContain('`{"ref":"상신"}`');
    expect(notes.join('\n')).toContain('dialog_text(');

    const skill = parseSkill(source);
    expect(skill.risk).toBe('R3');
    expect(skill.submit_steps).toEqual([5]);
    expect(lintSkill(source).findings.filter((f) => f.level === 'error')).toEqual([]);
  });

  it('제출이 아닌 확인 창에 확인을 눌렀으면 accept_dialog를 적는다', () => {
    const { source, notes } = draftSkill(META, START, [
      click('초기화', { dialogs: [{ kind: 'confirm', message: '입력한 내용을 지우시겠습니까?', accepted: true }] }),
      click('닫기', { dialogs: [{ kind: 'confirm', message: '닫을까요?', accepted: false }] }),
    ]);
    expect(source).toContain('`{"ref":"초기화","accept_dialog":true}`');
    expect(source).toContain('`{"ref":"닫기"}`');
    expect(notes.join('\n')).toContain('"입력한 내용을 지우시겠습니까?"에 확인을 누르도록');
    expect(parseSkill(source).risk).toBe('R1');
  });

  it('버튼 이름이 평범해도 제출을 묻는 확인 창에 확인을 눌렀으면 제출 단계로 선언한다', () => {
    const { source } = draftSkill(META, START, [
      click('확인', { dialogs: [{ kind: 'confirm', message: '결재를 상신하시겠습니까?', accepted: true }] }),
    ]);
    const skill = parseSkill(source);
    expect(skill.risk).toBe('R3');
    expect(skill.submit_steps).toEqual([2]);
    expect(skill.submit_labels).toEqual(['확인']);
    expect(source).toContain('`{"ref":"확인"}`');
  });

  it('다음 페이지 버튼을 고르면 끝까지 넘기며 읽는 단계가 된다', () => {
    const paged = draftSkill(META, START, [{ kind: 'extract', name: '재공 목록', next: '다음' }]);
    expect(paged.source).toContain('`{"ref":"재공 목록","dataset":"data1","next_ref":"다음"}`');
    expect(paged.notes.join('\n')).not.toContain('next_ref');
    const single = draftSkill(META, START, [{ kind: 'extract', name: '재공 목록' }]);
    expect(single.source).toContain('`{"ref":"재공 목록","dataset":"data1"}`');
    expect(single.notes.join('\n')).toContain('next_ref');
  });
});

describe('녹화 중의 알림·확인 창', () => {
  it('창은 그대로 띄우고 내용과 사람의 답만 적는다', () => {
    const dom = new JSDOM('<!doctype html><body></body>', { url: 'http://localhost:4173/t', runScripts: 'outside-only' });
    const w = dom.window as any;
    const asked: string[] = [];
    w.alert = (m: string) => void asked.push(`alert:${m}`);
    w.confirm = (m: string) => (asked.push(`confirm:${m}`), m.includes('상신'));
    w.prompt = (m: string) => (asked.push(`prompt:${m}`), null);
    const hook = w.eval(`(${dialogHook.toString()})`) as typeof dialogHook;

    hook({ do: 'watch' });
    hook({ do: 'watch' });
    expect(w.confirm('상신하시겠습니까?')).toBe(true);
    expect(w.confirm('지울까요?')).toBe(false);
    w.alert('접수되었습니다.');
    expect(w.prompt('사번')).toBeNull();
    // 사람에게 실제로 한 번씩 물었다.
    expect(asked).toEqual(['confirm:상신하시겠습니까?', 'confirm:지울까요?', 'alert:접수되었습니다.', 'prompt:사번']);
    expect(hook({ do: 'drain' })).toEqual([
      { kind: 'confirm', message: '상신하시겠습니까?', accepted: true, at: expect.any(Number) },
      { kind: 'confirm', message: '지울까요?', accepted: false, at: expect.any(Number) },
      { kind: 'alert', message: '접수되었습니다.', accepted: true, at: expect.any(Number) },
      { kind: 'prompt', message: '사번', accepted: false, at: expect.any(Number) },
    ]);
    expect(hook({ do: 'drain' })).toEqual([]);

    hook({ do: 'off' });
    w.alert('끝');
    expect(hook({ do: 'drain' })).toEqual([]);
    expect(asked.at(-1)).toBe('alert:끝');
  });
});
