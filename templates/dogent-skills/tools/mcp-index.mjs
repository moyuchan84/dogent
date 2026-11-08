// 사내 MCP 카탈로그(mcp/catalog.json)를 만든다.
//
//   node tools/mcp-index.mjs [폴더]            기본은 mcp. 폴더 안의 <id>/server.json 들을 모아 catalog.json을 쓴다
//   node tools/mcp-index.mjs [폴더] --check    catalog.json이 최신인지, 항목에 문제가 없는지만 본다 (CI용, 파일은 쓰지 않음)
//
// server.json 한 개가 서버 하나다. 모양은 Dogent의 src/core/mcp-catalog.ts와 같다. 비밀(토큰)은 적지 않고 ${환경변수}로 가리킨다.
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const args = process.argv.slice(2);
const check = args.includes('--check');
const dir = resolve(args.find((a) => !a.startsWith('--')) ?? 'mcp');
if (!existsSync(dir)) {
  console.error(`폴더가 없습니다: ${dir}`);
  process.exit(1);
}

const SECRETISH = /^(authorization|x-api-key|api-key|x-auth-token|token)$|token|secret|password|key/i;
const PLACEHOLDER = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

function problemsOf(folder, s) {
  const p = [];
  if (!/^[a-z][a-z0-9-]{0,39}$/.test(s.id ?? '')) p.push('id는 소문자로 시작하는 소문자·숫자·하이픈 40자 이내');
  if (s.id !== folder) p.push(`폴더 이름(${folder})과 id(${s.id})가 같아야 합니다`);
  for (const k of ['name', 'description', 'owner']) if (!s[k] || typeof s[k] !== 'string') p.push(`${k}가 필요합니다`);
  const spec = s.spec ?? {};
  if (!!spec.command === !!spec.url) p.push('spec에는 command(이 PC에서 띄움)와 url(원격) 중 하나만 적습니다');
  if (spec.url && !/^https?:\/\//i.test(spec.url)) p.push('spec.url은 http(s) 주소');
  const need = new Set(s.requires_env ?? []);
  const used = new Set();
  for (const [where, bag] of [['headers', spec.headers], ['env', spec.env]]) {
    for (const [k, v] of Object.entries(bag ?? {})) {
      const holders = [...String(v).matchAll(PLACEHOLDER)].map((m) => m[1]);
      holders.forEach((h) => used.add(h));
      if (SECRETISH.test(k) && String(v).trim() && !holders.length) p.push(`${where}.${k}: 비밀 값을 그대로 적지 말고 \${환경변수}로 적으세요`);
    }
  }
  for (const u of used) if (!need.has(u)) p.push(`\${${u}}를 쓰면서 requires_env에 적지 않았습니다`);
  if (spec.url && need.size && !/^https:\/\//i.test(spec.url) && !/^http:\/\/(localhost|127\.0\.0\.1)/i.test(spec.url)) p.push('토큰이 필요한 서버의 주소는 https여야 합니다');
  return p;
}

const servers = [];
let bad = 0;
for (const entry of readdirSync(dir, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  const file = join(dir, entry.name, 'server.json');
  if (!existsSync(file)) continue;
  let s;
  try {
    s = JSON.parse(readFileSync(file, 'utf8'));
  } catch (e) {
    console.error(`${entry.name}/server.json: JSON 오류 — ${e.message}`);
    bad++;
    continue;
  }
  const problems = problemsOf(entry.name, s);
  if (problems.length) {
    bad++;
    for (const m of problems) console.error(`${entry.name}/server.json: ${m}`);
    continue;
  }
  servers.push({ writes: false, requires_env: [], ...s });
}
if (bad) process.exit(1);
servers.sort((a, b) => a.id.localeCompare(b.id));

const out = `${JSON.stringify({ servers }, null, 2)}\n`;
const target = join(dir, 'catalog.json');
const current = existsSync(target) ? readFileSync(target, 'utf8').replace(/\r\n/g, '\n') : '';
if (check) {
  if (current !== out) {
    console.error('::error file=mcp/catalog.json::mcp/catalog.json 이 server.json 들과 맞지 않습니다. node tools/mcp-index.mjs mcp 를 실행해 함께 올리세요');
    process.exit(1);
  }
  console.log(`카탈로그 ${servers.length}개 확인`);
} else {
  writeFileSync(target, out);
  console.log(`${target} — 서버 ${servers.length}개`);
}
