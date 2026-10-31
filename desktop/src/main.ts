// Dogent 데스크탑 앱의 메인 프로세스.
//
// 터미널 클라이언트와 같은 세션(client/src/session.ts)을 띄우고, 묻기·진행·결과를 창(renderer)으로 보낸다.
// 판단·스킬·모델 호출은 여기서, 화면 조작은 브라우저의 Dogent 확장이, 엑셀은 오피스 도구가 한다 (docs/09).
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BrowserWindow, app, ipcMain, shell } from 'electron';
import { docOfSkill, skillCoversUrl, type RunEvent } from '../../src/core';
import { loadToken } from '../../client/src/bridge';
import { describeConfig, loadConfig, setConfig } from '../../client/src/config';
import { addServers, parsePasted, patchServer, probeServer, removeServer, serverRows, serverRow } from '../../client/src/connectors';
import { loadMcpConfig } from '../../client/src/mcp-hub';
import { Session, type SessionOptions, type Ui } from '../../client/src/session';
import { findInstalledExtensions, registerNativeHost, registeredIds } from '../../bridge/register.mjs';
import type { ExtensionStatus, SkillSummary, UiMessage } from './ipc';

const here = dirname(fileURLToPath(import.meta.url));

// 묶어 낸 앱에서는 오피스 도구를 앱 자원 폴더에 둔다.
if (app.isPackaged && !process.env.DOGENT_OFFICE_EXE) {
  const exe = join(process.resourcesPath, 'dogent-office.exe');
  if (existsSync(exe)) process.env.DOGENT_OFFICE_EXE = exe;
}

/**
 * 브라우저가 이 앱과 말하는 길(Native Messaging 호스트)을 이 PC에 깔고, 설치된 Dogent 확장을 허용한다.
 * 호스트는 앱 자신을 Node처럼 돌려(ELECTRON_RUN_AS_NODE) 쓰므로 PC에 Node가 없어도 된다.
 * 휴대용 실행본은 실행할 때마다 임시 폴더로 풀리므로 원래 파일 경로(PORTABLE_EXECUTABLE_FILE)를 적는다.
 */
function setupExtensionLink(extraId?: string): ExtensionStatus {
  try {
    const found = findInstalledExtensions();
    const ids = [...found.map((f) => f.id), ...(extraId ? [extraId] : [])];
    // Dogent 확장의 ID는 정해져 있어 확장을 아직 로드하지 않았어도 등록해 둔다 (나중에 로드하면 바로 붙는다).
    // 앱 위치가 바뀌었을 수 있으므로 매번 새로 쓴다 (레지스트리 한 줄이라 가볍다).
    registerNativeHost({ ids, runtime: process.env.PORTABLE_EXECUTABLE_FILE || process.execPath, hostDir: join(here, 'host') });
    const now = new Set(registeredIds());
    return { ids: [...now], missing: found.filter((f) => !now.has(f.id)).map((f) => ({ id: f.id, browser: f.browser })) };
  } catch (e) {
    return { ids: registeredIds(), missing: [], error: (e as Error).message };
  }
}

let win: BrowserWindow | null = null;

/** 세션의 묻기·출력을 창으로 보낸다. 답은 창에서 dogent:answer로 온다. */
class WindowUi implements Ui {
  private nextId = 1;
  private waiting = new Map<number, (value: string | null) => void>();

  send(message: UiMessage): void {
    win?.webContents.send('dogent:ui', message);
  }

  private prompt(mode: 'text' | 'confirm', question: string, fallback: string): Promise<string | null> {
    const id = this.nextId++;
    this.send({ kind: 'ask', id, mode, question: question.replace(/[\s>]+$/, '').replace(/:$/, '').trim(), fallback });
    return new Promise((resolve) => this.waiting.set(id, resolve));
  }

  answer(id: number, value: string | null): void {
    this.waiting.get(id)?.(value);
    this.waiting.delete(id);
  }

  /** 멈추면 기다리던 질문은 모두 그만둔 것으로 */
  cancelAll(): void {
    for (const [id, resolve] of this.waiting) {
      resolve(null);
      this.send({ kind: 'ask-closed', id });
    }
    this.waiting.clear();
  }

  print(text: string): void {
    this.send({ kind: 'print', text });
  }

  ask(question: string): Promise<string | null> {
    return this.prompt('text', question, '');
  }

  async confirm(question: string, fallback: boolean): Promise<boolean> {
    const a = await this.prompt('confirm', question, fallback ? 'y' : 'n');
    return a === null ? false : a === 'y';
  }

  async askDefault(question: string, fallback: string): Promise<string> {
    const a = await this.prompt('text', question, fallback);
    return (a ?? '').trim() || fallback;
  }

  started(skill: string, page: string): void {
    this.send({ kind: 'started', skill, page });
  }

  runEvent(event: RunEvent): void {
    this.send({ kind: 'run', event });
  }

  approval(request: Parameters<NonNullable<Ui['approval']>>[0]): void {
    this.send({ kind: 'approval', request });
  }

  result(result: Parameters<NonNullable<Ui['result']>>[0], saved: string[]): void {
    this.send({ kind: 'result', result, saved });
  }
}

const ui = new WindowUi();
const options: SessionOptions = { yes: false, allowWrite: false, dryRun: false, waitSec: 60 };
let session = new Session(ui, loadConfig(), options);
let busy = false;

/** 설정을 바꾸면 세션을 새로 만든다 (실행 중이 아닐 때) */
async function renewSession(): Promise<void> {
  await session.close();
  session = new Session(ui, loadConfig(), options);
  await session.listen().catch((e: Error) => ui.print(`오류: ${e.message}`));
}

async function work(job: () => Promise<unknown>): Promise<void> {
  if (busy) return ui.print('지금 하는 일이 끝난 뒤에 다시 시켜 주세요 (멈추려면 중지).');
  busy = true;
  ui.send({ kind: 'busy', busy: true });
  try {
    await job();
  } catch (e) {
    ui.print(`오류: ${(e as Error).message}`);
  } finally {
    busy = false;
    ui.send({ kind: 'busy', busy: false });
  }
}

function skillSummaries(): SkillSummary[] {
  const stats = session.runStats();
  return session.skillList().map((e) => ({
    id: e.skill.id,
    name: e.skill.name,
    description: e.skill.description,
    risk: e.skill.risk,
    source: e.source,
    owner: e.skill.owner,
    tags: e.skill.tags,
    domains: e.skill.domains,
    stats: (() => {
      const s = stats.get(e.skill.id);
      return s ? { runs: s.runs, rate: s.rate, broken: s.broken } : undefined;
    })(),
    inputs: e.skill.inputs.map((i) => ({
      name: i.name,
      label: i.label ?? i.name,
      type: i.type,
      required: i.required,
      description: i.description ?? '',
      values: i.values ?? [],
      default: i.default === undefined ? '' : String(i.default),
    })),
  }));
}

ipcMain.handle('dogent:init', () => ({
  mode: __DOGENT_BUILD__.mode,
  version: __DOGENT_BUILD__.version,
  config: describeConfig(loadConfig()),
  skills: skillSummaries(),
  browsers: session.browsersNow(),
  options,
}));
ipcMain.handle('dogent:send', (_e, text: string) => work(() => session.handle(text.trim())));
ipcMain.handle('dogent:run', (_e, id: string, values: Record<string, string>) =>
  work(() => session.runSkillById(id, Object.entries(values).filter(([, v]) => v !== '').map(([k, v]) => `${k}=${v}`))),
);
ipcMain.handle('dogent:answer', (_e, id: number, value: string | null) => ui.answer(id, value));
ipcMain.handle('dogent:stop', () => {
  session.interrupt();
  ui.cancelAll();
});
ipcMain.handle('dogent:skills', () => skillSummaries());
ipcMain.handle('dogent:systems', () => session.systemList().map((e) => ({ id: e.system.id, name: e.system.name, description: e.system.description, aliases: e.system.aliases, url: e.system.url, source: e.source, skills: session.skillList().filter((k) => skillCoversUrl(docOfSkill(k.skill), e.system.url)).length })));
ipcMain.handle('dogent:page', () => session.currentPage());
ipcMain.handle('dogent:browsers', () => session.browsersNow());
ipcMain.handle('dogent:select-browser', (_e, which: string) => work(() => session.useBrowser(which)));
ipcMain.handle('dogent:excel-docs', async () => (await session.officeTool()).userWorkbooks());
ipcMain.handle('dogent:show', (_e, path: string) => shell.showItemInFolder(path));
// 결과 HTML 보고서를 기본 브라우저로 연다. 다른 종류의 파일은 열지 않는다
ipcMain.handle('dogent:open', async (_e, path: string) => {
  if (!/\.html$/i.test(path)) return;
  await shell.openPath(path);
});
ipcMain.handle('dogent:options', (_e, patch: Partial<SessionOptions>) => Object.assign(options, patch));
ipcMain.handle('dogent:token', () => loadToken());
ipcMain.handle('dogent:extension', (_e, register?: string) => setupExtensionLink(register?.trim() || undefined));
ipcMain.handle('dogent:set-config', async (_e, key: string, value: string) => {
  if (busy) throw new Error('실행 중에는 설정을 바꿀 수 없습니다');
  setConfig(key, value);
  await renewSession();
  return describeConfig(loadConfig());
});

ipcMain.handle('dogent:connectors', () => serverRows(loadMcpConfig()));
ipcMain.handle('dogent:connect-preview', (_e, text: string) => {
  const p = parsePasted(text);
  if (p.kind === 'skill') return p;
  const have = loadMcpConfig().servers;
  return { kind: 'mcp', servers: Object.entries(p.entries).map(([n, s]) => serverRow(n, s)), replaces: Object.keys(p.entries).filter((n) => have[n]), scope: p.scope };
});
ipcMain.handle('dogent:connect-add', async (_e, text: string) => {
  const p = parsePasted(text);
  if (p.kind !== 'mcp') throw new Error('커넥터가 아닌 내용입니다');
  addServers(p.entries);
  return Promise.all(Object.entries(p.entries).map(([n, s]) => probeServer(n, s)));
});
ipcMain.handle('dogent:connect-probe', (_e, name: string) => {
  const s = loadMcpConfig().servers[name];
  if (!s) throw new Error(`서버 "${name}"이(가) 없습니다`);
  return probeServer(name, s);
});
ipcMain.handle('dogent:connect-patch', (_e, name: string, patch: Parameters<typeof patchServer>[1]) => {
  patchServer(name, patch);
  return serverRows(loadMcpConfig());
});
ipcMain.handle('dogent:connect-remove', (_e, name: string) => {
  removeServer(name);
  return serverRows(loadMcpConfig());
});

function createWindow(): void {
  win = new BrowserWindow({
    width: 1200,
    height: 820,
    minWidth: 760,
    minHeight: 560,
    title: 'Dogent',
    backgroundColor: '#f4f6f9',
    icon: join(here, 'renderer/icon.png'),
    webPreferences: { preload: join(here, 'preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false },
  });
  win.setMenuBarVisibility(false);
  void win.loadFile(join(here, 'renderer/index.html'));
  // 창 안에서 다른 사이트로 가지 않는다. 링크는 기본 브라우저로 연다.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.on('closed', () => (win = null));
}

// 앱은 하나만 띄운다 (브리지 포트가 겹치지 않게).
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => {
    if (win?.isMinimized()) win.restore();
    win?.focus();
  });
  app.whenReady().then(async () => {
    if (process.platform === 'win32') setupExtensionLink();
    createWindow();
    // 브리지를 먼저 띄워 두면 브라우저 확장들이 미리 붙는다. 붙은 브라우저가 바뀌면 창에 알린다.
    await session.listen().catch((e: Error) => ui.print(`오류: ${e.message}`));
    // 팀 스킬 저장소를 받아 오면 창의 스킬 목록을 다시 읽게 한다 (한 시간마다)
    const team = () => void session.refreshTeam({ quiet: true }).then((m) => m && ui.send({ kind: 'skills' }));
    team();
    setInterval(() => !busy && team(), 60 * 60_000);
    let last = '';
    setInterval(() => {
      const list = session.browsersNow();
      const key = JSON.stringify(list);
      if (key !== last) {
        last = key;
        ui.send({ kind: 'browsers', browsers: list });
      }
    }, 1500);
  });
  app.on('window-all-closed', async () => {
    await session.close();
    app.quit();
  });
}
