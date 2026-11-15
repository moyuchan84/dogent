import { isAbsolute } from 'node:path';
import { nodeUploadFs, type UploadFs } from './upload';

/** 내려받은 파일로 읽는 최대 크기. 확장이 같은 주소를 다시 받을 때의 상한(src/ext/browser.ts)과 같다. */
export const DOWNLOAD_MAX_BYTES = 30 * 1024 * 1024;

/**
 * 브라우저가 PC에 저장한 내려받은 파일을 읽는다 (download_table).
 * 경로는 토큰으로 확인된 확장이 브라우저의 내려받기 기록(chrome.downloads)에서 알려 준 것이다.
 * 그래도 절대 경로의 일반 파일만, 크기 상한 안에서만 읽는다.
 */
export async function readDownloadedFile(path: string, fs: UploadFs = nodeUploadFs): Promise<Uint8Array> {
  if (!path || !isAbsolute(path)) throw new Error(`내려받은 파일의 경로가 올바르지 않습니다: ${path}`);
  const real = await fs.realpath(path).catch(() => {
    throw new Error(`내려받은 파일을 찾지 못했습니다 (옮겨졌거나 지워짐): ${path}`);
  });
  const st = await fs.stat(real);
  if (!st.isFile()) throw new Error(`내려받은 것이 파일이 아닙니다: ${path}`);
  if (st.size > DOWNLOAD_MAX_BYTES) throw new Error(`내려받은 파일이 너무 큽니다 (${Math.round(st.size / 1e6)}MB)`);
  return fs.readFile(real);
}
