// Dogent 클라이언트를 Node만 있으면 도는 한 파일(client/dist/dogent.mjs)로 묶는다.
//
//   pnpm client:build                 개발 기본값 (모의 모델)
//   pnpm client:build --mode home     .env.home.local (집: Ollama)
//   pnpm client:build --mode company  .env.company.local (회사: Gemma 게이트웨이)
//
// 모델 설정은 확장과 같은 환경 파일(WXT_LLM_*)을 읽는다. 키가 들어가므로 결과 파일은 사내에서만 나눈다 (저장소에는 올리지 않음).
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { build } from 'rolldown';

const ROOT = join(import.meta.dirname, '..');
const mode = process.argv.includes('--mode') ? process.argv[process.argv.indexOf('--mode') + 1] : 'production';

/** Vite와 같은 순서로 환경 파일을 읽는다: .env, .env.local, .env.<mode>, .env.<mode>.local (뒤가 이김) */
function loadEnv() {
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

const env = loadEnv();
const bool = (v) => (v ? v.trim().toLowerCase() === 'true' : undefined);
const llm = Object.fromEntries(
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

/** 기본 스킬: skills/<id>/SKILL.md, policy.yaml */
const skills = {};
for (const d of readdirSync(join(ROOT, 'skills'), { withFileTypes: true })) {
  if (!d.isDirectory()) continue;
  for (const f of ['SKILL.md', 'policy.yaml']) {
    const p = join(ROOT, 'skills', d.name, f);
    if (existsSync(p)) skills[`${d.name}/${f}`] = readFileSync(p, 'utf8');
  }
}

const version = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version;
await build({
  input: join(ROOT, 'client/src/main.ts'),
  platform: 'node',
  // ws의 선택 의존성. 없으면 ws가 스스로 건너뛴다.
  external: ['bufferutil', 'utf-8-validate'],
  transform: {
    define: {
      __DOGENT_BUILD__: JSON.stringify({ mode, version, llm }),
      __DOGENT_SKILLS__: JSON.stringify(skills),
    },
  },
  output: {
    file: join(ROOT, 'client/dist/dogent.mjs'),
    format: 'esm',
    banner: '#!/usr/bin/env node\n// 생성된 파일입니다. client/ 에서 pnpm client:build 로 다시 만드세요.',
  },
});

const masked = { ...llm, ...(llm.apiKey ? { apiKey: `${llm.apiKey.slice(0, 3)}…` } : {}), ...(llm.headers ? { headers: Object.keys(llm.headers).join(', ') } : {}) };
console.log(`client/dist/dogent.mjs (${mode})`);
console.log(`  모델: ${JSON.stringify(masked)}`);
console.log(`  기본 스킬: ${Object.keys(skills).filter((k) => k.endsWith('SKILL.md')).length}개`);
