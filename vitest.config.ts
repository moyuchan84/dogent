import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx'],
    // jsdom에 모의 화면을 올려 스킬을 끝까지 돌리는 테스트는 PC가 바쁠 때 수 초씩 걸린다.
    // 제한에 걸린 테스트가 뒤에서 계속 돌면 다음 테스트의 기록까지 오염시키므로 넉넉히 둔다.
    testTimeout: 60_000,
    // beforeAll에서 client/src/session 처럼 큰 모듈을 처음 불러오면 변환에 10초 넘게 걸릴 때가 있다
    // (첫 실행·캐시 없음·사내 보안 프로그램이 파일 읽기를 검사할 때). 기본 10초면 시험이 아니라 준비에서 실패한다.
    hookTimeout: 120_000,
  },
});
