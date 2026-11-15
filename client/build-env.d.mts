// client/build-env.mjs 중 시험에서 쓰는 것의 형
export declare const ROOT: string;
/** 확장 없이 브라우저를 직접 다룰 때 프레임마다 넣는 페이지 에이전트 스크립트 */
export declare function pageAgentSource(): Promise<string>;
/** 확장 빌드와 같은 조작할 사이트 규칙. 모든 사이트 빌드면 빈 객체 */
export declare function siteRules(mode: string): { sites?: string[]; siteScope?: string[] };
