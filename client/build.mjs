// Dogent 클라이언트를 Node만 있으면 도는 한 파일(client/dist/dogent.mjs)로 묶는다.
//
//   pnpm client:build                 개발 기본값 (모의 모델)
//   pnpm client:build --mode home     .env.home.local (집: Ollama)
//   pnpm client:build --mode company  .env.company.local (회사: Gemma 게이트웨이)
//
// 모델 설정은 확장과 같은 환경 파일(WXT_LLM_*)을 읽는다. 키가 들어가므로 결과 파일은 사내에서만 나눈다 (저장소에는 올리지 않음).
import { join } from 'node:path';
import { build } from 'rolldown';
import { ROOT, buildDefines, maskedLlm, modeFromArgs } from './build-env.mjs';

const mode = modeFromArgs();
const { llm, skills, define } = buildDefines(mode);

await build({
  input: join(ROOT, 'client/src/main.ts'),
  platform: 'node',
  // ws의 선택 의존성. 없으면 ws가 스스로 건너뛴다.
  external: ['bufferutil', 'utf-8-validate'],
  transform: { define },
  output: {
    file: join(ROOT, 'client/dist/dogent.mjs'),
    format: 'esm',
    banner: '#!/usr/bin/env node\n// 생성된 파일입니다. client/ 에서 pnpm client:build 로 다시 만드세요.',
  },
});

console.log(`client/dist/dogent.mjs (${mode})`);
console.log(`  모델: ${JSON.stringify(maskedLlm(llm))}`);
console.log(`  기본 스킬: ${Object.keys(skills).filter((k) => k.endsWith('SKILL.md')).length}개`);
