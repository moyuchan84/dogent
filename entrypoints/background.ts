import { browser } from 'wxt/browser';
import { defineBackground } from 'wxt/utils/define-background';
import { startBridge } from '@/src/ext/bridge';

export default defineBackground(() => {
  browser.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(console.error);
  // 외부 클라이언트(MCP) 연결. 설정에서 켜야 붙는다.
  startBridge();
});
