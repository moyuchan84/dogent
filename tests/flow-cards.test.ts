import { describe, expect, it } from 'vitest';
import {
  blockInputName,
  blockValue,
  convertToFixed,
  convertToInput,
  draftSkill,
  extractBlock,
  insertBlocks,
  parseFlow,
  parseSkill,
  renderFlow,
  setBlockValue,
  summarizeBlocks,
  type AuthorStep,
  type Flow,
} from '../src/core';

function open(source: string): Flow {
  const f = parseFlow(source);
  if (!f.ok) throw new Error(f.reason);
  return f;
}

const meta = { id: 'wip-check', name: '재공 확인', description: '재공을 조회한다', owner: '생산관리' };
const start = { url: 'http://localhost:4173/wip.html', heading: '재공 현황 조회' };
const flow = () =>
  open(
    draftSkill(meta, start, [
      { kind: 'select', name: '라인', value: '7라인', options: ['7라인', '8라인'], variable: false } as AuthorStep,
      { kind: 'type', name: '제품코드', value: 'A100', variable: true, param: { name: 'code', description: '제품 코드' } } as AuthorStep,
      { kind: 'click', name: '조회' } as AuthorStep,
      { kind: 'extract', name: '재공 목록' },
    ]).source,
  );

describe('카드의 입력 단계', () => {
  it('고정값을 바꾸면 인자 줄과 검사 식이 함께 바뀐다 (시작 주소는 그대로)', () => {
    const f = setBlockValue(flow(), 1, '8라인');
    expect(blockValue(f.blocks[1])).toBe('8라인');
    expect(f.blocks[1].check).toBe('value("라인") == "8라인"');
    expect(f.blocks[0].literal).toBe('{"url":"http://localhost:4173/wip.html"}');
    expect(setBlockValue(flow(), 3, 'x').notices[0]).toContain('고칠 수 없는');
  });

  it('실행할 때마다 입력받기를 켜고 끈다', () => {
    const on = convertToInput(flow(), 1);
    expect(blockInputName(on.blocks[1])).toBe('v1');
    expect(on.meta.inputs.map((i) => i.name)).toEqual(['code', 'v1']);
    expect(on.meta.inputs[1]).toMatchObject({ label: '라인', default: '7라인', required: false });
    expect(on.blocks[1].check).toBe('value("라인") == "{v1}"');
    expect(() => parseSkill(renderFlow(on))).not.toThrow();
    const off = convertToFixed(on, 1);
    expect(blockValue(off.blocks[1])).toBe('7라인');
    expect(off.meta.inputs.map((i) => i.name)).toEqual(['code']);
    expect(off.blocks[1].check).toBe('value("라인") == "7라인"');
    // 이미 입력받는 단계에 다시 켜도 그대로
    expect(convertToInput(on, 1)).toBe(on);
    // 다른 단계가 같은 입력을 쓰면 선언은 남긴다
    const codeOff = convertToFixed(flow(), 2);
    expect(codeOff.meta.inputs).toHaveLength(0);
  });
});

describe('카드에서 단계 만들기', () => {
  it('표 읽기는 안 쓰는 데이터셋 이름을 고른다', () => {
    const f = flow();
    const b = extractBlock(f, '다른 표', '다음');
    expect(b.literal).toBe('{"ref":"다른 표","dataset":"data2","next_ref":"다음"}');
    expect(b.check).toBe('dataset("data2")');
    const g = insertBlocks(f, 4, [b]);
    expect(() => parseSkill(renderFlow(g))).not.toThrow();
  });

  it('표를 정리하는 단계는 표 읽기와 정리가 한 쌍이고 이름이 겹치지 않는다', () => {
    let f = flow();
    f = insertBlocks(f, 4, summarizeBlocks(f, '공정별 건수', { table: '재공 목록' }));
    f = insertBlocks(f, 4, summarizeBlocks(f, '화면 요약', 'page'));
    const text = renderFlow(f);
    expect(text).toContain('"dataset":"sum1"');
    expect(text).toContain('"name":"report1"');
    expect(text).toContain('"name":"report2"');
    expect(() => parseSkill(text)).not.toThrow();
  });
});
