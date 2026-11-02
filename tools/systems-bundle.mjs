// 시스템 사전 검사기와 시스템 MCP 서버를 Node만 있으면 도는 한 파일씩으로 묶어 공용 시스템 사전 저장소 틀에 넣는다.
//
//   pnpm systems:bundle
//
// 검사 규칙(src/core/systems.ts)이나 서버(tools/systems-mcp*.ts)를 고치면 다시 묶고, 사전 저장소의 tools/를 이 파일들로 바꾼다.
import { join } from 'node:path';
import { build } from 'rolldown';

const ROOT = join(import.meta.dirname, '..');
const OUT = join(ROOT, 'templates/dogent-systems/tools');
const banner = '// 생성된 파일입니다. 고치지 말고 Dogent 저장소에서 pnpm systems:bundle 로 다시 만드세요.';

for (const name of ['system-check', 'systems-mcp']) {
  await build({
    input: join(ROOT, `tools/${name}.ts`),
    platform: 'node',
    output: { file: join(OUT, `${name}.mjs`), format: 'esm', minify: true, banner },
  });
}
console.log(`${OUT} 에 system-check.mjs, systems-mcp.mjs를 만들었습니다`);
