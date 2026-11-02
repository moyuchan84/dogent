// 시스템 사전 품질 검사. 공용 시스템 사전 저장소의 CI와 손으로 돌릴 때 쓴다.
//
//   node tools/system-check.mjs [저장소 폴더=.] [--strict]
//
// 오류가 하나라도 있으면 실패한다. --strict면 경고(검증 전, 채우지 않은 칸 등)도 실패로 친다.
// pnpm systems:bundle 로 yaml·zod까지 한 파일(templates/dogent-systems/tools/system-check.mjs)로 묶여 Node만 있으면 돈다.
import { appendFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadRegistry, systemFiles } from './systems-registry';

const args = process.argv.slice(2);
const strict = args.includes('--strict');
const root = resolve(args.find((a) => !a.startsWith('--')) ?? '.');
const inGitHub = process.env.GITHUB_ACTIONS === 'true';

if (!existsSync(root)) {
  console.error(`폴더가 없습니다: ${root}`);
  process.exit(1);
}
const files = systemFiles(root);
if (files.length === 0) {
  console.error(`${root}에 systems/<id>/SYSTEM.md 가 없습니다`);
  process.exit(1);
}

const reg = loadRegistry(root);
const LEVEL = { error: '오류', warn: '경고' } as const;
for (const f of files) {
  const mine = reg.problems.filter((p) => p.file === f.rel);
  const failed = mine.some((p) => p.level === 'error' || (strict && p.level === 'warn'));
  const sys = reg.systems.find((s) => s.file === f.rel)?.system;
  console.log(`${failed ? '실패' : '통과'}  ${sys ? `${sys.id}  ${sys.name}${sys.status === 'draft' ? ' (검증 전)' : ''}` : f.folder}  (${f.rel})`);
  for (const p of mine) console.log(`      ${LEVEL[p.level]}: ${p.message}`);
  if (inGitHub) for (const p of mine) console.log(`::${p.level === 'error' ? 'error' : 'warning'} file=${f.rel}::${p.message}`);
}

const errors = reg.problems.filter((p) => p.level === 'error').length;
const warns = reg.problems.filter((p) => p.level === 'warn').length;
const failedFiles = new Set(reg.problems.filter((p) => p.level === 'error' || (strict && p.level === 'warn')).map((p) => p.file));
console.log(`\n시스템 ${files.length}개 중 ${files.length - failedFiles.size}개 통과 · 오류 ${errors} · 경고 ${warns}${strict ? ' (경고도 실패로 침)' : ''} · 판 ${reg.version}`);

if (process.env.GITHUB_STEP_SUMMARY) {
  appendFileSync(
    process.env.GITHUB_STEP_SUMMARY,
    [
      '## 시스템 사전 검사',
      '',
      '| 결과 | 파일 | 지적 사항 |',
      '|---|---|---|',
      ...files.map((f) => {
        const mine = reg.problems.filter((p) => p.file === f.rel);
        return `| ${failedFiles.has(f.rel) ? '**실패**' : '통과'} | \`${f.rel}\` | ${mine.map((p) => `${LEVEL[p.level]}: ${p.message}`).join('<br>') || '-'} |`;
      }),
      '',
    ].join('\n'),
  );
}
process.exit(failedFiles.size ? 1 : 0);
