import { beforeEach, describe, expect, it } from 'vitest';
import { resolveInputs, runSkill, type ApprovalRequest, type RunEvent, type SkillInputs } from '../src/core';
import { JsdomBrowser, fwLog, fwSkill, memoryFiles, mockLlm, scriptedLlm } from './helpers';

const RAW = {
  src_ip: '10.10.1.15',
  dst_ip: '10.20.3.7',
  port: '1521',
  period_days: '90',
  reason: '개발 서버에서 운영 DB 조회 배치를 실행하기 위함',
};

function inputs(overrides: Record<string, unknown> = {}): SkillInputs {
  const { values, errors } = resolveInputs(fwSkill(), { ...RAW, ...overrides });
  expect(errors).toEqual([]);
  return values;
}

/** 승인 요청을 기록하고 정해진 답을 돌려주는 UI */
function approver(answer: boolean) {
  const requests: ApprovalRequest[] = [];
  return {
    requests,
    ask: async () => '',
    approve: async (r: ApprovalRequest) => {
      requests.push(r);
      return answer;
    },
  };
}

const step = (tool: string, args: object = {}) => ({ tool, args });

beforeEach(() => {
  fwLog.length = 0;
});

describe('입력값 검증', () => {
  it('형식이 틀리면 폼 단계에서 걸러진다', () => {
    const errors = (o: Record<string, unknown>) => resolveInputs(fwSkill(), { ...RAW, ...o }).errors;
    expect(errors({ src_ip: '10.10.1' })[0]).toContain('IPv4');
    expect(errors({ src_ip: '10.10.1.300' })[0]).toContain('IPv4');
    expect(errors({ port: '70000' })[0]).toContain('포트');
    expect(errors({ port: 'any' })[0]).toContain('포트');
    expect(errors({ protocol: 'ICMP' })[0]).toContain('TCP, UDP');
    expect(errors({ reason: '' })).toEqual(['사유: 필수 입력입니다']);
    expect(errors({ port: '8000-8010', protocol: 'UDP' })).toEqual([]);
  });

  it('정책 규칙을 적용한다', () => {
    const errors = (o: Record<string, unknown>) => resolveInputs(fwSkill(), { ...RAW, ...o }).errors;
    expect(errors({ src_ip: '10.10.0.0/16' })).toEqual(['출발지 IP: /24보다 넓은 대역(10.10.0.0/16)은 신청할 수 없습니다']);
    expect(errors({ dst_ip: '10.20.3.0/24' })).toEqual([]);
    expect(errors({ dst_ip: '0.0.0.0' })[0]).toContain('허용되지 않는 값');
    expect(errors({ port: '1-65535' })[0]).toContain('허용되지 않는 값');
    expect(errors({ period_days: '400' })).toEqual(['기간(일): 365 이하여야 합니다']);
    expect(errors({ reason: '테스트' })).toEqual(['사유: 10자 이상 적어야 합니다']);
  });

  it('검증을 건너뛰고 실행해도 화면에 접속하기 전에 멈춘다', async () => {
    const llm = scriptedLlm([step('abort', { reason: 'x' })]);
    const browser = new JsdomBrowser();
    const result = await runSkill(
      fwSkill(),
      { ...inputs(), src_ip: '10.0.0.0/8' },
      { llm, browser, ui: approver(true), files: memoryFiles() },
    );
    expect(result.status).toBe('aborted');
    expect(result.message).toContain('/24보다 넓은 대역');
    expect(llm.calls).toBe(0);
    expect(browser.dom.window.location.href).toBe('https://start.example/');
    expect(fwLog).toEqual([]);
  });
});

describe('방화벽 해제 신청 (모의 화면 + 모의 모델)', () => {
  it('승인하면 입력값 그대로 한 번만 상신한다', async () => {
    const ui = approver(true);
    const events: RunEvent[] = [];
    const result = await runSkill(fwSkill(), inputs(), {
      llm: mockLlm,
      browser: new JsdomBrowser(),
      ui,
      files: memoryFiles(),
      onEvent: (e) => events.push(e),
    });

    expect(result.status, result.message).toBe('done');
    expect(result.message).toContain('FW-000001');
    expect(fwLog).toEqual([
      {
        id: 'FW-000001',
        src: '10.10.1.15',
        dst: '10.20.3.7',
        port: '1521',
        protocol: 'TCP',
        days: '90',
        reason: RAW.reason,
      },
    ]);
    // 승인 요청에는 화면에서 다시 읽은 값이 담긴다.
    expect(ui.requests).toHaveLength(1);
    expect(ui.requests[0].button).toBe('상신');
    expect(Object.fromEntries(ui.requests[0].fields.map((f) => [f.name, f.value]))).toEqual({
      '출발지 IP': '10.10.1.15',
      '목적지 IP': '10.20.3.7',
      포트: '1521',
      프로토콜: 'TCP',
      '기간(일)': '90',
      사유: RAW.reason,
    });
    expect(events.filter((e) => e.type === 'approval')).toMatchObject([{ approved: true, dryRun: false }]);
  });

  it('UDP, 따옴표와 줄바꿈이 있는 사유도 그대로 들어간다', async () => {
    const reason = '운영 DB "점검"용 임시 허용\n담당: 인프라운영';
    const result = await runSkill(fwSkill(), inputs({ protocol: 'UDP', reason }), {
      llm: mockLlm,
      browser: new JsdomBrowser(),
      ui: approver(true),
      files: memoryFiles(),
    });
    expect(result.status, result.message).toBe('done');
    expect(fwLog).toHaveLength(1);
    expect(fwLog[0]).toMatchObject({ protocol: 'UDP', reason });
  });

  it('승인하지 않으면 상신하지 않는다', async () => {
    const browser = new JsdomBrowser();
    const result = await runSkill(fwSkill(), inputs(), {
      llm: mockLlm,
      browser,
      ui: approver(false),
      files: memoryFiles(),
    });
    expect(result.status).toBe('aborted');
    expect(result.message).toContain('승인하지 않았습니다');
    expect(fwLog).toEqual([]);
    expect((browser.document.getElementById('src') as HTMLInputElement).value).toBe('10.10.1.15');
  });

  it('시험 실행은 승인을 묻지 않고 상신 직전에 멈춘다', async () => {
    const ui = approver(true);
    const result = await runSkill(fwSkill(), inputs(), {
      llm: mockLlm,
      browser: new JsdomBrowser(),
      ui,
      files: memoryFiles(),
      dryRun: true,
    });
    expect(result.status).toBe('dryrun');
    expect(result.lastStep).toBe(8);
    expect(ui.requests).toEqual([]);
    expect(fwLog).toEqual([]);
  });
});

describe('상신 통제', () => {
  // 2~7단계의 입력을 스킬에 적힌 그대로 수행한다.
  const fill = [
    step('type', { ref: '출발지 IP', text: '10.10.1.15' }),
    step('type', { ref: '목적지 IP', text: '10.20.3.7' }),
    step('type', { ref: '포트', text: '1521' }),
    step('type', { ref: '기간(일)', text: '90' }),
    step('type', { ref: '사유', text: RAW.reason }),
  ];

  async function run(replies: object[]) {
    const ui = approver(true);
    const events: RunEvent[] = [];
    const result = await runSkill(fwSkill(), inputs(), {
      llm: scriptedLlm([...replies, step('abort', { reason: '끝' })]),
      browser: await JsdomBrowser.open('/fw.html'),
      ui,
      files: memoryFiles(),
      onEvent: (e) => events.push(e),
    });
    const actions = events.flatMap((e) => (e.type === 'action' ? [e.entry] : []));
    return { result, ui, actions };
  }

  it('상신 단계가 아닐 때는 상신 버튼을 누를 수 없다', async () => {
    const { ui, actions } = await run([step('click', { ref: '상신' })]);
    expect(actions[0]).toMatchObject({ step: 2, ok: false });
    expect(actions[0].result).toContain('8단계에서만');
    expect(ui.requests).toEqual([]);
    expect(fwLog).toEqual([]);
  });

  it('상신 단계에서도 스킬이 선언하지 않은 버튼은 누를 수 없다', async () => {
    const { ui, actions } = await run([...fill, step('click', { ref: '임시 저장' })]);
    const last = actions.at(-2)!;
    expect(last).toMatchObject({ step: 8, tool: 'click', ok: false });
    expect(last.result).toContain('누를 수 있는 버튼(상신)이 아닙니다');
    expect(ui.requests).toEqual([]);
  });

  it('확인이 끝난 값을 나중에 바꾸면 상신 전 대조에서 걸린다', async () => {
    const { ui, actions } = await run([
      ...fill,
      step('type', { ref: '목적지 IP', text: '10.99.99.99' }),
      step('click', { ref: '상신' }),
    ]);
    const click = actions.at(-2)!;
    expect(click).toMatchObject({ step: 8, tool: 'click', ok: false });
    expect(click.result).toContain('제출 전 대조 실패');
    expect(click.result).toContain('"목적지 IP"의 값이 "10.20.3.7"이어야 함 (현재 "10.99.99.99")');
    expect(ui.requests).toEqual([]);
    expect(fwLog).toEqual([]);
  });

  it('조회 전용 스킬은 어느 단계에서도 상신 버튼을 누를 수 없다', async () => {
    const ui = approver(true);
    const events: RunEvent[] = [];
    await runSkill({ ...fwSkill(), risk: 'R1' }, inputs(), {
      llm: scriptedLlm([...fill, step('click', { ref: '상신' }), step('abort', { reason: '끝' })]),
      browser: await JsdomBrowser.open('/fw.html'),
      ui,
      files: memoryFiles(),
      onEvent: (e) => events.push(e),
    });
    expect(events.filter((e) => e.type === 'blocked')).toHaveLength(1);
    expect(ui.requests).toEqual([]);
    expect(fwLog).toEqual([]);
  });
});
