// Hub 서버와 LLM 프록시를 Node만 있으면 도는 한 파일씩으로 묶어 Hub 템플릿(templates/dogent-hub)에 넣는다.
//
//   pnpm hub:bundle
//
// 서버(tools/hub*.ts, tools/llm-proxy*.ts)를 고치면 다시 묶는다.
import { join } from 'node:path';
import { build } from 'rolldown';

const ROOT = join(import.meta.dirname, '..');
const OUT = join(ROOT, 'templates/dogent-hub/tools');
const banner = '// 생성된 파일입니다. 고치지 말고 Dogent 저장소에서 pnpm hub:bundle 로 다시 만드세요.';

for (const [input, name] of [['hub', 'hub'], ['llm-proxy', 'llm-proxy']]) {
  await build({
    input: join(ROOT, `tools/${input}.ts`),
    platform: 'node',
    output: { file: join(OUT, `${name}.mjs`), format: 'esm', minify: true, banner },
  });
}
console.log(`${OUT} 에 hub.mjs, llm-proxy.mjs를 만들었습니다`);
