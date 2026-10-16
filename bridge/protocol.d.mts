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
