import type { Screenshot } from './types';

/**
 * 파일 올리기(upload_file)와 화면 그림(screenshot)이 클라이언트와 확장 양쪽에서 같이 쓰는 값과 검사 (docs/09 D6).
 * 브라우저와 Node 모두에서 돈다 (파일 시스템은 건드리지 않는다).
 */

/** 확장이 받아 주는 파일 크기의 절대 상한. 클라이언트의 설정(uploadMaxMb)이 이보다 커도 확장이 거절한다. */
export const UPLOAD_HARD_MAX_BYTES = 30 * 1024 * 1024;
/** 클라이언트가 기본으로 허용하는 파일 크기 */
export const UPLOAD_DEFAULT_MAX_BYTES = 10 * 1024 * 1024;
/**
 * 파일을 확장에 나눠 보낼 때 한 조각의 크기(원본 바이트).
 * Native Messaging은 호스트가 브라우저로 보내는 메시지를 1MB로 제한하므로, base64로 늘어도 이보다 작아야 한다.
 * 3의 배수여야 한다: 조각마다 따로 base64로 만들어 이어 붙이므로 중간 조각에 패딩(=)이 생기면 안 된다.
 */
export const UPLOAD_CHUNK_BYTES = Math.floor((512 * 1024) / 3) * 3;

/** 화면 그림의 긴 변 상한(픽셀)과 base64 글자 수 상한 */
/** 파일 올리기 승인 창의 버튼 이름. 승인 창이 올리기 요청임을 알아보는 데 쓴다 */
export const UPLOAD_BUTTON = '파일 올리기';

export const SHOT_MAX_SIDE = 1280;
export const SHOT_MAX_BASE64 = 1_500_000;

/** 올리지 않는 확장자 (키·인증서·자격 증명) */
const SECRET_EXT = /\.(pem|key|pfx|p12|ppk|jks|keystore|kdbx|gpg|asc|env)$/i;
/** 올리지 않는 파일 이름 (확장자 없는 키 파일, 접속 정보) */
const SECRET_NAME =
  /^(id_(rsa|dsa|ecdsa|ed25519)(\.pub)?|known_hosts|authorized_keys|credentials|secrets?(\.\w+)?|npmrc|netrc|pgpass|ntuser\.dat.*|desktop\.ini|thumbs\.db)$/i;
/** 이 이름의 폴더 안에 있으면 올리지 않는다 */
const SECRET_DIRS = new Set([
  '.ssh',
  '.gnupg',
  '.aws',
  '.azure',
  '.kube',
  '.docker',
  'appdata',
  'programdata',
  'windows',
  'system32',
  '$recycle.bin',
  'system volume information',
  '.git',
  '.dogent',
]);

/** 올릴 수 없는 파일 이름이면 이유를 돌려준다. 이름만 본다 (폴더는 {@link sensitivePathReason}). */
export function sensitiveNameReason(name: string): string | null {
  const base = name.split(/[\\/]/).pop() ?? name;
  if (base === '') return '파일 이름이 비어 있습니다';
  if (base.startsWith('.')) return `숨김 파일(${base})은 올리지 않습니다`;
  if (SECRET_EXT.test(base) || SECRET_NAME.test(base)) return `키·접속 정보로 보이는 파일(${base})은 올리지 않습니다`;
  return null;
}

/**
 * 경로에서 올릴 수 없는 이유를 찾는다. 올릴 수 있는 폴더(root)보다 안쪽의 숨김 폴더·키·시스템 폴더와 파일 이름을 막는다.
 * full은 파일의 실제 경로, rel은 root에서 파일까지의 상대 경로다.
 */
export function sensitivePathReason(full: string, rel: string): string | null {
  // 올릴 수 있는 폴더 자신의 위치는 사용자가 정한 것이므로, 그 안쪽 경로(rel)만 본다.
  const inner = rel.split(/[\\/]/).filter(Boolean);
  for (const p of inner.slice(0, -1)) {
    if (p.startsWith('.')) return `숨김 폴더(${p}) 안의 파일은 올리지 않습니다`;
    if (SECRET_DIRS.has(p.toLowerCase())) return `${p} 폴더 안의 파일은 올리지 않습니다`;
  }
  return sensitiveNameReason(full.split(/[\\/]/).filter(Boolean).at(-1) ?? '');
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
  return `${(n / 1024 / 1024).toFixed(1)}MB`;
}

/** 긴 변이 max를 넘으면 비율을 지켜 줄인 크기. 이미 작으면 그대로 */
export function fitSize(width: number, height: number, max = SHOT_MAX_SIDE): { width: number; height: number } {
  const long = Math.max(width, height);
  if (long <= max) return { width, height };
  const scale = max / long;
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

/** 그림을 모델에 붙일 data URL로 */
export const shotDataUrl = (s: Screenshot): string => `data:${s.mimeType};base64,${s.base64}`;

/** Uint8Array → base64. 확장(브라우저)과 Node 모두에서 돈다. */
export function bytesToBase64(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

/** base64 글자 수로 원본 바이트 수를 어림한다 (패딩 반영) */
export function base64Bytes(b64: string): number {
  const pad = b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0;
  return Math.floor((b64.length * 3) / 4) - pad;
}
