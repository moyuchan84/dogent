import { defineConfig } from 'wxt';
import { dogentConfig } from './dogent.config';

export default defineConfig({
  modules: ['@wxt-dev/module-react'],
  imports: false,
  manifest: {
    name: 'Dogent',
    description: '스킬(업무 절차서)을 따라 사내 웹 시스템을 조작하는 업무 에이전트',
    permissions: ['sidePanel', 'scripting', 'storage', 'tabs'],
    host_permissions: [...dogentConfig.sitePermissions, ...dogentConfig.llmPermissions],
    action: { default_title: 'Dogent 열기' },
  },
});
