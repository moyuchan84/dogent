// 브리지(bridge/hub.mjs)와 크롬 확장이 주고받는 메시지의 약속. 양쪽이 이 파일 하나를 같이 쓴다.
// Node와 브라우저 모두에 있는 WebCrypto만 쓴다.
//
// 연결 순서 (WebSocket이든 Native Messaging이든 같다)
//   브리지 → 확장  { type: 'challenge', nonce }
//   확장 → 브리지  { type: 'auth', proof: HMAC(토큰, 'extension:' + nonce), nonce: 확장의 난수, version }
//   브리지 → 확장  { type: 'welcome', proof: HMAC(토큰, 'bridge:' + 확장의 난수) }
//   양쪽이 상대의 proof를 확인해야 연결된다. 토큰 자체는 오가지 않는다.
// 그 뒤
//   브리지 → 확장  { type: 'call', id, tool, args }
//   확장 → 브리지  { type: 'result', id, ok: true, text } | { type: 'result', id, ok: false, error }
//   양쪽          { type: 'ping' } / { type: 'pong' }

export const PROTOCOL_VERSION = 1;
export const DEFAULT_PORT = 39217;
export const NATIVE_HOST_NAME = 'com.dogent.bridge';
/** 브리지가 native host를 기다리는 파이프. 같은 사용자만 붙을 수 있게 사용자 이름을 붙인다. */
export function pipePath(user) {
  const safe = String(user || 'user').replace(/[^A-Za-z0-9_.-]/g, '_');
  return process.platform === 'win32' ? `\\\\.\\pipe\\dogent-bridge-${safe}` : `/tmp/dogent-bridge-${safe}.sock`;
}

const enc = new TextEncoder();
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');

export function randomNonce() {
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  return hex(b);
}

export async function hmac(token, message) {
  const key = await crypto.subtle.importKey('raw', enc.encode(token), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return hex(await crypto.subtle.sign('HMAC', key, enc.encode(message)));
}

/** 같은 길이의 두 문자열을 시간 차 없이 비교한다. */
export function sameText(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** 확장 쪽: challenge에 답한다. 돌려준 nonce로 브리지의 welcome을 확인한다. */
export async function answerChallenge(token, challenge) {
  const nonce = randomNonce();
  return {
    reply: { type: 'auth', proof: await hmac(token, `extension:${challenge.nonce}`), nonce, version: PROTOCOL_VERSION },
    expect: await hmac(token, `bridge:${nonce}`),
  };
}

/** 브리지 쪽: 확장의 auth를 확인하고 welcome을 만든다. 틀리면 null. */
export async function acceptAuth(token, nonce, auth) {
  if (!auth || auth.type !== 'auth' || typeof auth.nonce !== 'string') return null;
  if (!sameText(auth.proof, await hmac(token, `extension:${nonce}`))) return null;
  return { type: 'welcome', proof: await hmac(token, `bridge:${auth.nonce}`), version: PROTOCOL_VERSION };
}

/** 크롬 Native Messaging의 틀: 4바이트(리틀 엔디언) 길이 + UTF-8 JSON */
export function encodeNative(message) {
  const body = Buffer.from(JSON.stringify(message), 'utf8');
  const head = Buffer.alloc(4);
  head.writeUInt32LE(body.length, 0);
  return Buffer.concat([head, body]);
}

/** 받은 바이트를 쌓아 두었다가 완성된 메시지를 꺼낸다. */
export function nativeReader(onMessage) {
  let buf = Buffer.alloc(0);
  return (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    while (buf.length >= 4) {
      const len = buf.readUInt32LE(0);
      if (buf.length < 4 + len) break;
      const body = buf.subarray(4, 4 + len).toString('utf8');
      buf = buf.subarray(4 + len);
      onMessage(JSON.parse(body));
    }
  };
}

/** 줄 단위 JSON (파이프와 MCP stdio) */
export function lineReader(onMessage) {
  let rest = '';
  return (chunk) => {
    rest += chunk.toString('utf8');
    let i;
    while ((i = rest.indexOf('\n')) >= 0) {
      const line = rest.slice(0, i).trim();
      rest = rest.slice(i + 1);
      if (line) onMessage(JSON.parse(line));
    }
  };
}
