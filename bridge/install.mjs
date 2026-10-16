// Native Messaging 호스트를 이 PC에 등록한다 (관리자 권한 불필요, 현재 사용자만).
//
//   pnpm bridge:install --id <확장 ID> [--id <다른 ID>] [--browser chrome,edge]
//   pnpm bridge:install --remove
//
// 확장 ID는 확장 관리 화면(chrome://extensions, edge://extensions)의 Dogent 카드나 패널 설정에 나온다.
// 압축해제 설치는 폴더마다 ID가 다르므로, 쓰는 빌드 폴더의 ID를 모두 적는다 (이미 등록된 ID는 남긴다).
//
// 하는 일
//   ~/.dogent/native-host.cmd       크롬이 띄울 실행 파일 (지금 node로 bridge/native-host.mjs 실행)
//   ~/.dogent/com.dogent.bridge.json 호스트 매니페스트 (허용할 확장 ID)
//   HKCU\Software\<브라우저>\NativeMessagingHosts\com.dogent.bridge → 위 매니페스트
//   ~/.dogent/bridge-token           없으면 만든다 (확장 설정에 넣을 토큰)
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { loadToken } from './hub.mjs';
import { NATIVE_HOST_NAME } from './protocol.mjs';

// PATH에 System32가 빠진 셸(Git Bash 등)에서도 찾도록 전체 경로로 부른다.
const REG = join(process.env.SystemRoot ?? 'C:/Windows', 'System32', 'reg.exe');

const KEYS = {
  chrome: 'HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts',
  edge: 'HKCU\\Software\\Microsoft\\Edge\\NativeMessagingHosts',
  chromium: 'HKCU\\Software\\Chromium\\NativeMessagingHosts',
};

const args = process.argv.slice(2);
const values = (flag) => args.flatMap((a, i) => (a === flag && args[i + 1] ? args[i + 1].split(',') : []));
const browsers = values('--browser').length ? values('--browser') : ['chrome', 'edge'];
const dir = join(homedir(), '.dogent');
const manifestPath = join(dir, `${NATIVE_HOST_NAME}.json`);
const launcher = join(dir, 'native-host.cmd');

if (process.platform !== 'win32') {
  console.error('지금은 Windows만 지원합니다. 다른 OS는 크롬 문서의 NativeMessagingHosts 폴더에 매니페스트를 직접 두세요.');
  process.exit(1);
}

for (const b of browsers) {
  if (!KEYS[b]) {
    console.error(`모르는 브라우저: ${b} (chrome, edge, chromium 중에서)`);
    process.exit(1);
  }
}

if (args.includes('--remove')) {
  for (const b of browsers) {
    try {
      execFileSync(REG, ['delete', `${KEYS[b]}\\${NATIVE_HOST_NAME}`, '/f'], { stdio: 'ignore' });
      console.log(`${b}: 등록을 지웠습니다`);
    } catch {
      console.log(`${b}: 등록되어 있지 않습니다`);
    }
  }
  for (const f of [manifestPath, launcher]) if (existsSync(f)) rmSync(f);
  process.exit(0);
}

const ids = values('--id');
const previous = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, 'utf8')).allowed_origins ?? [] : [];
const origins = [...new Set([...previous, ...ids.map((id) => `chrome-extension://${id.trim()}/`)])];
if (origins.length === 0) {
  console.error('확장 ID를 --id 로 적어 주세요. 확장 관리 화면이나 Dogent 설정 → 클라이언트 연결에 나옵니다.');
  process.exit(1);
}
for (const o of origins) {
  if (!/^chrome-extension:\/\/[a-p]{32}\/$/.test(o)) {
    console.error(`확장 ID 형식이 아닙니다: ${o} (a~p 32글자)`);
    process.exit(1);
  }
}

mkdirSync(dir, { recursive: true });
const host = join(import.meta.dirname, 'native-host.mjs');
// 크롬은 Windows에서 .cmd/.bat를 띄울 수 있다. node는 지금 이 스크립트를 돌린 것을 그대로 쓴다.
writeFileSync(launcher, `@echo off\r\n"${process.execPath}" "${host}" %*\r\n`);
writeFileSync(
  manifestPath,
  `${JSON.stringify({ name: NATIVE_HOST_NAME, description: 'Dogent bridge', path: launcher, type: 'stdio', allowed_origins: origins }, null, 2)}\n`,
);
for (const b of browsers) {
  execFileSync(REG, ['add', `${KEYS[b]}\\${NATIVE_HOST_NAME}`, '/ve', '/t', 'REG_SZ', '/d', manifestPath, '/f'], { stdio: 'ignore' });
  console.log(`${b}: 등록했습니다`);
}
const token = loadToken();
console.log(`
매니페스트: ${manifestPath}
허용한 확장: ${origins.join(', ')}

다음 순서
  1. 확장 설정 → 클라이언트 연결 → 방식 "Native Messaging", 아래 토큰을 넣고 저장
       ${token}
  2. MCP 클라이언트에 브리지를 등록 (예: Claude Code)
       claude mcp add dogent -- node "${join(import.meta.dirname, 'hub.mjs')}"
`);
