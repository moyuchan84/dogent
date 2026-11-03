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

/**
 * 모든 http·https 사이트에 접근 권한을 선언할지.
 *   - 기본은 모든 빌드(회사 포함)가 모든 사이트. 접근하면 안 되는 URL은 사내 방화벽센터가 이미 막고 있어서
 *     확장에서 따로 사이트를 관리하지 않는다.
 *   - 보안 검토 등으로 목록 방식(WXT_SITE_PERMISSIONS의 사이트 + 패널의 "이 사이트 허용")이 필요하면
 *     빌드 환경 파일에 WXT_ALL_SITES=false 를 적는다.
 */
export function allSitesFor(_mode: string | undefined, raw: string | undefined): boolean {
  const v = (raw ?? '').trim();
  if (v) return !/^(0|false|no|off)$/i.test(v);
  return true;
}
export const allSites = allSitesFor(import.meta.env?.MODE as string | undefined, import.meta.env?.WXT_ALL_SITES as string | undefined);

export const dogentConfig = {
  /** 에이전트가 읽고 조작할 수 있는 사이트. 모의 사이트는 어느 빌드에서나 연습용으로 남긴다. */
  /** 확장 코드 안에서 쓰는 기본 허용 사이트 (빌드할 때 모드·환경 값이 들어가 결정된다) */
  sitePermissions: [...new Set(['http://localhost:4173/*', ...extraSites, ...(allSites ? ['http://*/*', 'https://*/*'] : [])])],
  /**
   * manifest에 넣을 기본 사이트 (모든 사이트는 뺀 것). 이 파일은 환경 파일을 읽기 전에 불러와져 allSites를 믿을 수 없으므로,
   * wxt.config.ts가 모드와 환경 값으로 모든 사이트를 따로 더한다.
   */
  baseSitePermissions: [...new Set(['http://localhost:4173/*', ...extraSites])],
  /** 모델 API 호스트. */
  llmPermissions: ['http://localhost:4174/*'],
  /** 설정 화면의 초기값. 사용자가 바꾼 값은 브라우저에 저장된다. */
  llmDefaults: {
    baseUrl: 'http://localhost:4174/v1',
    apiKey: '',
    model: 'gemma',
    jsonMode: false,
    // 모델이 화면 그림(이미지)을 받을 때만 켠다. 사내 게이트웨이의 모델이 이미지 입력을 지원하는지 먼저 확인할 것.
    vision: false,
    timeoutScale: 1,
    skillDirect: true,
    pathCache: true,
    // 공유 스킬 저장소. 배포할 때는 .env.local의 WXT_SKILLS_URL에 적는다.
    skillsUrl: '',
    // 사내 게이트웨이의 Send-System-Name. 환경 파일의 WXT_LLM_SYSTEM_NAME이나 설정 화면에서 바꾼다.
    systemName: 'RFGo',
  },
};
