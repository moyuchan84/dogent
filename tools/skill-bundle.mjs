// 스킬 검사기를 Node만 있으면 도는 한 파일로 묶어 팀 스킬 저장소 틀에 넣는다.
//
//   pnpm skill:bundle
//
// 검사 규칙(src/core/lint.ts)을 고치면 다시 묶고, 팀 스킬 저장소의 tools/skill-check.mjs를 이 파일로 바꾼다.
import { copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { build } from 'rolldown';

const ROOT = join(import.meta.dirname, '..');
const OUT = join(ROOT, 'templates/dogent-skills/tools');

await build({
  input: join(ROOT, 'tools/skill-check.ts'),
  platform: 'node',
  output: {
    file: join(OUT, 'skill-check.mjs'),
    format: 'esm',
    minify: true,
    banner: '// 생성된 파일입니다. 고치지 말고 Dogent 저장소에서 pnpm skill:bundle 로 다시 만드세요.',
  },
});
copyFileSync(join(ROOT, 'tools/skill-index.mjs'), join(OUT, 'skill-index.mjs'));
console.log(`${OUT} 에 skill-check.mjs, skill-index.mjs를 만들었습니다`);
