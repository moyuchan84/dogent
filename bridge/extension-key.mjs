// 확장의 공개키. 매니페스트의 key에 넣으면 어느 폴더·PC·브라우저(크롬, 엣지)에서 로드해도 확장 ID가 같다.
// 그래서 클라이언트는 확장을 찾지 않고도 이 ID를 Native Messaging에 미리 허용해 둘 수 있다.
// 개인키(keys/dogent-extension.pem, 저장소에 넣지 않음)는 CRX로 묶을 때만 쓴다. 키를 바꾸면 ID가 바뀌어 확장의 저장된 설정이 사라진다.
import { createHash } from 'node:crypto';

export const EXTENSION_KEY =
  'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAwZgadl9RTgfM2V1JLFMvbnS4BxIHj/J9lneIG+ef/AZjLIMprncc6ScEKBXJkwfROHUvfLhmmQnBNc9Vh9iB7LusS4FgaUn4223+xghECAgkjONNhT7bpIsPGCQ/Az6NdUaHIO76as+M+wrYjby0vVGAM2GEKCXH3nD3s+nhW4cjLubKChOQ/0btuv6GlHydOYmIWPRCe7LYF8E6eewiVmrIcLtG8xkXoFsJ5yIZAE2Nz5EiV2M55CkFV9QYE9dWpHiCYuBrxoqtUbePRp3MjzWPzSzj+QymFYYwLz25HxCyr7NPyJoC/S/nYYZYl3UOVYZQMOeWe9WqSrJ8o0i0WQIDAQAB';

/** 크롬이 key로 ID를 정하는 방법: 공개키(DER)의 SHA-256 앞 32자리를 0-f → a-p로 바꾼다 */
export function extensionIdOf(key) {
  const hex = createHash('sha256').update(Buffer.from(key, 'base64')).digest('hex').slice(0, 32);
  return [...hex].map((c) => String.fromCharCode(97 + parseInt(c, 16))).join('');
}

export const EXTENSION_ID = extensionIdOf(EXTENSION_KEY);
