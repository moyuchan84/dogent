// Native Messaging 호스트를 이 PC에 등록한다 (관리자 권한 불필요, 현재 사용자만).
//
//   pnpm bridge:install [--id <확장 ID>] [--id <다른 ID>] [--browser chrome,edge]
//   pnpm bridge:install --remove
//
// --id를 안 주면 크롬·엣지 프로필에 설치된 Dogent 확장을 찾아 등록한다. 압축해제 설치는 폴더마다 ID가 다르므로
// 쓰는 빌드 폴더의 ID가 모두 등록된다 (이미 등록된 ID는 남긴다). 데스크탑 앱은 첫 실행에 같은 일을 스스로 한다.
// 자세한 동작은 register.mjs.
import { loadToken } from './hub.mjs';
import { findInstalledExtensions, registerNativeHost, unregisterNativeHost } from './register.mjs';

const args = process.argv.slice(2);
const values = (flag) => args.flatMap((a, i) => (a === flag && args[i + 1] ? args[i + 1].split(',') : []));
const browsers = values('--browser').length ? values('--browser') : ['chrome', 'edge'];
const log = (line) => console.log(line);

try {
  if (args.includes('--remove')) {
    unregisterNativeHost({ browsers, log });
    process.exit(0);
  }
  let ids = values('--id');
  if (ids.length === 0) {
    const found = findInstalledExtensions();
    for (const f of found) log(`찾음: ${f.id} (${f.browser}, 프로필 ${f.profile})`);
    ids = found.map((f) => f.id);
  }
  if (ids.length === 0) {
    console.error('설치된 Dogent 확장을 찾지 못했습니다. 확장 관리 화면의 ID를 --id 로 적어 주세요.');
    process.exit(1);
  }
  const { manifest, ids: all } = registerNativeHost({ ids, browsers, log });
  console.log(`
매니페스트: ${manifest}
허용한 확장: ${all.join(', ')}
토큰: ${loadToken()}
확장 설정 → 클라이언트 연결에서 방식을 "Native Messaging"으로 하면 토큰은 자동으로 전달됩니다 (WebSocket은 토큰을 넣어야 합니다).`);
} catch (e) {
  console.error(e.message);
  process.exit(1);
}
