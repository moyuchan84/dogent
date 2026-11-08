import { z } from 'zod';

/**
 * 사내 MCP 카탈로그: 팀 저장소의 mcp/<id>/server.json 들을 모은 mcp/catalog.json.
 * 사용자는 `dogent mcp browse` / `dogent mcp install <id>`로 받아 ~/.dogent/mcp.json에 더한다.
 * 이 파일은 순수 함수만 둔다 (파일·네트워크는 클라이언트와 템플릿 도구가 한다).
 *
 * 카탈로그는 "무엇을 어떻게 연결하나"만 적는다. 비밀(토큰)은 적지 않고 ${환경변수}로 가리킨다.
 */
export const CatalogServer = z.object({
  /** 설치될 이름 (mcp.json의 서버 이름). 소문자·숫자·하이픈 */
  id: z.string().regex(/^[a-z][a-z0-9-]{0,39}$/, '소문자로 시작하는 소문자·숫자·하이픈 40자 이내'),
  name: z.string().min(1),
  description: z.string().min(1),
  /** 담당 부서 (장애·문의) */
  owner: z.string().min(1),
  /** 바꾸는(쓰기) 도구가 있는지. 설치 확인 창에 보인다 */
  writes: z.boolean().default(false),
  /** 설치 전에 사용자가 준비해야 할 환경 변수 이름들 (예: MES_TOKEN) */
  requires_env: z.array(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/)).default([]),
  /** 사용 안내 한두 줄 */
  notes: z.string().optional(),
  spec: z
    .object({
      command: z.string().optional(),
      args: z.array(z.string()).optional(),
      url: z.string().url().optional(),
      transport: z.enum(['http', 'sse']).optional(),
      headers: z.record(z.string(), z.string()).optional(),
      env: z.record(z.string(), z.string()).optional(),
      permissions: z.record(z.string(), z.enum(['allow', 'ask', 'deny'])).optional(),
      keywords: z.array(z.string()).optional(),
    })
    .refine((s) => !!s.command !== !!s.url, 'command(이 PC에서 띄움)와 url(원격) 중 하나만 적습니다'),
});
export type CatalogServer = z.infer<typeof CatalogServer>;

export const McpCatalog = z.object({ servers: z.array(CatalogServer) });
export type McpCatalog = z.infer<typeof McpCatalog>;

const SECRETISH = /^(authorization|x-api-key|api-key|x-auth-token|token)$|token|secret|password|key/i;

/** 카탈로그 항목의 추가 검사: 비밀이 파일에 그대로 적히면 안 된다 (${ENV}로 가리켜야 한다) */
export function lintServer(s: CatalogServer): string[] {
  const problems: string[] = [];
  const check = (where: string, bag?: Record<string, string>) => {
    for (const [k, v] of Object.entries(bag ?? {})) {
      if (SECRETISH.test(k) && v.trim() && !/\$\{[A-Za-z_][A-Za-z0-9_]*\}/.test(v)) {
        problems.push(`${where}.${k}: 비밀 값을 그대로 적지 말고 \${환경변수}로 적으세요`);
      }
    }
  };
  check('headers', s.spec.headers);
  check('env', s.spec.env);
  const placeholders = new Set<string>();
  for (const bag of [s.spec.headers, s.spec.env]) for (const v of Object.values(bag ?? {})) for (const m of v.matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g)) placeholders.add(m[1]);
  for (const p of placeholders) if (!s.requires_env.includes(p)) problems.push(`\${${p}}를 쓰면서 requires_env에 적지 않았습니다`);
  if (s.spec.url && !/^https:\/\//i.test(s.spec.url) && !/^http:\/\/(localhost|127\.0\.0\.1)/i.test(s.spec.url) && s.requires_env.length) {
    problems.push('토큰이 필요한 서버의 주소는 https여야 합니다');
  }
  return problems;
}

/** 카탈로그 글을 읽는다. 잘못된 항목은 건너뛰고 이유를 돌려준다 (한 항목 때문에 전체가 안 보이지 않게) */
export function parseCatalog(raw: unknown): { servers: CatalogServer[]; errors: string[] } {
  const list = (raw as { servers?: unknown } | null)?.servers;
  if (!Array.isArray(list)) return { servers: [], errors: ['"servers" 목록이 없습니다'] };
  const servers: CatalogServer[] = [];
  const errors: string[] = [];
  const seen = new Set<string>();
  list.forEach((item, i) => {
    const r = CatalogServer.safeParse(item);
    const id = (item as { id?: string } | null)?.id ?? `#${i + 1}`;
    if (!r.success) {
      errors.push(`${id}: ${r.error.issues.map((x) => `${x.path.join('.') || '항목'} ${x.message}`).join('; ')}`);
      return;
    }
    if (seen.has(r.data.id)) {
      errors.push(`${id}: id가 겹칩니다`);
      return;
    }
    const bad = lintServer(r.data);
    if (bad.length) {
      errors.push(`${id}: ${bad.join('; ')}`);
      return;
    }
    seen.add(r.data.id);
    servers.push(r.data);
  });
  return { servers, errors };
}

/**
 * 카탈로그 주소. 따로 정하지 않았으면 팀 스킬 목록(…/skills/index.json) 옆의 …/mcp/catalog.json으로 본다.
 * 둘 다 같은 저장소에 있는 구성(templates/dogent-skills)을 가정한다.
 */
export function catalogUrlFor(skillsIndexUrl: string | undefined, explicit?: string): string | undefined {
  if (explicit?.trim()) return explicit.trim();
  if (!skillsIndexUrl) return undefined;
  try {
    return new URL('../mcp/catalog.json', skillsIndexUrl).toString();
  } catch {
    return undefined;
  }
}

/** 목록에 보일 한 줄 */
export function describeCatalogServer(s: CatalogServer, installed: boolean): string {
  const how = s.spec.url ? `원격 ${s.spec.url}` : `이 PC에서 실행: ${[s.spec.command, ...(s.spec.args ?? [])].join(' ')}`;
  return [
    `${installed ? '✔' : ' '} ${s.id} — ${s.name} [${s.owner}]${s.writes ? ' (바꾸는 도구 있음)' : ''}`,
    `    ${s.description}`,
    `    ${how}${s.requires_env.length ? ` · 필요한 환경 변수: ${s.requires_env.join(', ')}` : ''}`,
  ].join('\n');
}
