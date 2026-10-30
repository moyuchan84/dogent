import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { ClientConfig } from '../client/src/config';
import type { Session as SessionType, Ui } from '../client/src/session';

const read = (p: string) => readFileSync(join(import.meta.dirname, '..', p), 'utf8');

let Session: typeof SessionType;
beforeAll(async () => {
  vi.stubGlobal('__DOGENT_SKILLS__', { 'wip-check/SKILL.md': read('skills/wip-check/SKILL.md'), 'wip-search/SKILL.md': read('skills/wip-search/SKILL.md') });
  vi.stubGlobal('__DOGENT_BUILD__', { mode: 'home', version: 'test' });
  ({ Session } = await import('../client/src/session'));
});

function ui(lines: string[]): Ui {
  return {
    print: (t) => lines.push(t),
    ask: async () => null,
    confirm: async () => true,
    askDefault: async (_q, f) => f,
  };
}

function config(baseUrl: string, bridgePort?: number): ClientConfig {
  const home = mkdtempSync(join(tmpdir(), 'dogent-stop-'));
  return {
    home,
    llm: { baseUrl, model: 'm', apiKey: 'k' } as ClientConfig['llm'],
    personalSkills: join(home, 'skills'),
    outputDir: join(home, 'out'),
    saveThroughExcel: false,
    bridgePort,
    file: join(home, 'config.json'),
  };
}

let server: Server | null = null;
let session: SessionType | null = null;
afterEach(async () => {
  await session?.close();
  server?.closeAllConnections();
  server?.close();
  server = session = null;
});

describe('중지 (Session.interrupt)', () => {
  it('요청을 해석하는 중에 중지하면 모델의 답을 기다리지 않고 바로 끝난다', async () => {
    // 답을 주지 않는 모델 API
    server = createServer(() => {});
    await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
    const port = (server.address() as { port: number }).port;
    const lines: string[] = [];
    session = new Session(ui(lines), config(`http://127.0.0.1:${port}/v1`), { yes: true, allowWrite: false, dryRun: false, waitSec: 30 });

    const run = session.request('재공 확인해 줘');
    await vi.waitFor(() => expect(lines).toContain('요청을 해석하는 중…'));
    const t = Date.now();
    expect(session.interrupt()).toBe(true);
    expect(await run).toBe(false);
    expect(Date.now() - t).toBeLessThan(2000);
    expect(lines).toContain('중지했습니다.');
    expect(lines.some((l) => l.startsWith('요청을 해석하지 못했습니다'))).toBe(false);
    // 끝난 뒤에는 멈출 일이 없다
    expect(session.interrupt()).toBe(false);
  });

  it('확장이 연결되기를 기다리는 중에 중지하면 기다림을 그만둔다', async () => {
    const lines: string[] = [];
    session = new Session(ui(lines), config('http://127.0.0.1:9/v1', 40000 + Math.floor(Math.random() * 20000)), { yes: true, allowWrite: false, dryRun: false, waitSec: 30 });
    const run = session.handle('tabs');
    await new Promise((r) => setTimeout(r, 300));
    const t = Date.now();
    expect(session.interrupt()).toBe(true);
    await run;
    expect(Date.now() - t).toBeLessThan(2000);
    expect(lines).toContain('중지했습니다.');
  });
});
