/**
 * 배포 단위 설정. 여기 적힌 호스트만 manifest의 host_permissions에 들어가므로,
 * 에이전트가 접근할 수 있는 사이트의 최종 상한선이 된다. 스킬의 domains는 이 안에서만 유효하다.
 */
export const dogentConfig = {
  /** 에이전트가 읽고 조작할 수 있는 사이트. */
  sitePermissions: ['http://localhost:4173/*'],
  /** 모델 API 호스트. */
  llmPermissions: ['http://localhost:4174/*'],
  /** 설정 화면의 초기값. 사용자가 바꾼 값은 브라우저에 저장된다. */
  llmDefaults: {
    baseUrl: 'http://localhost:4174/v1',
    apiKey: '',
    model: 'gemma',
    jsonMode: false,
    timeoutScale: 1,
  },
};
