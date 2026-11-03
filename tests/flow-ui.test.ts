import { describe, expect, it } from 'vitest';
import { PLACEHOLDER, describeRun, infoProblem, isRunOk, runLine, suggestId } from '../entrypoints/sidepanel/flow-ui';
import type { FlowMeta, RunResult } from '../src/core';

const meta = (over: Partial<FlowMeta> = {}): FlowMeta => ({
  id: 'wip-check',
  name: '재공 확인',
  description: '재공을 조회한다',
  version: '0.1.0',
  owner: '생산관리',
  risk: 'R1',
  domains: ['localhost:4173'],
  tags: [],
  inputs: [],
  submit_steps: [],
  submit_labels: [],
  scripts: [],
  limits: {},
  ...over,
});

const result = (over: Partial<RunResult>): RunResult => ({ status: 'done', message: '끝', lastStep: 3, actions: 3, files: [], datasets: [], outputs: {}, elapsedMs: 1, ...over });

describe('스킬 정보', () => {
  it('저장하기 전에 아직 정하지 않은 항목을 알려 준다', () => {
    expect(infoProblem(meta())).toBeNull();
    expect(infoProblem(meta({ id: PLACEHOLDER.id }))).toContain('스킬 ID');
    expect(infoProblem(meta({ id: 'Bad Id' }))).toContain('스킬 ID');
    expect(infoProblem(meta({ name: PLACEHOLDER.name }))).toContain('이름');
    expect(infoProblem(meta({ description: PLACEHOLDER.description }))).toContain('무엇을');
    expect(infoProblem(meta({ owner: PLACEHOLDER.owner }))).toContain('담당 부서');
  });

  it('이름에서 ID를 제안한다 (영문·숫자가 없으면 제안하지 않음)', () => {
    expect(suggestId('WIP Check 2')).toBe('wip-check-2');
    expect(suggestId('재공 확인')).toBe('');
    expect(suggestId('9 lines')).toBe('lines');
  });
});

describe('시험 결과', () => {
  it('성공·실패를 모델이 읽을 문장과 카드의 한 줄로 만든다', () => {
    expect(isRunOk(result({}))).toBe(true);
    expect(isRunOk(result({ status: 'dryrun' }))).toBe(true);
    expect(isRunOk(result({ status: 'error' }))).toBe(false);
    const text = describeRun(2, result({ status: 'error', message: '"조회" 버튼을 찾지 못했습니다', lastStep: 3 }));
    expect(text).toContain('1번부터 3번 단계까지 시험 실행: 실패');
    expect(text).toContain('"조회" 버튼을 찾지 못했습니다');
    expect(runLine(result({ status: 'dryrun' }))).toContain('저장·상신 직전');
  });
});
