// 스킬 폴더 품질 검사. 팀 스킬 저장소의 CI(GitHub Actions)와 손으로 돌릴 때 쓴다.
//
//   node tools/skill-check.mjs [폴더=skills] [--min-grade B]
//
// 이 파일은 pnpm skill:bundle 로 yaml·zod까지 한 파일(templates/dogent-skills/tools/skill-check.mjs)로 묶여
// Node만 있으면 돈다. 사내 러너에서 npm 설치를 하지 않아도 된다.
// 확장의 스킬 만들기 화면과 같은 검사 함수(src/core/lint.ts)를 쓴다.
import { existsSync, readFileSync, readdirSync, appendFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { lintSkill, type Grade } from '../src/core/lint';

const args = process.argv.slice(2);
const flag = args.indexOf('--min-grade');
const minGrade = (flag >= 0 ? args.splice(flag, 2)[1] : 'B') as Grade;
const dir = resolve(args[0] ?? 'skills');
const ORDER: Grade[] = ['A', 'B', 'C', 'F'];
const inGitHub = process.env.GITHUB_ACTIONS === 'true';

if (!existsSync(dir)) {
  console.error(`폴더가 없습니다: ${dir}`);
  process.exit(1);
}

type Row = { folder: string; id: string; grade: Grade; ok: boolean; lines: string[] };
const rows: Row[] = [];
const seen = new Map<string, string>();

for (const entry of readdirSync(dir, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  const file = join(dir, entry.name, 'SKILL.md');
  if (!existsSync(file)) continue;
  const rel = `${entry.name}/SKILL.md`;
  const policyFile = join(dir, entry.name, 'policy.yaml');
  const report = lintSkill(readFileSync(file, 'utf8'), existsSync(policyFile) ? readFileSync(policyFile, 'utf8') : undefined);
  const id = report.skill?.id ?? '(읽지 못함)';
  const lines = report.findings.map((f) => `${f.level === 'error' ? '오류' : '경고'} ${f.rule}${f.step ? ` · ${f.step}단계` : ''}: ${f.message}`);
  let grade = report.grade;
  // 폴더 이름과 id가 다르면 목록과 실제 스킬이 어긋나고, 같은 id가 둘이면 어느 쪽이 쓰일지 알 수 없다.
  if (report.skill && report.skill.id !== entry.name) {
    lines.unshift(`오류: 폴더 이름(${entry.name})과 id(${report.skill.id})가 다릅니다. 같게 맞추세요`);
    grade = 'F';
  }
  if (report.skill && seen.has(report.skill.id)) {
    lines.unshift(`오류: id "${report.skill.id}"가 ${seen.get(report.skill.id)}에도 있습니다`);
    grade = 'F';
  }
  if (report.skill) seen.set(report.skill.id, rel);
  const ok = ORDER.indexOf(grade) <= ORDER.indexOf(minGrade);
  rows.push({ folder: rel, id, grade, ok, lines });
  if (inGitHub) {
    for (const f of report.findings) {
      console.log(`::${f.level === 'error' ? 'error' : 'warning'} file=${join(args[0] ?? 'skills', rel).replace(/\\/g, '/')},title=${f.rule}::${f.message}`);
    }
  }
}

if (rows.length === 0) {
  console.error(`${dir}에 SKILL.md가 있는 폴더가 없습니다`);
  process.exit(1);
}

for (const r of rows) {
  console.log(`${r.ok ? '통과' : '실패'}  ${r.grade}  ${r.id}  (${r.folder})`);
  for (const line of r.lines) console.log(`      ${line}`);
}
const failed = rows.filter((r) => !r.ok);
console.log(`\n스킬 ${rows.length}개 중 ${rows.length - failed.length}개 통과 (기준: ${minGrade}등급 이상)`);

if (process.env.GITHUB_STEP_SUMMARY) {
  const table = [
    '## 스킬 품질 검사',
    '',
    `기준: ${minGrade}등급 이상`,
    '',
    '| 결과 | 등급 | id | 지적 사항 |',
    '|---|---|---|---|',
    ...rows.map((r) => `| ${r.ok ? '통과' : '**실패**'} | ${r.grade} | \`${r.id}\` | ${r.lines.join('<br>') || '-'} |`),
    '',
  ];
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, table.join('\n'));
}
process.exit(failed.length ? 1 : 0);
