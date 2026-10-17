import { describe, expect, it } from 'vitest';
import { createArgs, parseSpec, scriptText } from '../client/src/schedule';

const spec = { name: '아침 재공', at: '09:00', days: [] as string[], skill: 'wip-check', inputs: ['line=7라인'] };

describe('예약 실행', () => {
  it('요일이 없으면 매일, 있으면 주간으로 등록한다', () => {
    expect(createArgs(spec, 'C:\\s.cmd')).toEqual(expect.arrayContaining(['/SC', 'DAILY', '/ST', '09:00', '/TN', 'Dogent\\아침_재공']));
    expect(createArgs({ ...spec, days: ['월', '금'] }, 'C:\\s.cmd')).toEqual(expect.arrayContaining(['/SC', 'WEEKLY', '/D', 'MON,FRI']));
  });

  it('시각과 요일 형식이 틀리면 거절한다', () => {
    expect(() => createArgs({ ...spec, at: '9시' }, 'x')).toThrow('HH:MM');
    expect(() => createArgs({ ...spec, days: ['월요일'] }, 'x')).toThrow('요일');
  });

  it('작업이 부를 파일은 UTF-8로 스킬을 --yes로 실행하고, 저장·상신 허용은 넣지 않는다', () => {
    const text = scriptText(spec, 'C:\\node.exe', 'C:\\dogent.mjs');
    expect(text).toContain('chcp 65001');
    expect(text).toContain('"C:\\node.exe" "C:\\dogent.mjs" run "wip-check" "line=7라인" --yes');
    expect(text).not.toContain('--allow-write');
  });

  it('명령줄을 읽는다', () => {
    expect(parseSpec(['아침', '--at', '08:30', '--days', '월,수', 'wip-check', 'line=7라인'])).toEqual({
      name: '아침', at: '08:30', days: ['월', '수'], skill: 'wip-check', inputs: ['line=7라인'],
    });
    expect(() => parseSpec(['아침', 'wip-check'])).toThrow('사용법');
  });
});
