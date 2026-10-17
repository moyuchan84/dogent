// Dogent 데스크탑 앱을 빌드한다 (Electron).
//
//   pnpm desktop:build                 개발 기본값 (모의 모델)
//   pnpm desktop:build --mode company  .env.company.local (회사)
//   pnpm desktop                       빌드하고 바로 띄우기
//
// 터미널 클라이언트와 같은 환경 파일·기본 스킬을 쓴다 (client/build-env.mjs).
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { build } from 'rolldown';
import { ROOT, buildDefines, maskedLlm, modeFromArgs } from '../client/build-env.mjs';

const mode = modeFromArgs();
const { llm, define } = buildDefines(mode);
const SRC = join(ROOT, 'desktop/src');
const OUT = join(ROOT, 'desktop/dist');
mkdirSync(join(OUT, 'renderer'), { recursive: true });

// 메인 프로세스: 세션(판단·스킬·모델), 브리지, 오피스 도구
await build({
  input: join(SRC, 'main.ts'),
  platform: 'node',
  external: ['electron', 'bufferutil', 'utf-8-validate'],
  transform: { define },
  output: { file: join(OUT, 'main.mjs'), format: 'esm' },
});

// 창에 내놓는 API. Electron의 샌드박스 preload는 CommonJS여야 한다.
await build({
  input: join(SRC, 'preload.ts'),
  platform: 'node',
  external: ['electron'],
  output: { file: join(OUT, 'preload.cjs'), format: 'cjs' },
});

// 창
await build({
  input: join(SRC, 'renderer/main.tsx'),
  platform: 'browser',
  transform: { jsx: 'react-jsx', define: { 'process.env.NODE_ENV': JSON.stringify('production') } },
  output: { file: join(OUT, 'renderer/app.js'), format: 'iife', minify: true },
});
for (const f of ['index.html', 'style.css']) copyFileSync(join(SRC, 'renderer', f), join(OUT, 'renderer', f));
// 브라우저가 띄우는 Native Messaging 호스트 (앱이 첫 실행에 ~/.dogent로 복사해 등록한다)
mkdirSync(join(OUT, 'host'), { recursive: true });
for (const f of ['native-host.mjs', 'protocol.mjs']) copyFileSync(join(ROOT, 'bridge', f), join(OUT, 'host', f));
copyFileSync(join(ROOT, 'public/icon/dogent.svg'), join(OUT, 'renderer/icon.svg'));
copyFileSync(join(ROOT, 'public/icon/256.png'), join(OUT, 'renderer/icon.png'));

// 실행본은 이 폴더만으로 만든다. 코드는 모두 묶였으므로 의존성이 없는 package.json을 둔다.
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
writeFileSync(
  join(OUT, 'package.json'),
  JSON.stringify(
    {
      name: 'dogent-desktop',
      productName: 'Dogent',
      version: pkg.version,
      description: 'Dogent 업무 자동화 에이전트',
      author: 'Dogent',
      main: 'main.mjs',
      // electron-builder가 pnpm으로 의존성을 찾지 않게 한다 (찾을 의존성이 없다).
      packageManager: 'traversal@1.0.0',
      // 실행본에 넣을 Electron은 설치된 판과 같게
      devDependencies: { electron: JSON.parse(readFileSync(join(ROOT, 'node_modules/electron/package.json'), 'utf8')).version },
    },
    null,
    2,
  ),
);

console.log(`desktop/dist (${mode})`);
console.log(`  모델: ${JSON.stringify(maskedLlm(llm))}`);
