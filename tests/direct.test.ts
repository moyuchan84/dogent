import { beforeEach, describe, expect, it } from 'vitest';
import { generateWip } from '../mock-site/data.mjs';
import { DatasetStore, resolveInputs, runSkill, type ApprovalRequest, type LlmPort, type RunEvent } from '../src/core';
import {
  JsdomBrowser,
  adjustLog,
  adjustSkill,
  fwLog,
  fwSkill,
  memoryFiles,
  readWorkbook,
  scriptedLlm,
  wipSkill,
} from './helpers';

/** 불리면 실패하는 모델. 모델 없이 끝나야 하는 실행에 쓴다. */
function noLlm(): LlmPort & { calls: number } {
  const llm = {
    calls: 0,
    async complete(): Promise<string> {
      llm.calls++;
      throw new Error('모델이 호출되면 안 됩니다');
    },
  };
  return llm;
}

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

beforeEach(() => {
  fwLog.length = 0;
  adjustLog.length = 0;
});

describe('인자가 적힌 단계의 바로 실행', () => {
  it('재공 확인을 모델 호출 없이 끝까지 수행한다', async () => {
    const llm = noLlm();
    const files = memoryFiles();
    const events: RunEvent[] = [];
    const result = await runSkill(wipSkill(), { line: '7라인', hold_hours: 24 }, {
      llm,
      browser: new JsdomBrowser(),
      ui: approver(true),
      files,
      direct: true,
      onEvent: (e) => events.push(e),
    });

    expect(result.status, result.message).toBe('done');
    expect(llm.calls).toBe(0);
    const want = generateWip('7라인');
    const hold = want.filter((r) => Number(r[5]) >= 24 || r[4] === 'HOLD');
    const steps = new Set(want.map((r) => r[2]));
    // 보고의 숫자는 모델이 센 것이 아니라 데이터셋 행 수에서 채워진다.
    expect(result.message).toBe(
      `총 재공 ${want.length} Lot, 정체 Lot ${hold.length}건, 공정 ${steps.size}개. 파일: 재공확인_7라인.xlsx`,
    );
    const book = await readWorkbook(files.saved.get('재공확인_7라인.xlsx')!);
    expect(book['원본'].slice(1).map((r) => r[0])).toEqual(want.map((r) => r[0]));
    expect(book['정체Lot']).toHaveLength(hold.length + 1);
    const actions = events.flatMap((e) => (e.type === 'action' ? [e.entry] : []));
    expect(actions.every((a) => a.by === 'skill' && a.ok)).toBe(true);
    // 공정은 지정하지 않았으므로 그 단계는 동작 없이 넘어간다.
    expect(actions.map((a) => a.tool)).toEqual([
      'navigate',
      'select',
      'click',
      'extract_table',
      'transform',
      'transform',
      'write_excel',
      'finish',
    ]);
  });

  it('방화벽 신청도 모델 없이 입력하지만 상신 승인은 그대로 받는다', async () => {
    const llm = noLlm();
    const { values } = resolveInputs(fwSkill(), {
      src_ip: '10.10.1.15',
      dst_ip: '10.20.3.7',
      port: '1521',
      period_days: '90',
      reason: '개발 서버에서 "운영 DB" 조회 배치를 실행하기 위함',
    });

    const declined = await runSkill(fwSkill(), values, {
      llm,
      browser: new JsdomBrowser(),
      ui: approver(false),
      files: memoryFiles(),
      direct: true,
    });
    expect(declined.status).toBe('aborted');
    expect(fwLog).toEqual([]);

    const ui = approver(true);
    const result = await runSkill(fwSkill(), values, {
      llm,
      browser: new JsdomBrowser(),
      ui,
      files: memoryFiles(),
      direct: true,
    });
    expect(result.status, result.message).toBe('done');
    expect(result.message).toContain('FW-000001');
    expect(ui.requests).toHaveLength(1);
    expect(fwLog).toHaveLength(1);
    expect(fwLog[0]).toMatchObject({ src: '10.10.1.15', reason: values.reason });
    expect(llm.calls).toBe(0);
  });

  it('엑셀 입력의 시험 실행도 모델 없이 저장 직전까지 간다', async () => {
    const llm = noLlm();
    const datasets = new DatasetStore();
    datasets.set('src', ['Lot ID', '공정', '조정수량', '사유'], [['P7-00012', 'PHOTO', -25, '폐기']]);
    const result = await runSkill(adjustSkill(), { source: 'a.xlsx' }, {
      llm,
      browser: new JsdomBrowser(),
      ui: approver(true),
      files: memoryFiles(),
      datasets,
      direct: true,
      dryRun: true,
    });
    expect(result.status).toBe('dryrun');
    expect(adjustLog).toEqual([]);
    expect(llm.calls).toBe(0);
  });

  it('바로 실행이 실패하면 그 단계는 모델에게 넘긴다', async () => {
    const llm = scriptedLlm([{ tool: 'abort', args: { reason: '9라인은 선택할 수 없는 라인입니다' } }]);
    const events: RunEvent[] = [];
    const result = await runSkill(wipSkill(), { line: '9라인', hold_hours: 24 }, {
      llm,
      browser: new JsdomBrowser(),
      ui: approver(true),
      files: memoryFiles(),
      direct: true,
      onEvent: (e) => events.push(e),
    });
    const actions = events.flatMap((e) => (e.type === 'action' ? [e.entry] : []));
    expect(actions.map((a) => [a.tool, a.by, a.ok])).toEqual([
      ['navigate', 'skill', true],
      ['select', 'skill', false],
      ['abort', 'model', true],
    ]);
    expect(llm.calls).toBe(1);
    expect(result.status).toBe('aborted');
  });

  it('옵션을 주지 않으면 모든 동작을 모델이 정한다', async () => {
    const llm = scriptedLlm([{ tool: 'abort', args: { reason: '끝' } }]);
    await runSkill(wipSkill(), { line: '7라인', hold_hours: 24 }, {
      llm,
      browser: new JsdomBrowser(),
      ui: approver(true),
      files: memoryFiles(),
    });
    expect(llm.calls).toBe(1);
  });
});
