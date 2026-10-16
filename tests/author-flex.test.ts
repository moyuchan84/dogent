import { describe, expect, it } from 'vitest';
import { generateWip } from '../mock-site/data.mjs';
import { draftSkill, lintSkill, parseSkill, runSkill, type AuthorStep } from '../src/core';
import { JsdomBrowser, memoryFiles, mockLlm } from './helpers';

const meta = { id: 'wip-find', name: '재공 찾기', description: '제품코드로 재공을 찾아 정리한다', owner: '생산관리' };
const start = { url: 'http://localhost:4173/wip.html', heading: '재공 현황 조회' };
const ui = { ask: async () => '', approve: async () => false };

/** 사람이 재공 화면에서 라인을 고르고 제품코드를 넣어 조회한 녹화 */
const searched = (param?: { name?: string; description?: string }): AuthorStep[] => [
  { kind: 'select', name: '라인', value: '7라인', options: ['선택', '6라인', '7라인', '8라인'], dup: false, variable: false },
  { kind: 'type', name: '제품코드', value: 'DR5', dup: false, multiline: false, numeric: false, variable: true, ...(param ? { param } : {}) },
  { kind: 'click', role: 'button', name: '조회', dup: false, expect: '총', note: '검색 결과를 띄운다' },
];

describe('스킬 만들기: 매개변수 이름과 설명', () => {
  it('붙인 이름과 설명으로 입력을 만들고 단계에서 그 이름을 쓴다', () => {
    const { source } = draftSkill(meta, start, searched({ name: 'keyword', description: '제품코드 검색창에 넣을 값' }));
    const skill = parseSkill(source);
    expect(skill.inputs).toEqual([
      { name: 'keyword', label: '제품코드', description: '제품코드 검색창에 넣을 값', type: 'string', required: true },
    ]);
    expect(source).toContain('`{"ref":"제품코드","text":"{keyword}"}`');
  });

  it('규칙에 맞지 않거나 겹치는 이름은 v1, v2로 바꾸고 알린다', () => {
    const steps = [...searched({ name: '검색어' }), { kind: 'type', name: '메모', value: 'x', dup: false, multiline: false, numeric: false, variable: true, param: { name: 'v1' } } as AuthorStep];
    const { source, notes } = draftSkill(meta, start, steps);
    expect(parseSkill(source).inputs.map((i) => i.name)).toEqual(['v1', 'v2']);
    expect(notes.join('\n')).toMatch(/입력 이름 "검색어"은\(는\) 영문 소문자로/);
    expect(notes.join('\n')).toMatch(/입력 이름 "v1".*v2로 바꿨습니다/);
  });
});

describe('스킬 만들기: 설명, 말로 단계, 화면 정리', () => {
  it('조작에 단 목적은 단계의 "- 목적:" 줄이 된다', () => {
    const { source } = draftSkill(meta, start, searched());
    expect(source).toMatch(/click으로 "조회" 버튼을 한 번 누른다\. args는 다음을 그대로 쓴다\.\n {3}`\{"ref":"조회"\}`\n {3}- 목적: 검색 결과를 띄운다\n {3}- 검사:/);
  });

  it('중간의 말로 적은 단계는 목표 단계가 되고, 품질 검사는 안내만 한다', () => {
    const steps: AuthorStep[] = [...searched(), { kind: 'goal', text: '결과 중 상태가 HOLD인 Lot이 있으면 첫 번째 것의 공정을 확인한다' }, { kind: 'extract', name: '재공 목록' }];
    const { source } = draftSkill(meta, start, steps);
    expect(source).toContain('5. 결과 중 상태가 HOLD인 Lot이 있으면 첫 번째 것의 공정을 확인한다\n6. extract_table로');
    const report = lintSkill(source);
    expect(report.findings.find((f) => f.step === 5)).toMatchObject({ rule: 'I01', level: 'info' });
  });

  it('마지막이 말로 적은 단계면 그 단계가 보고하며 끝낸다 (고정 문구 finish를 붙이지 않음)', () => {
    const steps: AuthorStep[] = [...searched(), { kind: 'goal', text: '검색 결과를 공정별로 정리해 보고한다' }];
    const { source } = draftSkill(meta, start, steps);
    const skill = parseSkill(source);
    expect(skill.steps.at(-1)).toBe('검색 결과를 공정별로 정리해 보고한다');
    expect(source).not.toContain('finish로');
    expect(lintSkill(source).findings.filter((f) => f.level === 'warn').map((f) => f.rule)).not.toContain('W05');
  });

  it('화면 글 정리는 summarize 단계가 되고, 정리한 글이 보고에 붙는다', () => {
    const steps: AuthorStep[] = [...searched(), { kind: 'summarize', instruction: '화면의 주요 내용을 세 줄로 정리한다', source: 'page' }];
    const { source, notes } = draftSkill(meta, start, steps);
    expect(source).toContain('summarize로 화면의 글을(를) 정리한다. args는 다음을 그대로 쓴다.\n   `{"instruction":"화면의 주요 내용을 세 줄로 정리한다","source":"page","name":"report1"}`');
    expect(source).toContain('"summary":"재공 찾기을(를) 마쳤습니다.\\n{out.report1}"');
    expect(notes.join('\n')).toMatch(/사내 모델에 보냅니다/);
    expect(lintSkill(source).grade).not.toBe('F');
  });

  it('표 정리는 그 표를 끝 페이지까지 읽은 뒤 정리하고, 엑셀 저장 대상에는 넣지 않는다', () => {
    const steps: AuthorStep[] = [...searched(), { kind: 'summarize', instruction: '공정별 건수를 정리한다', source: { table: '재공 목록', next: '다음' } }];
    const { source } = draftSkill(meta, start, steps);
    expect(source).toContain('`{"ref":"재공 목록","dataset":"sum1","next_ref":"다음"}`');
    expect(source).toContain('"source":"sum1","name":"report1"');
    expect(source).not.toContain('write_excel');
  });

  it('녹화로 만든 정리 스킬을 다른 검색어로 실행하면 그 결과를 정리해 보고한다', async () => {
    const steps: AuthorStep[] = [
      ...searched({ name: 'keyword', description: '제품코드 검색창에 넣을 값' }),
      { kind: 'summarize', instruction: '공정별 건수를 정리한다', source: { table: '재공 목록', next: '다음' } },
    ];
    const skill = parseSkill(draftSkill(meta, start, steps).source);
    const r = await runSkill(skill, { keyword: 'NV2-1T' }, { llm: mockLlm, browser: await JsdomBrowser.open('/wip.html'), ui, files: memoryFiles(), direct: true });
    expect(r.status, r.message).toBe('done');
    const want = generateWip('7라인').filter((row) => row[1].includes('NV2-1T')).length;
    // 모의 모델은 표의 행마다 한 줄씩 적는다. 검색한 결과만 정리에 들어갔다.
    expect(r.outputs.report1).toMatch(new RegExp(`- ${want}행`));
    expect(r.message).toContain(r.outputs.report1);
  });
});
