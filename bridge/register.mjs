// Native Messaging 호스트를 이 PC에 등록한다 (관리자 권한 불필요, 현재 사용자만). install.mjs와 데스크탑 앱이 같이 쓴다.
//
//   <호스트 폴더>\native-host.cmd        크롬이 띄울 실행 파일
//   <호스트 폴더>\com.dogent.bridge.json 호스트 매니페스트 (허용할 확장 ID)
//   HKCU\Software\<브라우저>\NativeMessagingHosts\com.dogent.bridge → 위 매니페스트
//
// 호스트 폴더 (hostHome): DOGENT_HOME\native → D:\Multimedia\Dogent\native (D:\Multimedia가 있을 때) → ~/.dogent
// 회사 PC는 보안 프로그램(EDM/NASCA) 때문에 크롬이 D:\Multimedia 아래 파일만 읽고 띄울 수 있어 그곳을 먼저 쓴다.
// 예전 위치(~/.dogent)의 호스트 파일은 새로 등록할 때 지운다. 토큰(~/.dogent/bridge-token)과 내 스킬·기록은 그대로 둔다.
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { EXTENSION_ID } from './extension-key.mjs';
import { NATIVE_HOST_NAME } from './protocol.mjs';

// PATH에 System32가 빠진 셸(Git Bash 등)에서도 찾도록 전체 경로로 부른다.
const REG = join(process.env.SystemRoot ?? 'C:/Windows', 'System32', 'reg.exe');

export const REGISTRY_KEYS = {
  chrome: 'HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts',
  edge: 'HKCU\\Software\\Microsoft\\Edge\\NativeMessagingHosts',
  chromium: 'HKCU\\Software\\Chromium\\NativeMessagingHosts',
};

/** 브라우저별 프로필 폴더 (확장 ID를 찾을 때 읽는다) */
const USER_DATA = {
  chrome: ['Google', 'Chrome', 'User Data'],
  edge: ['Microsoft', 'Edge', 'User Data'],
};

const ID_PATTERN = /^[a-p]{32}$/;
export const isExtensionId = (id) => ID_PATTERN.test(String(id).trim());

const legacyDir = () => join(homedir(), '.dogent');
const MULTIMEDIA = 'D:\\Multimedia';

/** 호스트 파일(실행 파일·매니페스트·스크립트)을 둘 폴더 */
export function hostHome() {
  if (process.env.DOGENT_HOME) return join(process.env.DOGENT_HOME, 'native');
  if (process.platform === 'win32' && existsSync(MULTIMEDIA)) return join(MULTIMEDIA, 'Dogent', 'native');
  return legacyDir();
}
const HOST_FILES = [`${NATIVE_HOST_NAME}.json`, 'native-host.cmd', 'native-host.mjs', 'protocol.mjs'];
const manifestPath = (dir = hostHome()) => join(dir, `${NATIVE_HOST_NAME}.json`);
export const launcherPath = (dir = hostHome()) => join(dir, 'native-host.cmd');

function idsIn(manifest) {
  if (!existsSync(manifest)) return [];
  try {
    const origins = JSON.parse(readFileSync(manifest, 'utf8')).allowed_origins ?? [];
    return origins.map((o) => o.replace(/^chrome-extension:\/\/|\/$/g, ''));
  } catch {
    return [];
  }
}

/** 이미 등록된 허용 확장 ID (예전 위치에 남은 등록도 합친다) */
export function registeredIds() {
  const dirs = [...new Set([hostHome(), legacyDir()])];
  return [...new Set(dirs.flatMap((d) => idsIn(manifestPath(d))))];
}

/** 호스트 폴더가 바뀌었으면 예전 위치의 호스트 파일을 지운다 */
function removeLegacyHostFiles() {
  if (hostHome() === legacyDir()) return;
  for (const f of HOST_FILES) {
    const p = join(legacyDir(), f);
    if (existsSync(p)) rmSync(p, { force: true });
  }
}

/** 크롬·엣지 프로필에 설치된 Dogent 확장을 찾는다. 압축해제 설치는 설정 파일에 manifest가 남는다. */
export function findInstalledExtensions() {
  const local = process.env.LOCALAPPDATA;
  if (!local) return [];
  const found = [];
  for (const [browser, parts] of Object.entries(USER_DATA)) {
    const root = join(local, ...parts);
    if (!existsSync(root)) continue;
    for (const profile of readdirSync(root)) {
      for (const file of ['Secure Preferences', 'Preferences']) {
        const p = join(root, profile, file);
        if (!existsSync(p)) continue;
        try {
          const settings = JSON.parse(readFileSync(p, 'utf8')).extensions?.settings ?? {};
          for (const [id, ext] of Object.entries(settings)) {
            if (isExtensionId(id) && ext?.manifest?.name === 'Dogent') found.push({ id, browser, profile });
          }
        } catch {
          /* 읽을 수 없는 프로필은 건너뛴다 */
        }
      }
    }
  }
  const seen = new Set();
  return found.filter((f) => !seen.has(f.id) && seen.add(f.id));
}

/**
 * 호스트를 등록한다. ids는 더 허용할 확장 ID(이미 등록된 것은 남긴다).
 * 매니페스트의 key로 정해진 Dogent 확장 ID(EXTENSION_ID)는 늘 허용하므로, 확장을 아직 로드하지 않았어도 미리 등록해 둘 수 있다.
 * runtime을 주면 node 대신 그 실행 파일을 쓴다 (묶어 낸 앱: Electron을 ELECTRON_RUN_AS_NODE로 돌린다).
 * 호스트 스크립트(hostDir의 native-host.mjs, protocol.mjs)는 늘 호스트 폴더(hostHome)로 복사한다. 묶어 낸 앱은 압축 파일 안이라
 * 크롬이 읽을 수 없고, 휴대용 실행본은 경로가 바뀔 수 있고, 회사 PC는 D:\Multimedia 밖의 파일을 크롬이 띄우지 못할 수 있다.
 */
export function registerNativeHost({ ids = [], browsers = ['chrome', 'edge'], runtime, hostDir = import.meta.dirname, log = () => {} }) {
  if (process.platform !== 'win32') throw new Error('지금은 Windows만 지원합니다');
  for (const b of browsers) if (!REGISTRY_KEYS[b]) throw new Error(`모르는 브라우저: ${b} (chrome, edge, chromium 중에서)`);
  for (const id of ids) if (!isExtensionId(id)) throw new Error(`확장 ID 형식이 아닙니다: ${id} (a~p 32글자)`);
  const allIds = [...new Set([EXTENSION_ID, ...registeredIds(), ...ids.map((i) => i.trim())])];

  const home = hostHome();
  mkdirSync(home, { recursive: true });
  const hostScript = join(home, 'native-host.mjs');
  copyFileSync(join(hostDir, 'native-host.mjs'), hostScript);
  copyFileSync(join(hostDir, 'protocol.mjs'), join(home, 'protocol.mjs'));
  // 크롬은 Windows에서 .cmd를 띄울 수 있다.
  const line = runtime
    ? `set ELECTRON_RUN_AS_NODE=1\r\n"${runtime}" "${hostScript}" %*\r\n`
    : `"${process.execPath}" "${hostScript}" %*\r\n`;
  writeFileSync(launcherPath(), `@echo off\r\n${line}`);
  writeFileSync(
    manifestPath(),
    `${JSON.stringify(
      { name: NATIVE_HOST_NAME, description: 'Dogent bridge', path: launcherPath(), type: 'stdio', allowed_origins: allIds.map((id) => `chrome-extension://${id}/`) },
      null,
      2,
    )}\n`,
  );
  for (const b of browsers) {
    execFileSync(REG, ['add', `${REGISTRY_KEYS[b]}\\${NATIVE_HOST_NAME}`, '/ve', '/t', 'REG_SZ', '/d', manifestPath(), '/f'], { stdio: 'ignore' });
    log(`${b}: 등록했습니다`);
  }
  removeLegacyHostFiles();
  return { manifest: manifestPath(), ids: allIds };
}

export function unregisterNativeHost({ browsers = ['chrome', 'edge'], log = () => {} } = {}) {
  for (const b of browsers) {
    try {
      execFileSync(REG, ['delete', `${REGISTRY_KEYS[b]}\\${NATIVE_HOST_NAME}`, '/f'], { stdio: 'ignore' });
      log(`${b}: 등록을 지웠습니다`);
    } catch {
      log(`${b}: 등록되어 있지 않습니다`);
    }
  }
  for (const dir of new Set([hostHome(), legacyDir()])) {
    for (const f of HOST_FILES) if (existsSync(join(dir, f))) rmSync(join(dir, f), { force: true });
  }
}
