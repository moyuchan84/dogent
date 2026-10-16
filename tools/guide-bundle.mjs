// 따라하기 안내서(docs/08-hands-on-guide.html)를 그림까지 넣은 한 파일로 만든다.
//
//   pnpm guide:bundle   → 저장소 맨 위의 DOGENT-GUIDE.html
//
// 사내망에서도 파일 하나만 열거나 전달하면 보이게 한다. 안내서를 고치면 다시 만든다.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..');
const DOCS = join(ROOT, 'docs');
let html = readFileSync(join(DOCS, '08-hands-on-guide.html'), 'utf8');

// "크게" 링크는 그림 파일을 새 탭으로 여는 것이라 한 파일에서는 쓸 수 없다. 그림은 이미 본문에 있다.
html = html.replace(/ · <a href="guide-img\/[^"]+"[^>]*>[^<]*<\/a>/g, '');

let count = 0;
html = html.replace(/src="(guide-img\/[^"]+\.png)"/g, (_, path) => {
  count++;
  return `src="data:image/png;base64,${readFileSync(join(DOCS, path)).toString('base64')}"`;
});

const out = join(ROOT, 'DOGENT-GUIDE.html');
writeFileSync(
  out,
  `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<!-- 생성된 파일입니다. docs/08-hands-on-guide.html 을 고치고 pnpm guide:bundle 로 다시 만드세요. -->
${html}
</html>
`,
);
console.log(`${out} (그림 ${count}장, ${(readFileSync(out).length / 1024 / 1024).toFixed(1)}MB)`);
