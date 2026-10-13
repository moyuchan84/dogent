import { browser } from 'wxt/browser';
import { defineUnlistedScript } from 'wxt/utils/define-unlisted-script';
import { createPageAgent, type PageAgent } from '@/src/page/agent';

// 사이드 패널이 필요할 때마다 탭의 모든 프레임에 주입한다. 이미 있으면 그대로 둬서 ref를 유지한다.
export default defineUnlistedScript(() => {
  const g = globalThis as typeof globalThis & { __dogent?: PageAgent };
  if (g.__dogent) return;
  // 녹화한 조작은 바로 패널로 보낸다. 페이지가 이동해도 이미 보낸 것은 남는다.
  g.__dogent = createPageAgent(window, (event) => {
    browser.runtime.sendMessage({ dogentRecord: event }).catch(() => {});
  });
});
