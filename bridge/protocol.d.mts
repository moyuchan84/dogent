export const PROTOCOL_VERSION: number;
export const DEFAULT_PORT: number;
export const NATIVE_HOST_NAME: string;
export function pipePath(user?: string): string;
export function randomNonce(): string;
export function hmac(token: string, message: string): Promise<string>;
export function sameText(a: unknown, b: unknown): boolean;

export type BridgeMessage =
  | { type: 'challenge'; nonce: string }
  | { type: 'auth'; proof: string; nonce: string; version: number }
  | { type: 'welcome'; proof: string; version: number }
  | { type: 'call'; id: number; tool: string; args: Record<string, unknown> }
  | { type: 'result'; id: number; ok: true; text: string }
  | { type: 'result'; id: number; ok: false; error: string }
  | { type: 'status'; state: string; detail?: string }
  /** 확인을 마친 뒤 확장이 알리는 브라우저 이름과, 같은 브라우저인지 가리는 값(설치마다 다름) */
  | { type: 'hello'; browser: string; key: string }
  | { type: 'ping' }
  | { type: 'pong' };

export function answerChallenge(
  token: string,
  challenge: { nonce: string },
): Promise<{ reply: Extract<BridgeMessage, { type: 'auth' }>; expect: string }>;
export function acceptAuth(token: string, nonce: string, auth: unknown): Promise<Extract<BridgeMessage, { type: 'welcome' }> | null>;
export function encodeNative(message: unknown): Buffer;
export function nativeReader(onMessage: (m: any) => void): (chunk: Buffer) => void;
export function lineReader(onMessage: (m: any) => void): (chunk: Buffer | string) => void;
