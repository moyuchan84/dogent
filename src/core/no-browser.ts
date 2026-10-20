import type { ActResult, BrowserPort, PageSnapshot } from './types';

const NONE = '이번 실행에는 브라우저 화면이 없습니다. 엑셀 도구만 쓸 수 있습니다';
const fail = async (): Promise<ActResult> => ({ ok: false, message: NONE });

/**
 * 브라우저 없이 엑셀 도구만으로 하는 실행에 쓰는 빈 화면. 화면은 늘 비어 있고 화면 동작은 모두 실패한다.
 * 엑셀만 다루는 요청이 브라우저 확장 연결을 기다리지 않게 한다.
 */
export function noBrowser(): BrowserPort {
  const snap: PageSnapshot = { url: '', title: '(브라우저 없음)', hasPassword: false, items: [] };
  return {
    snapshot: async () => snap,
    navigate: fail,
    click: fail,
    type: fail,
    select: fail,
    waitFor: async () => false,
    extractTable: async () => {
      throw new Error(NONE);
    },
    fillTable: fail,
  };
}
