import { defineConfig } from 'wxt';
import { dogentConfig } from './dogent.config';

export default defineConfig({
  modules: ['@wxt-dev/module-react'],
  imports: false,
  // 함수로 두어야 .env 파일의 값을 읽은 뒤에 만들어진다.
  manifest: ({ mode, command }) => {
    // 배포 환경의 모델 API 주소(.env.local의 WXT_LLM_BASE_URL)가 있으면 그 호스트도 허용한다.
    const llmUrl = import.meta.env.WXT_LLM_BASE_URL as string | undefined;
    const llmHost = llmUrl ? [`${new URL(llmUrl).origin}/*`] : [];
    // 공유 스킬 저장소(WXT_SKILLS_URL)도 마찬가지다.
    const skillsUrl = import.meta.env.WXT_SKILLS_URL as string | undefined;
    const skillsHost = skillsUrl ? [`${new URL(skillsUrl).origin}/*`] : [];
    checkHeaders(import.meta.env.WXT_LLM_HEADERS as string | undefined);
    // dogent.config.ts는 환경 파일을 읽기 전에 불러와지므로, 빌드 환경의 사이트 주소는 여기서 다시 읽는다.
    const sites = [
      ...dogentConfig.sitePermissions,
      ...((import.meta.env.WXT_SITE_PERMISSIONS as string | undefined) ?? '').split(',').map((x) => x.trim()).filter(Boolean),
    ];
    if (command === 'build') printProfile(mode, sites);
    return {
      name: 'Dogent',
      description: '스킬(업무 절차서)을 따라 사내 웹 시스템을 조작하는 업무 에이전트',
      permissions: ['sidePanel', 'scripting', 'storage', 'tabs', 'downloads'],
      host_permissions: [...new Set([...sites, ...dogentConfig.llmPermissions, ...llmHost, ...skillsHost])],
      // 아이콘 원본은 public/icon/dogent.svg. PNG는 그것을 크기별로 그린 것이다 (Do-Agent: D 위의 클릭하는 포인터).
      icons: { 16: 'icon/16.png', 32: 'icon/32.png', 48: 'icon/48.png', 128: 'icon/128.png' },
      action: {
        default_title: 'Dogent 열기',
        default_icon: { 16: 'icon/16.png', 32: 'icon/32.png', 48: 'icon/48.png', 128: 'icon/128.png' },
      },
    };
  },
});

/** .env.local의 WXT_LLM_HEADERS가 잘못 적혔으면 빌드를 멈추고 무엇이 틀렸는지 알린다. */
function checkHeaders(raw: string | undefined): void {
  if (!raw?.trim()) return;
  const fail = (why: string) => {
    throw new Error(`환경 파일의 WXT_LLM_HEADERS: ${why}\n예: WXT_LLM_HEADERS='{"x-dep-ticket":"{key}","User-Id":"{userId}"}'`);
  };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    return fail(`JSON 형식이 아닙니다 (${(e as Error).message}). 줄 전체를 작은따옴표로 감쌌는지 확인하세요`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return fail('{ "헤더 이름": "값" } 모양이어야 합니다');
  for (const [name, value] of Object.entries(parsed)) {
    if (typeof value !== 'string') fail(`${name}의 값이 글자가 아닙니다`);
    if (!/^[A-Za-z0-9-]+$/.test(name)) fail(`헤더 이름 "${name}"에 영문·숫자·- 말고 다른 글자가 있습니다`);
    const unknown = [...(value as string).matchAll(/\{(\w+)\}/g)].map((m) => m[1]).filter((k) => !['key', 'userId', 'userType', 'uuid'].includes(k));
    if (unknown.length) fail(`${name}의 {${unknown[0]}}는 모르는 자리표시자입니다. {key} {userId} {userType} {uuid}만 씁니다`);
  }
}

let printed = false;

/** 어떤 설정으로 빌드했는지 보여 준다. 집(Ollama)용과 회사(Gemma)용을 바꿔 빌드할 때 실수를 줄인다. 키 값은 찍지 않는다. */
function printProfile(mode: string, sites: string[]): void {
  if (printed) return;
  printed = true;
  const env = import.meta.env as Record<string, string | undefined>;
  const headers = env.WXT_LLM_HEADERS ? Object.keys(JSON.parse(env.WXT_LLM_HEADERS)) : [];
  const out = mode === 'production' ? '.output/chrome-mv3' : `.output/chrome-mv3-${mode}`;
  const lines = [
    `빌드 설정: ${mode}`,
    `  모델 API   ${env.WXT_LLM_BASE_URL || `${dogentConfig.llmDefaults.baseUrl} (기본값: 모의 모델 또는 Ollama 중계)`}`,
    `  모델 이름  ${env.WXT_LLM_MODEL || `${dogentConfig.llmDefaults.model} (기본값)`}`,
    `  API 키     ${env.WXT_LLM_API_KEY ? '있음 (빌드에 포함)' : '없음'}`,
    `  요청 헤더  ${headers.length ? headers.join(', ') : 'Authorization: Bearer (OpenAI 방식)'}`,
    `  사이트     ${sites.join(', ')}`,
    `  확장 폴더  ${out}  ← chrome://extensions 에서 이 폴더를 로드`,
  ];
  console.log(['', ...lines, ''].join('\n'));
}
