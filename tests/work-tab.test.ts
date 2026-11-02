import { describe, expect, it } from 'vitest';
import { chooseWorkTab } from '../src/core';

const MES = 'http://mes.local/wip';
const tab = (id: number, url: string, current = false, allowed = true) => ({ id, url, current, allowed });

describe('일할 탭 고르기 (chooseWorkTab) — 요청마다 새 탭을 열지 않는다', () => {
  it('주소를 모르면 지금 탭에서 한다', () => {
    expect(chooseWorkTab([tab(1, 'http://mes.local/a', true)], { url: null })).toEqual({ kind: 'use', id: 1, why: 'current' });
  });

  it('지금 탭이 조작할 사이트 목록 밖이면 할 탭이 없다', () => {
    expect(chooseWorkTab([tab(1, 'https://news.example/', true, false)], { url: null })).toEqual({ kind: 'none' });
  });

  it('지금 탭이 그 사이트면 새 탭 없이 그대로 쓴다', () => {
    expect(chooseWorkTab([tab(1, 'http://mes.local/hold', true)], { url: MES })).toEqual({ kind: 'use', id: 1, why: 'current' });
  });

  it('다른 탭이 그 화면을 보여 주고 있으면 그 탭을 쓴다', () => {
    const tabs = [tab(1, 'https://mail.example/', true), tab(2, 'http://mes.local/wip#top')];
    expect(chooseWorkTab(tabs, { url: MES })).toEqual({ kind: 'use', id: 2, why: 'open' });
  });

  it('요청에 쓴 주소(exact)는 사용자가 보던 같은 사이트의 다른 화면을 바꾸지 않는다', () => {
    expect(chooseWorkTab([tab(1, 'http://mes.local/hold', true)], { url: MES, exact: true })).toEqual({ kind: 'open', url: MES });
    // Dogent가 연 탭이면 그 탭을 그 주소로 옮긴다
    expect(chooseWorkTab([tab(1, 'http://mes.local/hold', true), tab(5, 'http://mes.local/a')], { url: MES, exact: true }, 5)).toEqual({ kind: 'navigate', id: 5, url: MES, why: 'work' });
    // 그 주소를 이미 보여 주면 그대로
    expect(chooseWorkTab([tab(1, MES, true)], { url: MES, exact: true })).toEqual({ kind: 'use', id: 1, why: 'current' });
  });

  it('스킬의 사이트 기준(covers)으로 탭을 찾는다', () => {
    const tabs = [tab(1, 'https://mail.example/', true), tab(2, 'http://mes2.local/x')];
    const covers = (u: string) => /mes2?\.local/.test(u);
    expect(chooseWorkTab(tabs, { url: MES, covers })).toEqual({ kind: 'use', id: 2, why: 'open' });
  });

  it('그 사이트 탭이 없으면 Dogent가 앞서 연 탭을 그 주소로 옮긴다 (사용자 탭은 다른 사이트로 옮기지 않는다)', () => {
    const tabs = [tab(1, 'https://mail.example/', true), tab(7, 'http://erp.local/')];
    expect(chooseWorkTab(tabs, { url: MES }, 7)).toEqual({ kind: 'navigate', id: 7, url: MES, why: 'work' });
  });

  it('쓸 탭이 없을 때만 새 탭을 연다', () => {
    expect(chooseWorkTab([tab(1, 'https://mail.example/', true)], { url: MES })).toEqual({ kind: 'open', url: MES });
    // 앞서 연 탭을 사용자가 닫았으면 새로 연다
    expect(chooseWorkTab([tab(1, 'https://mail.example/', true)], { url: MES }, 7)).toEqual({ kind: 'open', url: MES });
  });

  it('같은 사이트 탭이 여럿이면 지금 탭 > Dogent 탭 > 다른 탭 순', () => {
    const tabs = [tab(1, 'http://mes.local/a'), tab(2, 'http://mes.local/b'), tab(3, 'https://mail.example/', true)];
    expect(chooseWorkTab(tabs, { url: MES }, 2)).toEqual({ kind: 'use', id: 2, why: 'work' });
  });

  it('조작할 사이트 목록 밖의 탭은 고르지 않는다', () => {
    expect(chooseWorkTab([tab(1, 'http://mes.local/wip', true, false)], { url: MES })).toEqual({ kind: 'open', url: MES });
  });
});
