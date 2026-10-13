import { JSDOM } from 'jsdom';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  lintSkill,
  parseSkill,
  resolveInputs,
  runSkill,
  stepCaptures,
  stepCheck,
  type ApprovalRequest,
  type HistoryEntry,
  type LlmPort,
  type RunDeps,
} from '../src/core';
import { dialogHook } from '../src/page/dialogs';
import { JsdomBrowser, holdLog, holdSkill, memoryFiles, scriptedLlm } from './helpers';

const INPUTS = { lot: 'P7-00031', reason: '설비 점검이 끝나 공정을 다시 진행함' };

const noLlm: LlmPort = {
  async complete() {
    throw new Error('모델이 호출되면 안 됩니다');
  },
};

function approver(answer: boolean) {
  const requests: ApprovalRequest[] = [];
  return { requests, ask: async () => '', approve: async (r: ApprovalRequest) => (requests.push(r), answer) };
}

/** 실행하면서 동작 기록을 모은다. */
async function run(skill: ReturnType<typeof holdSkill>, inputs: Record<string, unknown>, deps: Partial<RunDeps> & { browser: JsdomBrowser }) {
  const actions: HistoryEntry[] = [];
  const result = await runSkill(skill, inputs as never, {
    llm: noLlm,
    ui: approver(true),
    files: memoryFiles(),
    direct: true,
    ...deps,
    onEvent: (e) => e.type === 'action' && actions.push(e.entry),
  });
  return { result, actions };
}

/** 요청 화면에서 버튼 하나만 누르는 스킬 */
const oneClick = (args: string) =>
  parseSkill(`---
id: t
name: 시험
description: 확인 창 시험용
version: 0.1.0
owner: 시험
risk: R1
domains: [localhost:4173]
---

## 단계

1. click으로 버튼을 한 번 누른다. args는 다음을 그대로 쓴다.
   \`${args}\`
   - 검사: did("click")
2. finish로 보고한다. args는 다음을 그대로 쓴다.
   \`{"summary": "끝"}\`

## 예외

- 오류가 나오면 abort한다.
`);

/** Lot과 사유가 채워진 요청 화면 */
async function filled() {
  const browser = await JsdomBrowser.open('/hold.html');
  const el = (id: string) => browser.document.getElementById(id) as HTMLInputElement;
  el('lot').value = 'P7-00012';
  el('reason').value = '검사 완료';
  return { browser, el };
}

const giveUp = () => scriptedLlm([{ tool: 'abort', args: { reason: '그만' } }]);

beforeEach(() => {
  holdLog.length = 0;
});

describe('새 창과 알림·확인 창이 있는 업무 (Lot 홀드 해제 요청)', () => {
  it('팝업에서 값을 고르고, 승인받은 상신의 확인 창을 넘겨 알림 창의 접수 번호를 읽는다', async () => {
    const ui = approver(true);
    const browser = new JsdomBrowser();
    const { result, actions } = await run(holdSkill(), INPUTS, { browser, ui });

    expect(result.status, result.message).toBe('done');
    expect(result.message).toBe('접수 번호 HR-000001로 홀드 해제를 요청했습니다.');
    expect(result.outputs).toEqual({ receipt: 'HR-000001' });
    expect(holdLog).toEqual([{ id: 'HR-000001', ...INPUTS }]);
    expect(actions.every((a) => a.by === 'skill')).toBe(true);

    // 새 창으로 옮겨 갔다가, 창이 닫히면 원래 화면으로 돌아온다.
    expect(actions[1].result).toContain('새 창이 열려');
    expect(actions[2].result).toContain('원래 창으로 돌아왔습니다');
    expect(browser.document.title).toContain('Lot 홀드 해제 요청');
    // 승인 요청에는 팝업에서 고른 값이 화면에서 다시 읽혀 들어간다.
    expect(ui.requests).toHaveLength(1);
    expect(ui.requests[0].fields).toContainEqual({ name: 'Lot ID', value: 'P7-00031' });
    expect(actions.at(-2)!.result).toContain('확인 창 "상신하시겠습니까?" → 확인');
    expect(actions.at(-2)!.result).toContain('알림 창: "접수되었습니다. 접수 번호: HR-000001"');
  });

  it('승인하지 않으면 상신하지 않는다', async () => {
    const { result } = await run(holdSkill(), INPUTS, { browser: new JsdomBrowser(), ui: approver(false) });
    expect(result.status).toBe('aborted');
    expect(holdLog).toEqual([]);
  });

  it('시험 실행은 상신 직전에 멈춘다', async () => {
    const browser = new JsdomBrowser();
    const { result } = await run(holdSkill(), INPUTS, { browser, dryRun: true });
    expect(result.status).toBe('dryrun');
    expect(holdLog).toEqual([]);
    expect((browser.document.getElementById('lot') as HTMLInputElement).value).toBe('P7-00031');
  });

  it('목록에 없는 Lot이면 모델이 새 창을 닫고 그만둔다', async () => {
    const browser = new JsdomBrowser();
    const llm = scriptedLlm([
      { tool: 'close_tab', args: {} },
      { tool: 'abort', args: { reason: '목록에 P9-99999가 없습니다' } },
    ]);
    const { result, actions } = await run(holdSkill(), { ...INPUTS, lot: 'P9-99999' }, { browser, llm });

    expect(result.status).toBe('aborted');
    expect(actions.map((a) => `${a.tool}:${a.ok}`)).toEqual(['navigate:true', 'click:true', 'close_tab:true', 'abort:true']);
    expect(browser.document.title).toContain('Lot 홀드 해제 요청');
    expect(holdLog).toEqual([]);
  });

  it('입력값 규칙이 있고 품질 등급은 A다', () => {
    expect(resolveInputs(holdSkill(), { ...INPUTS, reason: '해제' }).errors).toEqual(['해제 사유: 10자 이상 적어야 합니다']);
  });
});

describe('확인 창에 답하는 규칙', () => {
  it('스킬이 요청하지 않은 확인 창은 취소하고 실패로 알린다', async () => {
    const { browser, el } = await filled();
    const { actions } = await run(oneClick('{"ref": "초기화"}'), {}, { browser, llm: giveUp() });

    expect(actions[0].ok).toBe(false);
    expect(actions[0].result).toContain('확인 창 "입력한 내용을 지우시겠습니까?" → 취소');
    expect(actions[0].result).toContain('"accept_dialog": true');
    expect(el('lot').value).toBe('P7-00012');
  });

  it('accept_dialog를 적으면 확인을 누른다', async () => {
    const { browser, el } = await filled();
    const { result, actions } = await run(oneClick('{"ref": "초기화", "accept_dialog": true}'), {}, { browser });

    expect(result.status, result.message).toBe('done');
    expect(actions[0].result).toContain('→ 확인');
    expect(el('lot').value).toBe('');
  });

  it('저장·상신을 묻는 확인 창은 accept_dialog로도 넘기지 않는다', async () => {
    const { browser } = await filled();
    // 이름만으로는 제출 버튼인지 알 수 없는 화면
    browser.document.getElementById('submit')!.textContent = '보내기';
    const { actions } = await run(oneClick('{"ref": "보내기", "accept_dialog": true}'), {}, { browser, llm: giveUp() });

    expect(actions[0].ok).toBe(false);
    expect(actions[0].result).toContain('확인 창 "상신하시겠습니까?" → 취소');
    expect(actions[0].result).toContain('승인받은 제출 단계');
    expect(holdLog).toEqual([]);
  });

  it('알림 창만 뜬 동작은 성공이고 내용이 결과에 남는다', async () => {
    const browser = await JsdomBrowser.open('/hold.html');
    browser.document.getElementById('submit')!.textContent = '보내기';
    const { result, actions } = await run(oneClick('{"ref": "보내기"}'), {}, { browser });

    expect(result.status).toBe('done');
    expect(actions[0].result).toBe('클릭함. 알림 창: "Lot을 선택하세요."');
  });
});

describe('검사 식과 기록 식', () => {
  it('dialog()와 dialog_text()를 읽는다', () => {
    expect(stepCheck('누른다\n   - 검사: did("click") and dialog("접수")')).toEqual([
      { kind: 'did', tool: 'click' },
      { kind: 'dialog', text: '접수' },
    ]);
    expect(stepCaptures('누른다\n   - 기록: no = dialog_text("번호: (\\S+)")')).toEqual([{ name: 'no', pattern: '번호: (\\S+)', from: 'dialog' }]);
    expect(stepCaptures('누른다\n   - 기록: no = page_text("번호")')).toEqual([{ name: 'no', pattern: '번호', from: 'page' }]);
  });

  it('알림 창을 결과 조건으로 쓴 클릭은 경고하지 않는다', () => {
    const source = (check: string) => `---
id: t
name: 시험
description: 검사 규칙 시험용
version: 0.1.0
owner: 시험
risk: R1
domains: [localhost:4173]
---

## 단계

1. click으로 누른다.
   \`{"ref": "조회", "accept_dialog": true}\`
   - 검사: ${check}
2. close_tab으로 새 창을 닫는다.
   \`{}\`
   - 검사: did("close_tab")
3. finish로 보고한다.
   \`{"summary": "끝"}\`

## 예외

- 오류가 나오면 abort한다.
`;
    const rules = (check: string) => lintSkill(source(check)).findings.map((f) => `${f.rule}@${f.step ?? 0}`);
    expect(rules('did("click") and dialog("완료")')).toEqual([]);
    expect(rules('did("click")')).toEqual(['W03@1']);
    expect(lintSkill(source('did("click") and dialog("완료")')).direct).toEqual({ count: 3, total: 3 });
  });
});

describe('알림·확인 창 처리기', () => {
  const page = () => {
    const dom = new JSDOM('<body></body>', { url: 'http://localhost:4173/a.html', runScripts: 'dangerously' });
    const hook = dom.window.eval(`(${dialogHook.toString()})`) as typeof dialogHook;
    return { win: dom.window as any, hook };
  };

  it('켜져 있다는 표시가 있는 탭에서만 화면이 열릴 때 걸린다', () => {
    const { win, hook } = page();
    const original = win.confirm;
    hook({ do: 'boot' });
    expect(win.confirm).toBe(original);

    win.sessionStorage.setItem('__dogent_dialogs_until', String(Date.now() - 1));
    hook({ do: 'boot' });
    expect(win.confirm).toBe(original);

    win.sessionStorage.setItem('__dogent_dialogs_until', String(Date.now() + 60_000));
    hook({ do: 'boot' });
    expect(win.confirm).not.toBe(original);
  });

  it('끄면 원래 함수로 되돌리고 표시를 지운다', () => {
    const { win, hook } = page();
    const original = { alert: win.alert, confirm: win.confirm, prompt: win.prompt };
    hook({ do: 'on', until: Date.now() + 60_000 });
    expect(win.confirm('지울까요?')).toBe(false);
    expect(win.prompt('이름')).toBeNull();
    win.alert('안내');
    expect(hook({ do: 'drain' })).toEqual([
      { kind: 'confirm', message: '지울까요?', accepted: false },
      { kind: 'prompt', message: '이름', accepted: false },
      { kind: 'alert', message: '안내', accepted: true },
    ]);
    expect(hook({ do: 'drain' })).toEqual([]);

    hook({ do: 'off' });
    expect({ alert: win.alert, confirm: win.confirm, prompt: win.prompt }).toEqual(original);
    expect(win.sessionStorage.getItem('__dogent_dialogs_until')).toBeNull();
  });
});
