import { describe, expect, it } from 'vitest';
import { batchReport, batchSummary, planBatch, stopsBatch, type BatchOutcome, type RunResult } from '../src/core';
import { adjustSkill, fwSkill } from './helpers';

const run = (status: RunResult['status'], more: Partial<RunResult> = {}): BatchOutcome['result'] => ({ status, message: status, outputs: {}, ...more });

describe('묶어 실행하기: 엑셀 행 → 입력값', () => {
  it('컬럼은 입력 이름이나 라벨로 붙고, 엑셀에 없는 입력은 화면의 값을 쓴다', () => {
    const plan = planBatch(
      fwSkill(),
      {
        columns: ['출발지 IP', 'dst_ip', '포트', '비고'],
        rows: [
          ['10.10.1.15', '10.20.3.7', 1521, '첫 번째'],
          ['', '', '', ''],
          ['10.10.1.16', '10.20.3.8', '8080-8081', ''],
        ],
      },
      { period_days: '30', reason: '배치 서버 이전에 따른 접근 허용', port: '22' },
    );
    expect(plan.mapped).toEqual({ '출발지 IP': 'src_ip', dst_ip: 'dst_ip', 포트: 'port' });
    expect(plan.ignored).toEqual(['비고']);
    expect(plan.common).toEqual(['period_days', 'reason']);
    // 빈 행은 건너뛰고, 행 번호는 엑셀 기준(머리글이 1행)이다.
    expect(plan.rows.map((r) => [r.line, r.errors])).toEqual([
      [2, []],
      [4, []],
    ]);
    expect(plan.rows[0].values).toEqual({
      src_ip: '10.10.1.15',
      dst_ip: '10.20.3.7',
      port: '1521',
      protocol: 'TCP',
      period_days: 30,
      reason: '배치 서버 이전에 따른 접근 허용',
    });
    expect(plan.rows[1].values.port).toBe('8080-8081');
  });

  it('입력 형식과 policy.yaml 규칙은 실행 전에 행마다 검사한다', () => {
    const plan = planBatch(
      fwSkill(),
      {
        columns: ['src_ip', 'dst_ip', 'port', 'period_days', 'reason'],
        rows: [
          ['10.10.1.15', '10.20.3.7', 1521, 30, '개발 서버에서 운영 DB 조회 배치 실행'],
          ['10.0.0.0/8', '10.20.3.7', 1521, 30, '개발 서버에서 운영 DB 조회 배치 실행'],
          ['10.10.1.15', '10.20.3.7', 70000, 30, '개발 서버에서 운영 DB 조회 배치 실행'],
          ['10.10.1.15', '', 1521, 30, '개발 서버에서 운영 DB 조회 배치 실행'],
        ],
      },
      {},
    );
    expect(plan.rows[0].errors).toEqual([]);
    expect(plan.rows[1].errors.join()).toMatch(/넓은 대역/);
    expect(plan.rows[2].errors.join()).toMatch(/포트/);
    expect(plan.rows[3].errors.join()).toMatch(/목적지 IP: 필수/);
  });

  it('붙는 컬럼이 없거나 파일 입력 스킬이면 이유를 알린다', () => {
    expect(() => planBatch(fwSkill(), { columns: ['가', '나'], rows: [['1', '2']] }, {})).toThrow(/출발지 IP\(src_ip\)/);
    expect(() => planBatch(fwSkill(), { columns: ['src_ip'], rows: [['']] }, {})).toThrow('실행할 행이 없습니다');
    expect(() => planBatch(adjustSkill(), { columns: ['source'], rows: [['a.xlsx']] }, {})).toThrow('파일을 입력으로 받는');
    expect(() => planBatch(fwSkill(), { columns: ['src_ip'], rows: Array.from({ length: 201 }, () => ['10.1.1.1']) }, {})).toThrow('200건까지');
  });
});

describe('묶어 실행하기: 결과', () => {
  const plan = planBatch(
    fwSkill(),
    { columns: ['src_ip'], rows: [['10.10.1.1'], ['10.10.1.2'], ['10.0.0.0/8'], ['10.10.1.4'], ['10.10.1.5']] },
    { dst_ip: '10.20.3.7', port: '1521', period_days: '30', reason: '개발 서버에서 운영 DB 조회 배치 실행' },
  );
  const outcomes: BatchOutcome[] = [
    { row: plan.rows[0], result: run('done', { outputs: { request_id: 'FW-000001' } }) },
    { row: plan.rows[1], result: run('aborted', { message: '화면에 오류', outputs: {} }) },
    { row: plan.rows[2] },
    { row: plan.rows[3], result: run('aborted', { cause: 'user', message: '사용자가 승인하지 않았습니다' }) },
    { row: plan.rows[4] },
  ];

  it('행마다 입력값, 결과, 메시지, 기록한 값을 한 표로 만든다', () => {
    const report = batchReport(fwSkill(), outcomes);
    expect(report.columns).toEqual(['행', '출발지 IP', '목적지 IP', '포트', '프로토콜', '기간(일)', '사유', '결과', '메시지', 'request_id']);
    expect(report.rows.map((r) => [r[0], r[1], r[7], r[9]])).toEqual([
      [2, '10.10.1.1', '완료', 'FW-000001'],
      [3, '10.10.1.2', '중단', ''],
      [4, '10.0.0.0/8', '입력 오류', ''],
      [5, '10.10.1.4', '사용자가 멈춤·승인 안 함', ''],
      [6, '10.10.1.5', '실행 안 함', ''],
    ]);
    expect(report.rows[2][8]).toMatch(/넓은 대역/);
    expect(report.rows[4][8]).toBe('앞에서 멈춰 실행하지 않았습니다');
  });

  it('요약은 승인하지 않은 행과 돌리지 않은 행을 실패와 나눠 센다', () => {
    expect(batchSummary(outcomes)).toEqual({ ok: 1, fail: 1, skipped: 2, invalid: 1 });
  });

  it('사람이 멈췄거나 로그인이 풀리면 남은 행을 돌리지 않는다', () => {
    expect(stopsBatch({ status: 'stopped' })).toBe(true);
    expect(stopsBatch({ status: 'aborted', cause: 'login' })).toBe(true);
    expect(stopsBatch({ status: 'aborted', cause: 'user' })).toBe(false);
    expect(stopsBatch({ status: 'aborted' })).toBe(false);
  });
});
