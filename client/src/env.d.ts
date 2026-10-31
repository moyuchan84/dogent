// client/build.mjs가 빌드할 때 채우는 값

/** 빌드 모드와 환경 파일(.env.<mode>.local)의 모델 설정. 확장과 같은 WXT_LLM_* 값을 읽는다. */
declare const __DOGENT_BUILD__: {
  mode: string;
  version: string;
  llm: Partial<import('../../src/core').LlmSettings>;
  /** 팀 스킬 저장소의 index.json 주소 (환경 파일의 WXT_SKILLS_URL) */
  skillsUrl?: string;
  /** 목업 사이트용 예시 스킬(samples/skills)을 넣어 빌드했는지 (WXT_SAMPLE_SKILLS=true). 그러면 예시 스킬을 처음부터 보인다 */
  samples?: boolean;
};

/** 클라이언트에 넣은 기본 스킬. 경로(예: wip-check/SKILL.md) → 내용 */
declare const __DOGENT_SKILLS__: Record<string, string>;

/** 브라우저가 띄우는 Native Messaging 호스트 파일 (native-host.mjs, protocol.mjs). dogent doctor --fix가 등록할 때 쓴다 */
declare const __DOGENT_HOST__: Record<string, string>;
