import { promises as nodeFs } from 'node:fs';
import { homedir } from 'node:os';
import { basename, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { UPLOAD_DEFAULT_MAX_BYTES, UPLOAD_HARD_MAX_BYTES, formatBytes, sensitivePathReason, type UploadSource } from '../../src/core';

/**
 * 파일 올리기에서 클라이언트가 지키는 통제 (docs/09 D6). 확장이 PC의 파일을 읽을 수 없으므로 클라이언트가 파일을 읽어 보낸다.
 * 어떤 파일이 나가는지는 여기서 정한다: 올릴 수 있는 폴더(uploadDirs) 안의 일반 파일만, 크기 상한 안에서, 숨김·키 파일은 빼고.
 * (사용자 승인과 조작할 사이트 확인은 확장이 따로 한다. 이 검사는 승인 창을 띄우기 전에 걸러 낸다.)
 */

/** 파일 시스템 접근. 시험에서 바꿔 끼울 수 있게 뺐다. */
export interface UploadFs {
  realpath(path: string): Promise<string>;
  stat(path: string): Promise<{ isFile(): boolean; size: number }>;
  readFile(path: string): Promise<Uint8Array>;
}

export const nodeUploadFs: UploadFs = {
  realpath: (p) => nodeFs.realpath(p),
  stat: (p) => nodeFs.stat(p),
  readFile: (p) => nodeFs.readFile(p),
};

export interface UploadPolicy {
  /** 올릴 수 있는 폴더들 */
  dirs: string[];
  /** 올릴 수 있는 파일의 최대 크기(바이트). 확장의 절대 상한(UPLOAD_HARD_MAX_BYTES)을 넘길 수 없다 */
  maxBytes?: number;
}

/** 기본으로 올릴 수 있는 폴더: 결과 저장 폴더, 내려받기, 문서, 바탕 화면 */
export function defaultUploadDirs(outputDir: string, home = homedir()): string[] {
  return [...new Set([outputDir, join(home, 'Downloads'), join(home, 'Documents'), join(home, 'Desktop')])];
}

/** root 안(root 자신 제외)에 있는지. 다른 드라이브면 relative가 절대 경로로 나온다. */
function inside(root: string, target: string): string | null {
  const rel = relative(root, target);
  if (rel === '' || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return null;
  return rel;
}

export interface CheckedUpload {
  /** 심볼릭 링크를 풀어 얻은 실제 경로 */
  real: string;
  name: string;
  size: number;
}

/**
 * 올릴 파일의 경로를 검사한다. 어기면 이유를 담아 던진다.
 * - 절대 경로여야 한다 (~로 시작하면 사용자 폴더로 푼다).
 * - `..`, 심볼릭 링크(정션 포함), 다른 드라이브로 올릴 수 있는 폴더를 빠져나가지 못하게 realpath로 푼 실제 경로를 본다.
 * - 일반 파일이고 크기 상한 이하여야 한다.
 * - 숨김·시스템·키 파일은 올리지 않는다.
 */
export async function checkUploadPath(raw: string, policy: UploadPolicy, fs: UploadFs = nodeUploadFs, home = homedir()): Promise<CheckedUpload> {
  const text = raw.trim().replace(/^~(?=$|[\\/])/, home);
  if (text === '') throw new Error('올릴 파일 경로가 비어 있습니다');
  if (!isAbsolute(text)) throw new Error(`올릴 파일은 전체 경로(예: C:\\Users\\…\\Downloads\\파일.xlsx)로 적어야 합니다: ${raw}`);
  let real: string;
  try {
    real = await fs.realpath(resolve(text));
  } catch {
    throw new Error(`올릴 파일을 찾을 수 없습니다: ${raw}`);
  }
  let rel: string | null = null;
  for (const dir of policy.dirs) {
    const root = await fs.realpath(resolve(dir)).catch(() => null);
    if (!root) continue;
    rel = inside(root, real);
    if (rel !== null) break;
  }
  if (rel === null) {
    throw new Error(`올릴 수 있는 폴더 밖의 파일입니다: ${raw}. 올릴 수 있는 폴더: ${policy.dirs.join(', ')} (dogent config uploadDirs 로 바꿉니다)`);
  }
  const bad = sensitivePathReason(real, rel);
  if (bad) throw new Error(bad);
  const info = await fs.stat(real);
  if (!info.isFile()) throw new Error(`파일이 아닙니다: ${raw}`);
  const max = Math.min(policy.maxBytes ?? UPLOAD_DEFAULT_MAX_BYTES, UPLOAD_HARD_MAX_BYTES);
  if (info.size === 0) throw new Error(`빈 파일은 올리지 않습니다: ${raw}`);
  if (info.size > max) throw new Error(`파일이 너무 큽니다 (${formatBytes(info.size)}, 상한 ${formatBytes(max)}). dogent config uploadMaxMb 로 바꿀 수 있습니다`);
  return { real, name: basename(real), size: info.size };
}

const MIME: Record<string, string> = {
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.xls': 'application/vnd.ms-excel',
  '.csv': 'text/csv',
  '.txt': 'text/plain',
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.zip': 'application/zip',
  '.json': 'application/json',
};

/** 검사를 통과한 파일을 읽는다. 읽는 사이에 크기가 달라졌으면 다시 검사한다. */
export async function readUploadFile(raw: string, policy: UploadPolicy, fs: UploadFs = nodeUploadFs, home = homedir()): Promise<UploadSource> {
  const checked = await checkUploadPath(raw, policy, fs, home);
  const bytes = await fs.readFile(checked.real);
  const max = Math.min(policy.maxBytes ?? UPLOAD_DEFAULT_MAX_BYTES, UPLOAD_HARD_MAX_BYTES);
  if (bytes.length === 0 || bytes.length > max) throw new Error(`파일 크기가 검사한 뒤에 달라졌습니다. 다시 시도하세요: ${raw}`);
  return { name: checked.name, mime: MIME[extname(checked.name).toLowerCase()] ?? 'application/octet-stream', bytes };
}
