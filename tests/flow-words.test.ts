import { describe, expect, it } from 'vitest';
import {
  FLOW_EDIT_PROMPT,
  applyOps,
  composeStart,
  createFlowByWords,
  draftSkill,
  parseFlow,
  parseOps,
  parseSkill,
  renderFlow,
  reviseFlowByWords,
  type AuthorStep,
  type ChatMessage,
  type Flow,
  type LlmPort,
} from '../src/core';
import { JsdomBrowser, scriptedLlm } from './helpers';

function open(source: string): Flow {
  const f = parseFlow(source);
  if (!f.ok) throw new Error(f.reason);
  return f;
}

const meta = { id: 'wip-check', name: '재공 확인', description: '재공을 조회한다', owner: '생산관리' };
const start = { url: 'http://localhost:4173/wip.html', heading: '재공 현황 조회' };
const steps: AuthorStep[] = [
  { kind: 'select', name: '라인', value: '7라인', options: ['7라인', '8라인'], variable: true, param: { name: 'line', description: '조회할 라인' } } as AuthorStep,
  { kind: 'click', name: '조회', expect: '총' } as AuthorStep,
  { kind: 'goal', text: '결과 중 HOLD인 Lot의 사유를 확인해 정리해 보고한다' },
];
// 1 이동, 2 라인 선택, 3 조회, 4 말로 적은 단계
const flow = () => open(draftSkill(meta, start, steps).source);

const ctx = { url: 'http://localhost:4173/wip.html', title: '재공' };

/** 받은 메시지를 남기고 고정된 답을 주는 모델 */
function spy(reply: string) {
  const seen: ChatMessage[][] = [];
  const llm: LlmPort = {
    async complete(messages) {
      seen.push(messages);
      return reply;
    },
  };
  return { llm, seen };
}

describe('말로 흐름 고치기', () => {
  it('연산을 적용하고 무엇이 바뀌었는지 돌려준다', async () => {
    const reply = JSON.stringify({
      ops: [
        { op: 'insert', after: 3, text: '상태가 HOLD인 행만 남긴다', check: 'text("HOLD")', note: 'HOLD만 거른다' },
        { op: 'update', n: 4, text: '남은 Lot의 HOLD 사유를 확인해 정리해 보고한다' },
        { op: 'input', name: 'line_default', label: '라인 기본', default: '8라인' },
        { op: 'meta', name: '재공 HOLD 확인' },
      ],
    });
    const { llm, seen } = spy('설명입니다\n' + reply);
    const r = await reviseFlowByWords(flow(), '3번 뒤에 HOLD만 거르는 단계 추가, 라인 기본값은 8라인', llm, ctx, { lastRun: '3번에서 실패: 조회 버튼이 없습니다' });
    expect(r.skipped).toEqual([]);
    expect(r.changes).toHaveLength(4);
    expect(r.flow.blocks.map((b) => b.head).slice(3)).toEqual(['상태가 HOLD인 행만 남긴다', '남은 Lot의 HOLD 사유를 확인해 정리해 보고한다']);
    expect(r.flow.blocks[3].check).toBe('text("HOLD")');
    expect(r.flow.blocks[3].literal).toBeNull();
    expect(r.flow.meta.name).toBe('재공 HOLD 확인');
    expect(r.flow.meta.inputs.map((i) => i.name)).toEqual(['line', 'line_default']);
    expect(() => parseSkill(renderFlow(r.flow))).not.toThrow();
    // 모델에는 단계 목록, 화면, 사용자의 말, 시험 결과가 간다
    const user = seen[0][1].content;
    expect(seen[0][0].content).toBe(FLOW_EDIT_PROMPT);
    expect(user).toContain('1. [이동]');
    expect(user).toContain('[인자 있음]');
    expect(user).toContain('{line}');
    expect(user).toContain('3번 뒤에 HOLD만 거르는 단계 추가');
    expect(user).toContain('## 방금 시험 결과');
    expect(FLOW_EDIT_PROMPT).toContain('각 행마다');
  });

  it('번호는 처음 흐름 기준이라 앞의 연산이 번호를 밀어도 같은 단계를 가리킨다', () => {
    const r = applyOps(flow(), [
      { op: 'insert', after: 1, text: '안내 창을 닫는다' },
      { op: 'update', n: 4, note: '보고 형식은 표' },
      { op: 'remove', n: 3 },
    ]);
    expect(r.skipped).toEqual([]);
    expect(r.flow.blocks.map((b) => b.head.slice(0, 6))).toEqual(['naviga', '안내 창을 ', 'select', '결과 중 H']);
    expect(r.flow.blocks[3].note).toBe('보고 형식은 표');
  });

  it('move는 지정한 번호 자리로 옮긴다', () => {
    const a = applyOps(flow(), [{ op: 'move', n: 4, to: 2 }]);
    expect(a.flow.blocks.map((b) => b.head.slice(0, 3))).toEqual(['nav', '결과 ', 'sel', 'cli']);
    const b = applyOps(flow(), [{ op: 'move', n: 2, to: 4 }]);
    expect(b.flow.blocks.map((x) => x.head.slice(0, 3))).toEqual(['nav', 'cli', '결과 ', 'sel']);
  });

  it('허용되지 않는 연산은 버리고 이유를 남긴다', () => {
    const r = applyOps(flow(), [
      { op: 'update', n: 1, text: '다른 곳으로 간다' }, // 1번
      { op: 'remove', n: 1 },
      { op: 'move', n: 3, to: 1 },
      { op: 'insert', after: 0, text: '맨 앞에 한다' },
      { op: 'update', n: 2, text: '"라인"에서 8라인을 고른다' }, // 인자 줄이 있는 단계의 문장
      { op: 'update', n: 9, text: '없는 단계' }, // 범위 밖
      { op: 'remove', n: 0 },
      { op: 'insert', after: 12, text: '없는 위치' },
      { op: 'move', n: 2, to: 9 },
      { op: 'input', name: 'Bad Name' },
      { op: 'rename', n: 1 },
      { op: 'update', n: 4, check: 'rows("x") == page_number("(")' },
      'not an op',
    ]);
    expect(r.changes).toEqual([]);
    expect(r.skipped).toHaveLength(13 - 0);
    const text = r.skipped.join('\n');
    expect(text).toContain('시작 화면');
    expect(text).toContain('인자가 정해진 단계');
    expect(text).toContain('9번 단계는 없습니다');
    expect(text).toContain('영문 소문자');
    expect(text).toContain('알 수 없는 연산');
    expect(renderFlow(r.flow)).toBe(renderFlow(flow()));
  });

  it('인자 줄이 있는 단계의 목적·검사는 고칠 수 있고 지우기·옮기기도 된다', () => {
    const r = applyOps(flow(), [
      { op: 'update', n: 2, note: '라인을 고른다', check: 'value("라인") == "{line}"' },
      { op: 'update', n: 3, check: 'text("총")' },
      { op: 'remove', n: 3 },
    ]);
    expect(r.skipped).toEqual([]);
    expect(r.flow.blocks[1].note).toBe('라인을 고른다');
    expect(r.flow.blocks).toHaveLength(3);
  });

  it('목표 단계의 검사로 쓸 수 없는 식은 검사만 빼고 단계는 넣는다', () => {
    const r = applyOps(flow(), [{ op: 'insert', after: 3, text: '새 단계', check: 'did("click")' }]);
    expect(r.flow.blocks[3].head).toBe('새 단계');
    expect(r.flow.blocks[3].check).toBeNull();
    expect(r.skipped.join()).toContain('말로 적은 단계에 쓸 수 없습니다');
  });

  it('저장·상신 단계를 말로 지우면 선언을 정리하고 알린다', () => {
    const f = open(draftSkill(meta, start, [...steps.slice(0, 2), { kind: 'click', name: '저장' } as AuthorStep, { kind: 'goal', text: '결과를 알린다' }]).source);
    const i = f.blocks.findIndex((b) => b.submit);
    const r = applyOps(f, [{ op: 'remove', n: i + 1 }]);
    expect(r.flow.meta.submit_steps).toEqual([]);
    expect(r.changes.join()).toContain('위험 등급');
  });

  it('새 단계 문장에 저장·상신 말이 있으면 경고가 따라온다', () => {
    const r = applyOps(flow(), [{ op: 'insert', after: 3, text: '내용을 확인하고 상신한다' }]);
    expect(r.flow.warnings.some((w) => w.message.includes('승인 필요'))).toBe(true);
  });

  it('모델이 JSON을 주지 않으면 사람이 읽을 오류를 던지고 흐름은 그대로다', async () => {
    const f = flow();
    await expect(reviseFlowByWords(f, '고쳐 줘', scriptedLlm(['네, 알겠습니다. 고치겠습니다.']), ctx)).rejects.toThrow(/읽지 못했습니다/);
    await expect(reviseFlowByWords(f, '고쳐 줘', scriptedLlm(['{"해": 1}']), ctx)).rejects.toThrow(/읽지 못했습니다/);
  });

  it('연산 목록은 {"ops"}, 맨 배열, 연산 하나 모두 읽는다', () => {
    expect(parseOps('{"ops":[{"op":"remove","n":2}]}')).toHaveLength(1);
    expect(parseOps('```json\n[{"op":"remove","n":2},{"op":"remove","n":3}]\n```')).toHaveLength(2);
    expect(parseOps('{"op":"remove","n":2}')).toHaveLength(1);
    expect(parseOps('{"ops":[]}')).toEqual([]);
    expect(parseOps('없음')).toBeNull();
    expect(parseOps('{"op":"remove","n":"2 }')).toBeNull();
  });

  it('연산이 하나도 없으면 변경 없음으로 돌려준다', async () => {
    const f = flow();
    const r = await reviseFlowByWords(f, '그대로 둬', scriptedLlm(['{"ops": []}']), ctx);
    expect(r.changes).toEqual([]);
    expect(r.skipped).toEqual([]);
    expect(renderFlow(r.flow)).toBe(renderFlow(f));
  });
});

describe('말로 새로 만들기', () => {
  it('composeSkill을 그대로 부르고 그 문서를 흐름으로 연다', async () => {
    const browser = await JsdomBrowser.open('/wip.html');
    const snap = await browser.snapshot();
    const spec = {
      id: 'wip-count',
      name: '재공 건수 확인',
      description: '라인을 골라 재공을 조회한다. "8라인 재공 몇 건이야" 같은 요청에 쓴다.',
      risk: 'R1',
      inputs: [{ name: 'line', label: '라인', description: '조회할 라인', type: 'string', default: '7라인', required: true }],
      steps: [{ text: '"라인"에서 {line}을 선택한다' }, { text: '"조회" 버튼을 눌러 결과를 띄운다', check: 'text("총")' }, { text: '총 건수를 확인해 보고한다' }],
    };
    const { flow: f, draft } = await createFlowByWords('라인별 재공 건수', scriptedLlm([JSON.stringify(spec)]), {
      start: composeStart('http://localhost:4173/wip.html', '재공', snap),
      snap,
    });
    expect(renderFlow(f)).toBe(draft.source);
    expect(f.meta.name).toBe('재공 건수 확인');
    expect(f.blocks.length).toBeGreaterThanOrEqual(4);
    expect(f.meta.inputs[0].name).toBe('line');
  });
});
