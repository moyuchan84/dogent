import { describe, expect, it } from 'vitest';
import { OpenAiCompatClient, buildHeaders, headerPlaceholders, type LlmSettings } from '../src/core';

const base: LlmSettings = {
  baseUrl: 'https://gw.example.internal/v1/',
  apiKey: 'cred-123',
  model: 'gemma-3',
  jsonMode: false,
  timeoutScale: 1,
  skillDirect: true,
  pathCache: true,
  skillsUrl: '',
};

/** 사내 게이트웨이 예시: 키와 사용자는 헤더로, 메시지 ID는 요청마다 새로 */
const gateway = {
  'x-dep-ticket': '{key}',
  'Send-System-Name': 'Dogent',
  'User-Id': '{userId}',
  'User-Type': '{userType}',
  'Prompt-Msg-Id': '{uuid}',
  'Completion-Msg-Id': '{uuid}',
  Accept: 'application/json',
};

describe('모델 API 헤더', () => {
  it('헤더 틀이 없으면 OpenAI 방식 Bearer 키', () => {
    expect(buildHeaders(base)).toEqual({ 'Content-Type': 'application/json', Authorization: 'Bearer cred-123' });
    expect(buildHeaders({ ...base, apiKey: '' })).toEqual({ 'Content-Type': 'application/json' });
  });

  it('헤더 틀의 자리표시자를 채우고 Authorization은 보내지 않는다', () => {
    let n = 0;
    const headers = buildHeaders({ ...base, headers: gateway, userId: 'hong.gd', userType: 'AD' }, () => `id-${++n}`);
    expect(headers).toEqual({
      'x-dep-ticket': 'cred-123',
      'Send-System-Name': 'Dogent',
      'User-Id': 'hong.gd',
      'User-Type': 'AD',
      'Prompt-Msg-Id': 'id-1',
      'Completion-Msg-Id': 'id-2',
      Accept: 'application/json',
      'Content-Type': 'application/json',
    });
  });

  it('틀에 Content-Type이 있으면 대소문자가 달라도 하나만 보낸다', () => {
    const headers = buildHeaders({ ...base, headers: { 'content-type': 'application/json; charset=utf-8' } });
    expect(headers).toEqual({ 'content-type': 'application/json; charset=utf-8' });
  });

  it('비어 있는 값은 요청 전에 무엇을 채울지 알린다', () => {
    expect(() => buildHeaders({ ...base, headers: gateway, userType: 'AD' })).toThrow(/사용자 ID.*설정에서 입력/);
    expect(() => buildHeaders({ ...base, apiKey: '', headers: gateway, userId: 'a', userType: 'b' })).toThrow(/API 키/);
  });

  it('헤더 값에 한글이 들어가면 거절한다', () => {
    expect(() => buildHeaders({ ...base, headers: { 'User-Id': '{userId}' }, userId: '홍길동' })).toThrow(/User-Id/);
  });

  it('틀이 쓰는 자리표시자를 알려 준다 (설정 화면의 입력 칸)', () => {
    expect([...headerPlaceholders(gateway)].sort()).toEqual(['key', 'userId', 'userType', 'uuid']);
    expect(headerPlaceholders(undefined).size).toBe(0);
  });
});

describe('OpenAiCompatClient', () => {
  it('헤더 틀대로 /chat/completions를 부르고 요청마다 새 UUID를 쓴다', async () => {
    const calls: { url: string; headers: Record<string, string>; body: any }[] = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      calls.push({ url, headers: init.headers as Record<string, string>, body: JSON.parse(init.body as string) });
      return new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }));
    }) as typeof fetch;
    const client = new OpenAiCompatClient({ ...base, headers: gateway, userId: 'hong.gd', userType: 'AD' }, fetchImpl);
    expect(await client.complete([{ role: 'user', content: '안녕' }])).toBe('ok');
    await client.complete([{ role: 'user', content: '안녕' }]);
    expect(calls[0].url).toBe('https://gw.example.internal/v1/chat/completions');
    expect(calls[0].headers['x-dep-ticket']).toBe('cred-123');
    expect(calls[0].headers.Authorization).toBeUndefined();
    expect(calls[0].body.model).toBe('gemma-3');
    expect(calls[0].headers['Prompt-Msg-Id']).toMatch(/^[0-9a-f-]{36}$/);
    expect(calls[0].headers['Prompt-Msg-Id']).not.toBe(calls[0].headers['Completion-Msg-Id']);
    expect(calls[1].headers['Prompt-Msg-Id']).not.toBe(calls[0].headers['Prompt-Msg-Id']);
  });

  it('네트워크에 닿지 못하면 주소와 확인할 것을 알린다', async () => {
    const fetchImpl = (async () => {
      throw new TypeError('Failed to fetch');
    }) as unknown as typeof fetch;
    await expect(new OpenAiCompatClient(base, fetchImpl).complete([{ role: 'user', content: 'x' }])).rejects.toThrow(
      /닿지 못했습니다 \(https:\/\/gw\.example\.internal\/v1\/chat\/completions\).*다시 빌드/,
    );
  });

  it('API 오류는 상태 코드와 본문을 보여 준다', async () => {
    const fetchImpl = (async () => new Response('invalid ticket', { status: 401 })) as unknown as typeof fetch;
    await expect(new OpenAiCompatClient(base, fetchImpl).complete([{ role: 'user', content: 'x' }])).rejects.toThrow(
      '모델 API 오류 401: invalid ticket',
    );
  });
});
