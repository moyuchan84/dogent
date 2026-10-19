// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { createHub } from '../bridge/hub.mjs';
import { acceptAuth, answerChallenge, encodeNative, nativeReader, randomNonce } from '../bridge/protocol.mjs';

describe('브리지 연결 약속', () => {
  it('같은 토큰이면 서로를 확인하고, 다르면 거절한다', async () => {
    const nonce = randomNonce();
    const { reply, expect: want } = await answerChallenge('secret', { nonce });
    const welcome = await acceptAuth('secret', nonce, reply);
    expect(welcome?.proof).toBe(want);
    expect(await acceptAuth('other', nonce, reply)).toBeNull();
    // 브리지인 척하는 프로그램은 확장의 난수에 맞는 증명을 만들 수 없다.
    const fake = await acceptAuth('guess', nonce, (await answerChallenge('guess', { nonce })).reply);
    expect(fake?.proof).not.toBe(want);
  });

  it('Native Messaging 틀(4바이트 길이 + JSON)을 나눠 받아도 메시지를 맞춘다', () => {
    const got: unknown[] = [];
    const read = nativeReader((m) => got.push(m));
    const bytes = Buffer.concat([encodeNative({ type: 'ping' }), encodeNative({ type: 'call', id: 1, tool: '한글', args: {} })]);
    read(bytes.subarray(0, 3));
    read(bytes.subarray(3, 20));
    read(bytes.subarray(20));
    expect(got).toEqual([{ type: 'ping' }, { type: 'call', id: 1, tool: '한글', args: {} }]);
  });
});

describe('브리지 (MCP ↔ 확장)', () => {
  const hubs: { close(): void }[] = [];
  afterEach(() => hubs.splice(0).forEach((h) => h.close()));

  async function startHub(port: number) {
    const hub = createHub({ token: 'tok', port, pipe: `\\\\.\\pipe\\dogent-test-${port}` });
    hubs.push(hub);
    await hub.ready;
    return hub;
  }

  /** 확장 흉내: 확인 절차를 마치고 도구 호출에 답한다. */
  function fakeExtension(port: number, token: string, answer: (tool: string) => string, hello?: { browser: string; key: string }) {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`, { origin: 'chrome-extension://abcdefghijklmnopabcdefghijklmnop' });
    let expected = '';
    ws.on('message', async (data) => {
      const msg = JSON.parse(String(data));
      if (msg.type === 'challenge') {
        const a = await answerChallenge(token, msg);
        expected = a.expect;
        ws.send(JSON.stringify(a.reply));
      } else if (msg.type === 'welcome') {
        expect(msg.proof).toBe(expected);
        if (hello) ws.send(JSON.stringify({ type: 'hello', ...hello }));
      } else if (msg.type === 'call') {
        ws.send(JSON.stringify({ type: 'result', id: msg.id, ok: true, text: answer(msg.tool) }));
      }
    });
    return ws;
  }

  const until = async (fn: () => boolean) => {
    for (let i = 0; i < 100 && !fn(); i++) await new Promise((r) => setTimeout(r, 20));
  };

  it('MCP 도구 호출을 확장에 넘기고 답을 돌려준다', async () => {
    const hub = await startHub(39351);
    const ws = fakeExtension(39351, 'tok', (tool) => `${tool} 결과`);
    await until(() => hub.connected() !== null);
    expect(hub.connected()).toBe('WebSocket');
    const init = await hub.handleMcp({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } });
    expect(init?.result.serverInfo.name).toBe('dogent-browser');
    const res = await hub.handleMcp({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'snapshot', arguments: {} } });
    expect(res?.result).toEqual({ content: [{ type: 'text', text: 'snapshot 결과' }] });
    const unknown = await hub.handleMcp({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'rm_rf', arguments: {} } });
    expect(unknown?.error?.message).toMatch(/모르는 도구/);
    ws.close();
  });

  it('크롬과 엣지가 함께 붙으면 둘 다 두고, 고른 브라우저로만 도구를 보낸다', async () => {
    const hub = await startHub(39354);
    const call = async (name: string, args: Record<string, unknown> = {}) => {
      const r = await hub.handleMcp({ jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name, arguments: args } });
      return { text: r?.result.content[0].text as string, error: !!r?.result.isError };
    };
    const chrome = fakeExtension(39354, 'tok', () => '크롬의 탭', { browser: 'Google Chrome 141', key: 'k-chrome' });
    await until(() => hub.browsers()[0]?.browser === 'Google Chrome 141');
    const edge = fakeExtension(39354, 'tok', () => '엣지의 탭', { browser: 'Microsoft Edge 141', key: 'k-edge' });
    await until(() => hub.browsers().length === 2 && hub.browsers()[1].browser === 'Microsoft Edge 141');

    // 고르지 않았으면 가장 나중에 붙은 브라우저
    expect((await call('tabs_list')).text).toBe('엣지의 탭');
    expect((await call('browsers_list')).text).toMatch(/\[1\] Google Chrome 141 — WebSocket\n\[2\] \(사용 중\) Microsoft Edge 141/);
    // 이름 일부로 고른다
    expect((await call('browser_select', { browser: 'chrome' })).text).toBe('[1] Google Chrome 141을(를) 씁니다');
    expect((await call('tabs_list')).text).toBe('크롬의 탭');
    expect((await call('browser_select', { browser: 'firefox' })).error).toBe(true);
    const tools = await hub.handleMcp({ jsonrpc: '2.0', id: 10, method: 'tools/list' });
    expect(tools?.result.tools.map((t: { name: string }) => t.name)).toEqual(expect.arrayContaining(['browsers_list', 'browser_select', 'snapshot']));

    // 같은 브라우저가 다시 붙으면 이전 연결을 대신하고, 고른 것도 이어 간다.
    const chrome2 = fakeExtension(39354, 'tok', () => '다시 붙은 크롬의 탭', { browser: 'Google Chrome 141', key: 'k-chrome' });
    await until(() => hub.browsers().length === 2 && hub.browsers()[1].browser === 'Google Chrome 141');
    expect(hub.browsers().map((b) => b.browser)).toEqual(['Microsoft Edge 141', 'Google Chrome 141']);
    expect((await call('tabs_list')).text).toBe('다시 붙은 크롬의 탭');

    // 고른 브라우저가 끊기면 남은 브라우저로
    chrome2.close();
    await until(() => hub.browsers().length === 1);
    expect((await call('tabs_list')).text).toBe('엣지의 탭');
    chrome.close();
    edge.close();
  });

  it('토큰이 다른 확장은 연결하지 않는다', async () => {
    const hub = await startHub(39352);
    const ws = fakeExtension(39352, 'wrong', () => '');
    const closed = new Promise((r) => ws.on('close', r));
    await closed;
    expect(hub.connected()).toBeNull();
  });

  it('확장이 아닌 곳(웹페이지)에서 온 WebSocket은 받지 않는다', async () => {
    await startHub(39353);
    const ws = new WebSocket('ws://127.0.0.1:39353', { origin: 'https://evil.example.com' });
    const status = await new Promise<number>((resolve) => ws.on('unexpected-response', (_req, res) => resolve(res.statusCode ?? 0)));
    expect(status).toBe(401);
  });
});
