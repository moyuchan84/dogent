import { browser } from 'wxt/browser';

export function download(filename: string, data: BlobPart, type: string) {
  const url = URL.createObjectURL(new Blob([data], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** 테스트에서는 ?tabId= 로 대상 탭을 지정한다. 평소에는 현재 창의 활성 탭. */
export async function targetTab(): Promise<{ id: number; url: string }> {
  const forced = new URLSearchParams(location.search).get('tabId');
  const tab = forced
    ? await browser.tabs.get(Number(forced))
    : (await browser.tabs.query({ active: true, currentWindow: true }))[0];
  if (tab?.id === undefined) throw new Error('대상 탭을 찾을 수 없습니다');
  return { id: tab.id, url: tab.url ?? '' };
}
