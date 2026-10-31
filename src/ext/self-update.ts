import { browser } from 'wxt/browser';
import { lastCallAt } from './bridge';

/**
 * 확장이 스스로 새 판으로 바뀐다.
 *
 * 압축해제로 로드한 확장은 폴더의 파일을 덮어써도 다시 읽기 전까지 옛 코드로 돈다. 그래서 업데이트할 때마다
 * 확장 관리 화면에서 새로고침을 누르거나 지웠다 다시 로드해야 했다. 빌드마다 다른 표시(BUILD_STAMP)를 코드와
 * 폴더의 build.json에 함께 넣고, 둘이 다르면(설치 프로그램이 폴더를 새 판으로 덮어씀) runtime.reload()로 다시 읽는다.
 * 같은 폴더·같은 ID라 설정과 실행 기록은 그대로 남는다.
 *
 * - 시작할 때, 1분마다, 사이드 패널을 열 때 본다.
 * - 사이드 패널에서 실행 중이거나 클라이언트(앱)가 방금까지 화면을 조작했으면 미룬다.
 * - 개발 서버(wxt dev)는 스스로 다시 읽으므로 하지 않는다.
 */

declare const __DOGENT_EXT_STAMP__: string;

const ALARM = 'dogent-self-update';
/** 사이드 패널이 실행 중일 때 storage.session에 남기는 표시 (실행을 시작한 때) */
export const BUSY_KEY = 'dogent.busy';
/** 실행 표시가 이보다 오래되면 패널이 닫히며 지우지 못한 것으로 본다 */
const BUSY_STALE_MS = 30 * 60_000;
/** 클라이언트가 마지막으로 도구를 부른 뒤 이만큼은 실행 중으로 본다 */
const CLIENT_IDLE_MS = 60_000;

async function diskStamp(): Promise<string | null> {
  try {
    // build.json은 빌드 때 만들어 public 목록의 타입에 없다
    const res = await fetch(browser.runtime.getURL('/build.json' as '/sidepanel.html'), { cache: 'no-store' });
    if (!res.ok) return null;
    const { stamp } = (await res.json()) as { stamp?: unknown };
    return typeof stamp === 'string' ? stamp : null;
  } catch {
    // 폴더를 덮어쓰는 중이면 잠깐 읽지 못할 수 있다. 다음에 다시 본다
    return null;
  }
}

async function busy(): Promise<boolean> {
  if (Date.now() - lastCallAt() < CLIENT_IDLE_MS) return true;
  const since = Number((await browser.storage.session.get(BUSY_KEY))[BUSY_KEY] ?? 0);
  return since > 0 && Date.now() - since < BUSY_STALE_MS;
}

/** 폴더의 파일이 다른 빌드로 바뀌었으면 다시 읽는다. 다시 읽으면 true (그 뒤의 코드는 돌지 않는다) */
export async function checkForUpdate(): Promise<boolean> {
  if (import.meta.env.COMMAND === 'serve') return false;
  const stamp = await diskStamp();
  if (!stamp || stamp === __DOGENT_EXT_STAMP__) return false;
  if (await busy()) return false;
  console.info(`[Dogent] 새 판으로 바뀌었습니다 (${__DOGENT_EXT_STAMP__} → ${stamp}). 다시 읽습니다`);
  browser.runtime.reload();
  return true;
}

export function watchForUpdate(): void {
  if (import.meta.env.COMMAND === 'serve') return;
  void browser.alarms.create(ALARM, { periodInMinutes: 1 });
  browser.alarms.onAlarm.addListener((a) => {
    if (a.name === ALARM) void checkForUpdate();
  });
  browser.runtime.onMessage.addListener((msg) => {
    // 지금 도는 코드의 표시도 돌려준다 (어느 판이 도는지 확인할 때)
    if ((msg as { type?: string })?.type === 'dogent:check-update') return checkForUpdate().then((reloaded) => ({ reloaded, stamp: __DOGENT_EXT_STAMP__ }));
    return undefined;
  });
  void checkForUpdate();
}
