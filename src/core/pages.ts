import { findElement } from './policy';
import type { BrowserPort, ElementItem, PageSnapshot, TableData } from './types';

/** 한 번에 넘길 수 있는 최대 페이지 수 */
export const MAX_PAGES = 500;

/**
 * 표를 읽고, 다음 페이지 버튼이 비활성이 되거나 사라질 때까지 눌러 가며 페이지마다 읽는다.
 * 판단이 필요 없는 반복이라 모델을 거치지 않는다. ref는 화면이 바뀌면 새로 매겨지므로
 * 표와 버튼을 처음 화면의 역할·이름으로 다시 찾는다.
 * onPage는 페이지마다 불린다 (첫 페이지는 first가 true). 읽은 페이지 수를 돌려준다.
 */
export async function extractPages(
  browser: BrowserPort,
  snap: PageSnapshot,
  ref: number,
  nextRef: number | undefined,
  onPage: (table: TableData, first: boolean) => void,
): Promise<number> {
  onPage(await browser.extractTable(ref), true);
  if (nextRef === undefined) return 1;
  const tableEl = findElement(snap, ref);
  const nextEl = findElement(snap, nextRef);
  if (!tableEl || !nextEl) throw new Error('표나 다음 페이지 버튼을 화면에서 찾지 못했습니다');
  const again = (s: PageSnapshot, like: ElementItem) =>
    s.items.find((i): i is ElementItem => i.kind === 'el' && i.role === like.role && i.name === like.name);
  let pages = 1;
  for (let s = snap; pages < MAX_PAGES; pages++) {
    const next = again(s, nextEl);
    if (!next || next.disabled) break;
    const clicked = await browser.click(next.ref);
    if (!clicked.ok) throw new Error(`"${nextEl.name}" 클릭 실패: ${clicked.message}`);
    s = await browser.snapshot();
    const t = again(s, tableEl);
    if (!t) throw new Error(`${pages + 1}페이지에서 표 "${tableEl.name}"을(를) 찾지 못했습니다`);
    onPage(await browser.extractTable(t.ref), false);
  }
  return pages;
}
