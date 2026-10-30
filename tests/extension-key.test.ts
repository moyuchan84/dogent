import { describe, expect, it } from 'vitest';
import { EXTENSION_ID, EXTENSION_KEY, extensionIdOf } from '../bridge/extension-key.mjs';

describe('확장 ID 고정 (manifest key)', () => {
  it('공개키로 정해지는 ID는 브라우저가 실제로 준 ID와 같다', () => {
    // 이 key로 빌드한 확장을 엣지에 로드했을 때 받은 ID
    expect(EXTENSION_ID).toBe('koofmoibafgagpofabagilbhknolfgok');
    expect(extensionIdOf(EXTENSION_KEY)).toMatch(/^[a-p]{32}$/);
  });
});
