import { parseCatalog, type CatalogServer } from '../../src/core';
import type { McpServerSpec } from './mcp-hub';

/**
 * 사내 MCP 카탈로그를 주소로 받는다. 팀 스킬 저장소와 같은 방식(비공개 저장소 raw 주소 + 개인 토큰).
 * 읽지 못하면 던진다. 항목 하나가 잘못돼도 나머지는 보인다 (errors에 이유).
 */
export async function fetchCatalog(url: string, opts: { token?: string; timeoutMs?: number } = {}): Promise<{ servers: CatalogServer[]; errors: string[] }> {
  const headers: Record<string, string> = opts.token ? { authorization: /\s/.test(opts.token) ? opts.token : `token ${opts.token}` } : {};
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(opts.timeoutMs ?? 10_000) });
  if (res.status === 401 || res.status === 403 || res.status === 404) {
    throw new Error(`HTTP ${res.status} — 주소가 맞는지, 로그인이 필요하면 dogent config mcpCatalogToken <개인 토큰> (없으면 teamSkillsToken을 씁니다)`);
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const text = await res.text();
  if (/^\s*<(!doctype|html)/i.test(text)) throw new Error('JSON이 아니라 로그인 화면이 왔습니다. 토큰을 설정하세요 (dogent config mcpCatalogToken <개인 토큰>)');
  return parseCatalog(JSON.parse(text));
}

/** 카탈로그 항목을 mcp.json의 서버 설정으로. 카탈로그 밖의 값(disabled 등)은 만들지 않는다 */
export function specOf(s: CatalogServer): McpServerSpec {
  return { ...s.spec };
}

/** 설치 전에 준비가 안 된 환경 변수 */
export function missingEnv(s: CatalogServer, env: NodeJS.ProcessEnv = process.env): string[] {
  return s.requires_env.filter((n) => !env[n]);
}
