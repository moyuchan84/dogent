import { describe, expect, it } from 'vitest';
import { composeSkill, composeStart, finalizeDraft, parseSkill, reviseSkill, runSkill, type ChatMessage, type LlmPort } from '../src/core';
import { JsdomBrowser, memoryFiles, mockLlm, scriptedLlm } from './helpers';

const ui = { ask: async () => '', approve: async () => false };

/** 재공 화면에서 라인을 골라 조회하고 건수를 보고하는 초안 (모델이 낸다고 치는 JSON) */
const wipSpec = (over: Record<string, unknown> = {}) => ({
  id: 'Wip Count!',
  name: '재공 건수 확인',
  description: '라인을 골라 재공을 조회하고 총 건수를 보고한다. "8라인 재공 몇 건이야" 같은 요청에 쓴다.',
  risk: 'R1',
  inputs: [{ name: 'line', label: '라인', description: '조회할 라인. 예 "7라인"', type: 'string', default: '7라인', required: true }],
  steps: [
    { text: '"라인"에서 {line}을 선택한다', check: 'value("라인") == "{line}"' },
    { text: '"조회" 버튼을 눌러 결과를 띄운다', check: 'no_text("조회 중") and text("총")' },
    { text: '총 건수를 확인해 보고한다' },
  ],
  exceptions: ['결과가 0건이면 abort로 알린다'],
  result: '라인과 총 건수',
  ...over,
});

async function startOf(path: string) {
  const browser = await JsdomBrowser.open(path);
  const snap = await browser.snapshot();
  return { browser, snap, start: composeStart(`http://localhost:4173${path}`, '재공', snap) };
}

/** 주고받은 메시지를 남기는 모델 */
function recording(inner: LlmPort) {
  const calls: ChatMessage[][] = [];
  return { calls, complete: (m: ChatMessage[], s?: AbortSignal) => (calls.push(m), inner.complete(m, s)) };
}

describe('말로 스킬 만들기: 초안', () => {
  it('모델의 JSON으로 SKILL.md를 만들고, 시작 화면 이동과 사이트는 지금 탭으로 정한다', async () => {
    const { snap, start } = await startOf('/wip.html');
    const llm = recording(scriptedLlm([wipSpec()]));
    const draft = await composeSkill('라인 골라서 재공 몇 건인지 알려줘', llm, { start, snap, takenIds: new Set(['wip-count']) });

    // 모델에는 지금 화면을 보여 준다
    expect(llm.calls[0][1].content).toContain('## 지금 화면');
    expect(llm.calls[0][1].content).toContain('"라인"');
    const skill = parseSkill(draft.source);
    expect(skill.id).toBe('wip-count-2'); // 규칙에 맞추고 겹치지 않게
    expect(skill.domains).toEqual(['localhost:4173']);
    expect(skill.steps[0]).toContain('navigate로 "재공 현황 조회" 화면으로 이동한다');
    expect(skill.steps[0]).toContain('`{"url":"http://localhost:4173/wip.html"}`');
    // 화면에 하나뿐인 칸을 고르기·누르기만 하는 단계는 빠른 경로가 된다 (원래 문장은 목적 줄로)
    expect(skill.steps[1]).toBe(
      'select로 "라인"에서 {line}을(를) 선택한다. args는 다음을 그대로 쓴다.\n   `{"ref":"라인","value":"{line}"}`\n   - 목적: "라인"에서 {line}을 선택한다\n   - 검사: value("라인") == "{line}"',
    );
    expect(skill.steps[2]).toContain('`{"ref":"조회"}`');
    expect(skill.steps[2]).toContain('- 검사: did("click") and no_text("조회 중") and text("총")');
    expect(skill.steps[3]).toBe('총 건수를 확인해 보고한다');
    expect(draft.report.direct).toEqual({ count: 3, total: 4 });
    expect(skill.inputs[0]).toMatchObject({ name: 'line', default: '7라인', required: false });
    expect(draft.report.grade).not.toBe('F');
    expect(draft.report.findings.filter((f) => f.level === 'warn')).toEqual([]);
  });

  it('읽을 수 없는 검사, 목표 단계에 못 쓰는 검사, 시작 화면에 이미 보이는 글자의 검사는 빼고 알린다', async () => {
    const { snap, start } = await startOf('/wip.html');
    const spec = wipSpec({
      steps: [
        { text: '라인을 {line}으로 맞춘다', check: 'text("재공 현황 조회") and value("라인") == "{line}"' },
        { text: '결과를 띄운다', check: 'rows("x") == 3 and dataset("wip")' },
        { text: '보고한다' },
      ],
    });
    const draft = await composeSkill('재공 건수', scriptedLlm([spec]), { start, snap });
    const skill = parseSkill(draft.source);
    expect(skill.steps[1]).toBe('라인을 {line}으로 맞춘다\n   - 검사: value("라인") == "{line}"');
    expect(skill.steps[2]).toBe('결과를 띄운다');
    const notes = draft.notes.join('\n');
    expect(notes).toContain('시작 화면에 이미 있어');
    expect(notes).toContain('읽을 수 없는 식');
    expect(notes).toContain('말로 적은 단계에 쓸 수 없어');
  });

  it('시작 화면에서 이미 참인 검사(화면에 있는 표 이름, 없는 글자의 no_text)만 남으면 검사를 뺀다', async () => {
    const { snap, start } = await startOf('/wip.html');
    const spec = wipSpec({ steps: [{ text: '결과를 띄운다', check: 'no_text("조회 중") and text("재공 목록")' }, { text: '보고한다' }] });
    const draft = await composeSkill('재공', scriptedLlm([spec]), { start, snap });
    expect(parseSkill(draft.source).steps[1]).toBe('결과를 띄운다');
    expect(draft.notes.join('\n')).toContain('시작 화면에서 이미 참이라');
    // 시작 화면의 주소도 마찬가지다
    const again = await composeSkill('재공', scriptedLlm([wipSpec({ steps: [{ text: '결과를 띄운다', check: 'url("/wip.html")' }, { text: '보고한다' }] })]), { start, snap });
    expect(parseSkill(again.source).steps[1]).toBe('결과를 띄운다');
  });

  it('입력 이름을 규칙에 맞게 바꾸면 단계의 자리표시자도 따라 바꾼다', async () => {
    const { snap, start } = await startOf('/wip.html');
    const spec = wipSpec({
      inputs: [{ name: 'LineName', label: '라인', type: 'string', required: true }],
      steps: [{ text: '"라인"에서 {LineName}을 선택한다' }, { text: '보고한다' }],
    });
    const draft = await composeSkill('재공', scriptedLlm([spec]), { start, snap });
    expect(parseSkill(draft.source).steps[1]).toContain('`{"ref":"라인","value":"{linename}"}`');
    expect(draft.report.findings.filter((f) => f.rule === 'E03')).toEqual([]);
  });

  it('작은 모델의 버릇을 고친다: 역할 이름, 박아 넣은 값, 빈 보기 기본값, 값 없는 입력, 보고 없는 끝', async () => {
    const { snap, start } = await startOf('/wip.html');
    // gemma3:4b가 실제로 낸 모양 (docs/06 측정)
    const spec = wipSpec({
      inputs: [{ name: 'line', label: '라인', type: 'string', default: '선택', required: true }],
      steps: [{ text: "combobox '라인'을 '8라인'으로 선택한다." }, { text: "textbox '제품코드'에 값을 입력한다." }, { text: "button '조회'를 클릭한다." }],
      result: '',
    });
    const draft = await composeSkill('재공', scriptedLlm([spec]), { start, snap });
    const skill = parseSkill(draft.source);
    expect(skill.inputs[0]).toMatchObject({ name: 'line', default: '8라인' });
    expect(skill.steps).toHaveLength(4); // 이동, 라인, 조회, 보고 (값 없는 입력은 뺌)
    expect(skill.steps[1]).toContain('`{"ref":"라인","value":"{line}"}`');
    expect(skill.steps[1]).toContain('- 목적: "라인"을 "8라인"으로 선택한다.');
    expect(skill.steps[2]).toContain('`{"ref":"조회"}`');
    expect(skill.steps[3]).toBe('결과를 정리해 보고한다');
    const notes = draft.notes.join('\n');
    expect(notes).toContain('빈 보기라 뺐습니다');
    expect(notes).toContain('입력 {line}(으)로 바꿨습니다');
    expect(notes).toContain('"제품코드"에 넣을 값이 없어 뺐습니다');
    expect(notes).toContain('보고하는 단계가 없어 붙였습니다');
    expect(draft.report.grade).not.toBe('F');
  });

  it('처음부터 그 값인 칸 고르기는 빼고, 값 없는 입력은 같은 라벨의 입력으로, 검사 없는 마지막 단계는 보고와 합친다', async () => {
    const { snap, start } = await startOf('/wip.html');
    // gemma3:4b 두 번째 측정에서 나온 모양
    const spec = wipSpec({
      inputs: [{ name: 'product_code', label: '제품코드', type: 'string', required: true }],
      steps: [{ text: '"공정"에서 "전체"를 선택한다.' }, { text: '"제품코드"에 값을 입력한다.' }, { text: '"조회"를 누른다.' }, { text: '"재공 목록"에서 건수를 확인한다.' }],
      result: '{line} 라인 재공 총 {row_count}건',
    });
    const draft = await composeSkill('재공', scriptedLlm([spec]), { start, snap });
    const skill = parseSkill(draft.source);
    expect(skill.steps).toHaveLength(4); // 이동, 제품코드, 조회, 확인+보고
    expect(skill.steps[1]).toContain('`{"ref":"제품코드","text":"{product_code}"}`');
    expect(skill.steps[3]).toBe('"재공 목록"에서 건수를 확인한다. 그 결과를 정리해 보고한다');
    expect(draft.notes.join('\n')).toContain('"공정"은(는) 처음부터 "전체"라 뺐습니다');
    // 보고할 내용의 지어낸 자리표시자는 단계에 들어가지 않는다 (결과 절에만)
    expect(draft.report.findings.filter((f) => f.level === 'error')).toEqual([]);
  });

  it('화면에 없는 요소, 보기에 없는 값은 빠른 경로로 바꾸지 않는다', async () => {
    const { snap, start } = await startOf('/wip.html');
    const spec = wipSpec({ inputs: [], steps: [{ text: '"라인"에서 "9라인"을 선택한다' }, { text: '"없는 버튼"을 누른다' }, { text: '보고한다' }] });
    const skill = parseSkill((await composeSkill('재공', scriptedLlm([spec]), { start, snap })).source);
    expect(skill.steps[1]).toBe('"라인"에서 "9라인"을 선택한다');
    expect(skill.steps[2]).toBe('"없는 버튼"을 누른다');
  });

  it('품질 검사 오류가 있으면 오류를 알려 한 번 더 고치게 한다', async () => {
    const { snap, start } = await startOf('/wip.html');
    const broken = wipSpec({ steps: [{ text: '"라인"에서 {lien}을 선택한다' }, { text: '보고한다' }] });
    const llm = recording(scriptedLlm([broken, wipSpec()]));
    const draft = await composeSkill('재공', llm, { start, snap });
    expect(llm.calls).toHaveLength(2);
    expect(llm.calls[1][1].content).toContain('{lien}은(는) 선언한 입력이 아닙니다');
    expect(draft.report.grade).not.toBe('F');
  });

  it('R3이면 저장 단계 번호를 이동 단계만큼 밀어 submit_steps로 선언한다', async () => {
    const { snap, start } = await startOf('/fw.html');
    const spec = wipSpec({
      risk: 'R3',
      inputs: [{ name: 'ip', label: '출발지 IP', type: 'string', required: true }],
      steps: [{ text: '"출발지 IP"에 {ip}를 넣는다' }, { text: '"상신" 버튼을 누른다', check: 'dialog("상신")' }, { text: '신청 번호를 보고한다' }],
      submit: { step: 2, labels: ['상신'] },
    });
    const draft = await composeSkill('방화벽 신청', scriptedLlm([spec]), { start, snap });
    const skill = parseSkill(draft.source);
    expect(skill.risk).toBe('R3');
    expect(skill.submit_steps).toEqual([3]);
    expect(skill.submit_labels).toEqual(['상신']);
  });

  it('R1인데 저장·상신 말이 있으면 알린다', async () => {
    const { snap, start } = await startOf('/wip.html');
    const draft = await composeSkill('재공', scriptedLlm([wipSpec({ steps: [{ text: '조회 조건을 저장한다' }, { text: '보고한다' }] })]), { start, snap });
    expect(draft.notes.join('\n')).toContain('2단계에 저장·상신 계열 말이 있습니다');
  });

  it('모델이 JSON을 주지 않으면 알린다', async () => {
    const { snap, start } = await startOf('/wip.html');
    await expect(composeSkill('재공', scriptedLlm(['모르겠습니다']), { start, snap })).rejects.toThrow('JSON으로 주지 않았습니다');
  });
});

describe('말로 스킬 만들기: 고치기와 저장', () => {
  it('고칠 말과 지금 초안, 시험 결과를 함께 보내고 id는 그대로 둔다', async () => {
    const { snap, start } = await startOf('/wip.html');
    const first = await composeSkill('재공', scriptedLlm([wipSpec()]), { start, snap });
    const llm = recording(scriptedLlm([wipSpec({ id: 'other', name: '재공 건수와 정체' })]));
    const next = await reviseSkill(first, '정체 Lot 수도 같이 알려 줘', llm, { start, snap }, '실패: 3단계 시간 초과');
    const sent = llm.calls[0][1].content;
    expect(sent).toContain('## 지금 초안');
    expect(sent).toContain('"name": "재공 건수 확인"');
    expect(sent).toContain('실패: 3단계 시간 초과');
    expect(sent).toContain('정체 Lot 수도 같이 알려 줘');
    expect(next.spec.id).toBe(first.spec.id);
    expect(parseSkill(next.source).name).toBe('재공 건수와 정체');
  });

  it('저장할 때 담당 부서를 넣는다', async () => {
    const { snap, start } = await startOf('/wip.html');
    const draft = finalizeDraft(await composeSkill('재공', scriptedLlm([wipSpec()]), { start, snap }), '생산관리', 'wip-count');
    const skill = parseSkill(draft.source);
    expect(skill.owner).toBe('생산관리');
    expect(skill.id).toBe('wip-count');
  });
});

describe('말로 스킬 만들기: 만든 스킬 실행', () => {
  /** 목표 단계를 화면 이름으로 수행하는 모의 모델 (요소 이름으로 적은 ref는 루프가 번호로 바꾼다) */
  const agent: LlmPort = {
    async complete(messages) {
      const user = messages[1].content;
      const m = /## 지금 할 단계 \((\d+)\/(\d+)\)\n\d+\. (.+)/.exec(user)!;
      const [n, total, text] = [Number(m[1]), Number(m[2]), m[3]];
      const inputs = JSON.parse(/입력값: (.+)/.exec(user)![1]);
      if (n === total) {
        const count = /총 ([\d,]+)건/.exec(user)?.[1] ?? '?';
        return JSON.stringify({ thought: '보고', tool: 'finish', args: { summary: `${inputs.line} 재공 ${count}건` } });
      }
      if (text.includes('선택')) return JSON.stringify({ thought: '라인', tool: 'select', args: { ref: '라인', value: inputs.line } });
      if (user.includes('조회 중')) return JSON.stringify({ thought: '대기', tool: 'wait_for', args: { text: '건', timeout_sec: 10 } });
      return JSON.stringify({ thought: '조회', tool: 'click', args: { ref: '조회' } });
    },
  };

  it('모의 모델로도 초안 → 이름 고치기 → 실행까지 된다 (클라이언트·앱 시험에 쓰는 경로)', async () => {
    const { browser, snap, start } = await startOf('/wip.html');
    const first = await composeSkill('라인 골라 재공 건수 알려줘', mockLlm, { start, snap });
    const draft = await reviseSkill(first, '이름을 라인별 재공 건수로 바꿔 줘', mockLlm, { start, snap });
    expect(draft.spec.name).toBe('라인별 재공 건수');
    expect(draft.report.grade).toBe('A');
    const result = await runSkill(parseSkill(finalizeDraft(draft, '생산관리').source), { line: '8라인' }, { llm: mockLlm, browser, ui, files: memoryFiles(), direct: true });
    expect(result.status, result.message).toBe('done');
    expect(result.message).toMatch(/^총 \d+건입니다\.$/);
  });

  it('녹화 없이 만든 스킬이 모의 사이트에서 끝까지 돈다', async () => {
    const { browser, snap, start } = await startOf('/wip.html');
    const draft = finalizeDraft(await composeSkill('재공', scriptedLlm([wipSpec()]), { start, snap }), '생산관리');
    const result = await runSkill(parseSkill(draft.source), { line: '8라인' }, { llm: agent, browser, ui, files: memoryFiles(), direct: true });
    expect(result.status, result.message).toBe('done');
    expect(result.message).toMatch(/^8라인 재공 \d[\d,]*건$/);
  });
});
