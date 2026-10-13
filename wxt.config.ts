import { defineConfig } from 'wxt';
import { dogentConfig } from './dogent.config';

export default defineConfig({
  modules: ['@wxt-dev/module-react'],
  imports: false,
  // 함수로 두어야 .env 파일의 값을 읽은 뒤에 만들어진다.
  manifest: () => {
    // 배포 환경의 모델 API 주소(.env.local의 WXT_LLM_BASE_URL)가 있으면 그 호스트도 허용한다.
    const llmUrl = import.meta.env.WXT_LLM_BASE_URL as string | undefined;
    const llmHost = llmUrl ? [`${new URL(llmUrl).origin}/*`] : [];
    return {
      name: 'Dogent',
      description: '스킬(업무 절차서)을 따라 사내 웹 시스템을 조작하는 업무 에이전트',
      permissions: ['sidePanel', 'scripting', 'storage', 'tabs', 'downloads'],
      host_permissions: [...new Set([...dogentConfig.sitePermissions, ...dogentConfig.llmPermissions, ...llmHost])],
      action: { default_title: 'Dogent 열기' },
    };
  },
});
