import { defineUnlistedScript } from 'wxt/utils/define-unlisted-script';
import { dialogHook } from '@/src/page/dialogs';

// 에이전트가 실행 중일 때만 등록되어, 화면이 열리는 순간(document_start) main world에서 돈다.
// 에이전트가 조작 중인 탭이라는 표시가 있을 때만 알림·확인 창을 대신 받는다.
export default defineUnlistedScript(() => {
  dialogHook({ do: 'boot' });
});
