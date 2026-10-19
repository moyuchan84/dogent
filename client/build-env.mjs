// 클라이언트와 데스크탑 앱이 같이 쓰는 빌드 설정: 환경 파일의 모델 설정과 기본 스킬.
// 확장과 같은 환경 파일(.env.<mode>.local의 WXT_LLM_*)을 읽어 집/회사 전환을 똑같이 한다.
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

export const ROOT = join(import.meta.dirname, '..');

/** 명령줄의 --mode 값. 없으면 production */
export function modeFromArgs(argv = process.argv) {
  return argv.includes('--mode') ? argv[argv.indexOf('--mode') + 1] : 'production';
}

/** Vite와 같은 순서로 환경 파일을 읽는다: .env, .env.local, .env.<mode>, .env.<mode>.local (뒤가 이김) */
function loadEnv(mode) {
  const env = {};
  for (const name of ['.env', '.env.local', `.env.${mode}`, `.env.${mode}.local`]) {
    const file = join(ROOT, name);
    if (!existsSync(file)) continue;
    for (const raw of readFileSync(file, 'utf8').split(/\r?\n/)) {
      const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(raw);
      if (!m) continue;
      let v = m[2].trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
      env[m[1]] = v;
    }
  }
  return { ...env, ...Object.fromEntries(Object.entries(process.env).filter(([k]) => k.startsWith('WXT_'))) };
}

/** 빌드에 넣을 모델 설정 (빈 값은 뺀다) */
export function llmFromEnv(mode) {
  const env = loadEnv(mode);
  const bool = (v) => (v ? v.trim().toLowerCase() === 'true' : undefined);
  return Object.fromEntries(
    Object.entries({
      baseUrl: env.WXT_LLM_BASE_URL,
      apiKey: env.WXT_LLM_API_KEY,
      model: env.WXT_LLM_MODEL,
      jsonMode: bool(env.WXT_LLM_JSON_MODE),
      timeoutScale: Number(env.WXT_LLM_TIMEOUT_SCALE) || undefined,
      headers: env.WXT_LLM_HEADERS?.trim() ? JSON.parse(env.WXT_LLM_HEADERS) : undefined,
      userId: env.WXT_LLM_USER_ID,
      userType: env.WXT_LLM_USER_TYPE,
      systemName: env.WXT_LLM_SYSTEM_NAME,
    }).filter(([, v]) => v !== undefined && v !== ''),
  );
}

/** 기본 스킬: skills/<id>/SKILL.md, policy.yaml */
export function bundledSkills() {
  const skills = {};
  for (const d of readdirSync(join(ROOT, 'skills'), { withFileTypes: true })) {
    if (!d.isDirectory()) continue;
    for (const f of ['SKILL.md', 'policy.yaml']) {
      const p = join(ROOT, 'skills', d.name, f);
      if (existsSync(p)) skills[`${d.name}/${f}`] = readFileSync(p, 'utf8');
    }
  }
  return skills;
}

/** rolldown의 define에 넣을 값 */
export function buildDefines(mode) {
  const version = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version;
  const llm = llmFromEnv(mode);
  // 팀 스킬 저장소의 목록 주소. 확장의 공유 스킬 저장소와 같은 값을 쓴다 (사용자가 dogent config teamSkillsUrl로 바꿀 수 있다)
  const skillsUrl = loadEnv(mode).WXT_SKILLS_URL?.trim() || undefined;
  return {
    llm,
    skills: bundledSkills(),
    define: {
      __DOGENT_BUILD__: JSON.stringify({ mode, version, llm, ...(skillsUrl ? { skillsUrl } : {}) }),
      __DOGENT_SKILLS__: JSON.stringify(bundledSkills()),
    },
  };
}

/** 빌드 요약에 찍을 모델 설정. 키는 앞 세 글자만, 헤더는 이름만 */
export function maskedLlm(llm) {
  return { ...llm, ...(llm.apiKey ? { apiKey: `${llm.apiKey.slice(0, 3)}…` } : {}), ...(llm.headers ? { headers: Object.keys(llm.headers).join(', ') } : {}) };
}
