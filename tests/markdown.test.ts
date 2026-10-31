import { describe, expect, it } from 'vitest';
import { describeResult } from '../client/src/terminal';
import { displayWidth, inlineText, looksLikeMarkdown, markdownToTerminal, parseInline, parseMarkdown, tableMarkdown, type RunResult } from '../src/core';

const REPORT = `8라인 재공은 **173건**이고, HOLD가 3건입니다.

### 상태별
- 진행: **150건**
- 대기: 20건
  - 그중 PHOTO 12건
- HOLD: 3건

| 상태 | 건수 |
| --- | ---: |
| 진행 | 150 |
| HOLD | 3 |

1. 첫째
2. 둘째`;

describe('마크다운 읽기', () => {
  it('제목·문단·목록(하위 포함)·표·번호 목록으로 나눈다', () => {
    const blocks = parseMarkdown(REPORT);
    expect(blocks.map((b) => b.type)).toEqual(['paragraph', 'heading', 'list', 'table', 'list']);
    const list = blocks[2];
    expect(list.type === 'list' && list.items.map((i) => inlineText(i.children))).toEqual(['진행: 150건', '대기: 20건', 'HOLD: 3건']);
    expect(list.type === 'list' && list.items[1].sub?.[0].type).toBe('list');
    const table = blocks[3];
    expect(table.type === 'table' && table.align).toEqual([null, 'right']);
    expect(table.type === 'table' && table.rows.map((r) => r.map(inlineText))).toEqual([['진행', '150'], ['HOLD', '3']]);
    const ol = blocks[4];
    expect(ol.type === 'list' && ol.ordered).toBe(true);
  });

  it('글 안의 굵게·코드·링크를 읽고, 위험한 링크와 HTML은 글자로 남긴다', () => {
    expect(parseInline('**굵게** `코드` [문서](https://a.example/x)')).toEqual([
      { type: 'strong', children: [{ type: 'text', text: '굵게' }] },
      { type: 'text', text: ' ' },
      { type: 'code', text: '코드' },
      { type: 'text', text: ' ' },
      { type: 'link', href: 'https://a.example/x', children: [{ type: 'text', text: '문서' }] },
    ]);
    expect(parseInline('[누르기](javascript:alert(1))').every((n) => n.type === 'text')).toBe(true);
    expect(inlineText(parseInline('<img src=x onerror=alert(1)>'))).toBe('<img src=x onerror=alert(1)>');
    // 낱말 안의 밑줄은 기울임이 아니다
    expect(parseInline('lot_id와 step_name')).toEqual([{ type: 'text', text: 'lot_id와 step_name' }]);
  });

  it('마크다운이 아닌 평범한 글은 그렇게 알아본다', () => {
    expect(looksLikeMarkdown('표 23행을 재공.xlsx로 저장했습니다')).toBe(false);
    expect(looksLikeMarkdown(REPORT)).toBe(true);
  });
});

describe('데이터셋을 마크다운 표로', () => {
  it('숫자 칸은 오른쪽 정렬, | 와 줄바꿈은 칸을 깨지 않게, 많으면 앞부분만', () => {
    const md = tableMarkdown(['Lot', '수량', '메모'], [['A|1', 10, '두\n줄'], ['B', 2000, '']]);
    expect(md).toBe('| Lot | 수량 | 메모 |\n| --- | ---: | --- |\n| A\\|1 | 10 | 두 줄 |\n| B | 2000 |  |');
    const t = parseMarkdown(md)[0];
    expect(t.type === 'table' && t.rows[0].map(inlineText)).toEqual(['A|1', '10', '두 줄']);
    const many = tableMarkdown(['n'], Array.from({ length: 30 }, (_, i) => [i]), 5);
    expect(many.split('\n').filter((l) => l.startsWith('|'))).toHaveLength(7);
    expect(many).toMatch(/전체 30행 중 앞의 5행$/);
  });
});

describe('터미널', () => {
  it('한글은 두 칸으로 세어 표의 칸을 맞춘다', () => {
    expect(displayWidth('HOLD')).toBe(4);
    expect(displayWidth('진행')).toBe(4);
    const out = markdownToTerminal('| 상태 | 건수 |\n| --- | ---: |\n| 진행 | 150 |\n| HOLD | 3 |');
    const lines = out.split('\n');
    expect(lines).toEqual(['┌──────┬──────┐', '│ 상태 │ 건수 │', '├──────┼──────┤', '│ 진행 │  150 │', '│ HOLD │    3 │', '└──────┴──────┘']);
    expect(new Set(lines.map(displayWidth)).size).toBe(1);
  });

  it('목록은 글머리로, 결과 보고는 첫 줄을 상태 옆에 둔다', () => {
    const r: RunResult = { status: 'done', message: REPORT, lastStep: 1, actions: 2, files: [], datasets: [], outputs: {}, elapsedMs: 1500 };
    const text = describeResult(r, [], { isTTY: false, columns: 80 });
    expect(text).toContain('[완료] 8라인 재공은 173건이고, HOLD가 3건입니다.');
    expect(text).toContain('  • 진행: 150건');
    expect(text).toContain('    • 그중 PHOTO 12건');
    expect(text).toContain('  │ HOLD │    3 │');
    expect(text).not.toContain('**');
    expect(text).not.toMatch(/\x1b\[/);
  });
});
