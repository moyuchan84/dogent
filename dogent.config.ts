/**
 * 배포 단위 설정. 여기 적힌 호스트만 manifest의 host_permissions에 들어가므로,
 * 에이전트가 접근할 수 있는 사이트의 최종 상한선이 된다. 스킬의 domains는 이 안에서만 유효하다.
 */
/**
 * 빌드 환경 파일(.env.company.local 등)의 WXT_SITE_PERMISSIONS. 쉼표로 여러 개.
 * 사내 시스템 주소는 저장소에 올리지 않도록 이 파일이 아니라 환경 파일에 적는다.
 */
const extraSites = ((import.meta.env?.WXT_SITE_PERMISSIONS as string | undefined) ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

export const dogentConfig = {
  /** 에이전트가 읽고 조작할 수 있는 사이트. 모의 사이트는 어느 빌드에서나 연습용으로 남긴다. */
  sitePermissions: [...new Set(['http://localhost:4173/*', ...extraSites])],
  /** 모델 API 호스트. */
  llmPermissions: ['http://localhost:4174/*'],
  /** 설정 화면의 초기값. 사용자가 바꾼 값은 브라우저에 저장된다. */
  llmDefaults: {
    baseUrl: 'http://localhost:4174/v1',
    apiKey: '',
    model: 'gemma',
    jsonMode: false,
    timeoutScale: 1,
    skillDirect: true,
    pathCache: true,
    // 공유 스킬 저장소. 배포할 때는 .env.local의 WXT_SKILLS_URL에 적는다.
    skillsUrl: '',
    // 사내 게이트웨이의 Send-System-Name. 환경 파일의 WXT_LLM_SYSTEM_NAME이나 설정 화면에서 바꾼다.
    systemName: 'RFGo',
  },
};
