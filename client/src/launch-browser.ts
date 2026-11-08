import { execFileSync, spawn } from 'node:child_process';

/** 브라우저 이름(설정의 browser 값) → 윈도 실행 이름과 프로세스 이름 */
export function browserTarget(want?: string): { start: string; image: string } {
  const w = (want ?? '').toLowerCase();
  if (w.includes('edge') || w.includes('엣지')) return { start: 'msedge', image: 'msedge.exe' };
  return { start: 'chrome', image: 'chrome.exe' };
}

export interface LaunchDeps {
  /** 그 이름의 프로세스가 떠 있는지 */
  running?: (image: string) => boolean;
  /** 브라우저를 띄운다 */
  start?: (name: string) => void;
  platform?: NodeJS.Platform;
}

const isRunning = (image: string): boolean => {
  try {
    const out = execFileSync('tasklist', ['/FI', `IMAGENAME eq ${image}`, '/FO', 'CSV', '/NH'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    return out.toLowerCase().includes(image.toLowerCase());
  } catch {
    return false;
  }
};

const startWindows = (name: string): void => {
  // start는 App Paths에 등록된 chrome, msedge를 경로 없이 찾는다
  const child = spawn('cmd.exe', ['/c', 'start', '""', name], { detached: true, stdio: 'ignore', windowsHide: true });
  child.unref();
};

/**
 * 브라우저가 꺼져 있으면 띄운다. 이미 떠 있으면(확장만 아직 안 붙은 것) 새 창을 더 열지 않는다.
 * 돌려주는 값: 'started' 띄웠다 / 'running' 이미 떠 있다 / 'unsupported' 이 PC에서는 못 한다
 */
export function launchBrowser(want?: string, deps: LaunchDeps = {}): 'started' | 'running' | 'unsupported' {
  if ((deps.platform ?? process.platform) !== 'win32') return 'unsupported';
  const t = browserTarget(want);
  if ((deps.running ?? isRunning)(t.image)) return 'running';
  try {
    (deps.start ?? startWindows)(t.start);
    return 'started';
  } catch {
    return 'unsupported';
  }
}
