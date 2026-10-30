import { describe, expect, it } from 'vitest';
import { buildFreeSkill, checkAction, findInSnapshot, hostAllowed, parseAction, type Action } from '../src/core';
import { JsdomBrowser } from './helpers';

const PAGE = 'http://localhost:4173/wip.html';

describe('모든 사이트 (domains "*")', () => {
  it('"*"는 모든 http·https 주소를 허용하고, 그 밖의 주소는 허용하지 않는다', () => {
    expect(hostAllowed('https://anything.example.com/a', ['*'])).toBe(true);
    expect(hostAllowed('http://10.1.2.3:8080/', ['*'])).toBe(true);
    expect(hostAllowed('chrome://extensions/', ['*'])).toBe(false);
  });

  it('anySite 자유 요청은 허용 도메인이 "*"다', () => {
    expect(buildFreeSkill(PAGE, false, undefined, false, false, [], true).domains).toEqual(['*']);
    expect(buildFreeSkill(PAGE, false).domains).toEqual(['localhost:4173']);
  });
});

describe('기본 화면 도구 (find, press_key, scroll)', () => {
  it('find는 말에 맞는 요소만 ref와 함께 보여 준다', async () => {
    const browser = await JsdomBrowser.open('/wip.html');
    const snap = await browser.snapshot();
    const out = findInSnapshot(snap, '조회');
    expect(out).toMatch(/^"조회"에 맞는 요소 \d+개/);
    expect(out).toMatch(/\[\d+\] button "조회"/);
    expect(findInSnapshot(snap, '없는말xyz')).toContain('맞는 요소가 화면에 없습니다');
  });

  it('press_key는 그 요소에 keydown·keyup을 보낸다', async () => {
    const browser = await JsdomBrowser.open('/wip.html');
    const snap = await browser.snapshot();
    const box = snap.items.find((i) => i.kind === 'el' && (i.role === 'textbox' || i.role === 'combobox'));
    expect(box).toBeDefined();
    const seen: string[] = [];
    for (const t of ['keydown', 'keypress', 'keyup']) browser.document.addEventListener(t, (e) => seen.push(`${t}:${(e as KeyboardEvent).key}`));
    const r = await browser.pressKey('Enter', (box as { ref: number }).ref);
    expect(r.ok, r.message).toBe(true);
    expect(seen).toEqual(['keydown:Enter', 'keypress:Enter', 'keyup:Enter']);
  });

  it('scroll은 화면을 내리거나, 내릴 곳이 없으면 그렇게 알린다', async () => {
    const browser = await JsdomBrowser.open('/wip.html');
    const r = await browser.scroll(undefined, 'down');
    expect(r.ok, r.message).toBe(true);
  });

  it('press_key와 scroll도 허용 도메인 밖의 화면이나 없는 ref에는 하지 않는다', async () => {
    const browser = await JsdomBrowser.open('/wip.html');
    const snap = await browser.snapshot();
    const skill = buildFreeSkill(PAGE, false);
    const act = (tool: string, args: object) => {
      const p = parseAction(JSON.stringify({ thought: '', tool, args }), snap);
      if (!p.ok) throw new Error(p.error);
      return p.action as Action;
    };
    expect(checkAction(act('press_key', { key: 'Enter' }), snap, skill).ok).toBe(true);
    expect(checkAction(act('press_key', { key: 'Enter', ref: 9999 }), snap, skill).ok).toBe(false);
    expect(checkAction(act('scroll', {}), { ...snap, url: 'https://other.example.com/' }, skill).ok).toBe(false);
  });
});
