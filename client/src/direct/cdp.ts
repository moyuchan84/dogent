import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Readable, Writable } from 'node:stream';

/**
 * 확장 없이 브라우저를 직접 다루는 길 (브라우저 연결 방식 "직접 제어").
 * 크롬·엣지를 Dogent 전용 프로필로 띄우고, 개발자 도구 프로토콜(CDP)을 파이프로 주고받는다.
 * 포트를 열지 않으므로(--remote-debugging-pipe) 이 PC의 다른 프로그램이 브라우저에 붙을 수 없다.
 */

type Handler = (method: string, params: any, sessionId?: string) => void;

export class CdpConnection {
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void; method: string }>();
  private handlers = new Set<Handler>();
  private buffer = '';
  closed = false;
  private onClose = new Set<() => void>();

  constructor(
    private out: Writable,
    input: Readable,
  ) {
    input.setEncoding('utf8');
    input.on('data', (chunk: string) => {
      this.buffer += chunk;
      for (let at = this.buffer.indexOf('\0'); at >= 0; at = this.buffer.indexOf('\0')) {
        const text = this.buffer.slice(0, at);
        this.buffer = this.buffer.slice(at + 1);
        if (text) this.receive(text);
      }
    });
    input.on('close', () => this.shutdown());
    input.on('error', () => this.shutdown());
    out.on('error', () => this.shutdown());
  }

  private receive(text: string): void {
    let msg: any;
    try {
      msg = JSON.parse(text);
    } catch {
      return;
    }
    if (typeof msg.id === 'number') {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.error) p.reject(new Error(`${p.method}: ${msg.error.message}`));
      else p.resolve(msg.result ?? {});
      return;
    }
    for (const h of this.handlers) {
      try {
        h(msg.method, msg.params ?? {}, msg.sessionId);
      } catch {
        /* 처리기 하나의 오류가 다른 처리기를 막지 않게 한다 */
      }
    }
  }

  private shutdown(): void {
    if (this.closed) return;
    this.closed = true;
    for (const p of this.pending.values()) p.reject(new Error('브라우저와의 연결이 끊겼습니다 (Dogent 브라우저 창이 닫혔을 수 있습니다)'));
    this.pending.clear();
    for (const f of this.onClose) f();
  }

  send<T = any>(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<T> {
    if (this.closed) return Promise.reject(new Error('브라우저와의 연결이 끊겼습니다 (Dogent 브라우저 창이 닫혔을 수 있습니다)'));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve, reject, method });
      this.out.write(`${JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })}\0`);
    });
  }

  on(handler: Handler): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  closed$(f: () => void): void {
    this.onClose.add(f);
  }
}

/** 브라우저 실행 파일을 찾는다. want에 edge가 들어 있으면 엣지를 먼저, 아니면 크롬을 먼저 본다. */
export function findBrowser(want?: string, env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform, exists = existsSync): { path: string; name: string } | null {
  const w = (want ?? '').toLowerCase();
  const edgeFirst = w.includes('edge') || w.includes('엣지');
  const chrome: string[] = [];
  const edge: string[] = [];
  if (platform === 'win32') {
    for (const base of [env.PROGRAMFILES, env['PROGRAMFILES(X86)'], env.LOCALAPPDATA]) {
      if (!base) continue;
      chrome.push(join(base, 'Google', 'Chrome', 'Application', 'chrome.exe'));
      edge.push(join(base, 'Microsoft', 'Edge', 'Application', 'msedge.exe'));
    }
  } else if (platform === 'darwin') {
    chrome.push('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
    edge.push('/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge');
  } else {
    chrome.push('/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser');
    edge.push('/usr/bin/microsoft-edge', '/usr/bin/microsoft-edge-stable');
  }
  const order = edgeFirst ? [...edge.map((p) => ({ path: p, name: 'Microsoft Edge' })), ...chrome.map((p) => ({ path: p, name: 'Google Chrome' }))] : [...chrome.map((p) => ({ path: p, name: 'Google Chrome' })), ...edge.map((p) => ({ path: p, name: 'Microsoft Edge' }))];
  return order.find((c) => exists(c.path)) ?? null;
}

export interface LaunchOptions {
  /** 설정의 browser 값 (edge, chrome …) */
  want?: string;
  /** 실행 파일 경로를 직접 줄 때 */
  executable?: string;
  /** Dogent 전용 프로필 폴더. 로그인이 여기에 남는다 */
  profileDir: string;
  headless?: boolean;
  /** 처음 열 주소 */
  startUrl?: string;
}

export interface Launched {
  cdp: CdpConnection;
  child: ChildProcess;
  name: string;
  close(): void;
}

/** 브라우저를 Dogent 전용 프로필로 띄우고 CDP로 잇는다. */
export async function launch(opts: LaunchOptions): Promise<Launched> {
  const found = opts.executable ? { path: opts.executable, name: '브라우저' } : findBrowser(opts.want);
  if (!found) throw new Error('크롬이나 엣지를 찾지 못했습니다. 설정의 browserPath에 실행 파일 경로를 넣으세요');
  mkdirSync(opts.profileDir, { recursive: true });
  const args = [
    '--remote-debugging-pipe',
    `--user-data-dir=${opts.profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-features=Translate',
    ...(opts.headless ? ['--headless=new'] : []),
    opts.startUrl ?? 'about:blank',
  ];
  // 3번은 브라우저가 명령을 읽는 쪽, 4번은 답을 쓰는 쪽이다.
  const child = spawn(found.path, args, { stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'], windowsHide: false });
  const out = child.stdio[3] as Writable | null;
  const input = child.stdio[4] as Readable | null;
  if (!out || !input) throw new Error('브라우저와 이을 파이프를 열지 못했습니다');
  const cdp = new CdpConnection(out, input);
  const exited = new Promise<never>((_, reject) => {
    child.once('error', (e) => reject(new Error(`브라우저를 띄우지 못했습니다: ${e.message}`)));
    child.once('exit', () =>
      reject(
        new Error(
          'Dogent 브라우저가 바로 닫혔습니다. 전에 띄운 Dogent 브라우저 창이 아직 열려 있으면(같은 프로필) 그 창을 모두 닫고 다시 시도하세요',
        ),
      ),
    );
  });
  // 브라우저가 답할 때까지 기다린다. 같은 프로필의 브라우저가 이미 떠 있으면 새 프로세스는 그쪽에 넘기고 곧 끝난다.
  await Promise.race([cdp.send('Browser.getVersion'), exited, new Promise((_, rej) => setTimeout(() => rej(new Error('브라우저가 30초 안에 답하지 않았습니다')), 30_000))]);
  return {
    cdp,
    child,
    name: found.name,
    close() {
      void cdp.send('Browser.close').catch(() => {});
      setTimeout(() => {
        if (child.exitCode === null) child.kill();
      }, 3000).unref();
    },
  };
}
