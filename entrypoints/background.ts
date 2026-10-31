import { browser } from 'wxt/browser';
import { defineBackground } from 'wxt/utils/define-background';
import { startBridge } from '@/src/ext/bridge';
import { watchForUpdate } from '@/src/ext/self-update';

export default defineBackground(() => {
  browser.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(console.error);
  // 외부 클라이언트(MCP) 연결. 설정에서 켜야 붙는다.
  startBridge();
  // 설치 프로그램이 폴더를 새 판으로 덮어쓰면 스스로 다시 읽는다 (확장을 지웠다 다시 로드하지 않아도 된다)
  watchForUpdate();
});
