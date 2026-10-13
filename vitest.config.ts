import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    // jsdom에 모의 화면을 올려 스킬을 끝까지 돌리는 테스트는 PC가 바쁠 때 수 초씩 걸린다.
    // 제한에 걸린 테스트가 뒤에서 계속 돌면 다음 테스트의 기록까지 오염시키므로 넉넉히 둔다.
    testTimeout: 60_000,
  },
});
