import { createPageAgent, type PageAgent } from './agent';

/**
 * 확장 없이 브라우저를 직접 다룰 때(client/src/direct) 프레임마다 넣는 페이지 에이전트.
 * 확장의 page-agent와 같은 것을 쓰고, 녹화(사이드 패널 전용)는 하지 않는다.
 * 빌드할 때 한 덩어리 스크립트로 묶여 클라이언트에 글로 들어간다 (client/build-env.mjs의 pageAgentSource).
 */
const g = globalThis as typeof globalThis & { __dogent?: PageAgent };
if (!g.__dogent) g.__dogent = createPageAgent(window, () => {});
