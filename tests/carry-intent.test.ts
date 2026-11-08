import { describe, expect, it } from 'vitest';
import { carryIntent, officeIntent } from '../src/core';
import { Conversation, CHANNEL_CARRY_MS } from '../client/src/conversation';
import { browserTarget, launchBrowser } from '../client/src/launch-browser';

const turn = (uses?: { office?: boolean; web?: boolean }, at?: string) => ({ request: 'r', skill: 's', status: 'done' as const, summary: '', files: [], datasets: [], uses, at });

describe('앞선 요청의 통로 잇기', () => {
  it('단서 없는 문장은 직전이 오피스였으면 오피스로 잇는다', () => {
    const said = officeIntent('거기 있는 거 봐줘');
    expect(said).toEqual({ excel: false, web: false });
    expect(carryIntent(said, { office: true, web: false })).toEqual({ excel: true, web: false });
    expect(carryIntent(said, { office: true, web: true })).toEqual({ excel: true, web: true });
  });
  it('단서가 있으면 그대로 둔다', () => {
    const said = officeIntent('브라우저에서 MES 열어줘');
    expect(carryIntent(said, { office: true })).toBe(said);
  });
  it('직전이 브라우저뿐이거나 없으면 바꾸지 않는다', () => {
    const said = officeIntent('이거 봐줘');
    expect(carryIntent(said, { web: true })).toBe(said);
    expect(carryIntent(said, undefined)).toBe(said);
  });
  it('오래된 차례는 잇지 않는다', () => {
    const c = new Conversation();
    c.add(turn({ office: true }));
    expect(c.lastUses()).toEqual({ office: true });
    expect(c.lastUses(Date.now() + CHANNEL_CARRY_MS + 1000)).toBeUndefined();
  });
});

describe('브라우저 자동 실행', () => {
  it('꺼져 있으면 띄운다', () => {
    const started: string[] = [];
    expect(launchBrowser('chrome', { platform: 'win32', running: () => false, start: (n) => void started.push(n) })).toBe('started');
    expect(started).toEqual(['chrome']);
  });
  it('이미 떠 있으면 또 열지 않는다', () => {
    const started: string[] = [];
    expect(launchBrowser('edge', { platform: 'win32', running: () => true, start: (n) => void started.push(n) })).toBe('running');
    expect(started).toEqual([]);
  });
  it('엣지 이름과 다른 OS', () => {
    expect(browserTarget('edge').start).toBe('msedge');
    expect(launchBrowser(undefined, { platform: 'linux' })).toBe('unsupported');
  });
});
