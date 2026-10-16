import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PARAM_NAME, draftSkill, lintSkill, renameParam, stepsFromRun, type AuthorStep, type HistoryEntry } from '../../src/core';
import type { Terminal } from './terminal';

/** 단계를 한 줄로 보여 준다. */
function describe(s: AuthorStep): string {
  switch (s.kind) {
    case 'click':
      return `"${s.name}" 누름`;
    case 'type':
      return `"${s.name}"에 입력: ${s.value}`;
    case 'select':
      return `"${s.name}"에서 선택: ${s.value}`;
    case 'extract':
      return `"${s.name}" 표 읽기${s.next ? ` ("${s.next}"로 끝 페이지까지)` : ''}`;
    case 'fill':
      return `"${s.name}" 표에 엑셀 채우기`;
    case 'goal':
      return `말로 적은 단계: ${s.text}`;
    case 'summarize':
      return `${s.source === 'page' ? '화면의 글' : `"${s.source.table}" 표`} 정리: ${s.instruction}`;
  }
}

/**
 * 잘 된 자유 요청을 개인 스킬로 저장한다 (사이드 패널의 "이 실행을 스킬로 저장"과 같다).
 * 요청에 나온 값은 매개변수로 제안하고, 이름과 설명을 묻는다. 품질 검사를 통과해야 저장한다.
 * 저장한 파일 경로를 돌려준다. 그만두면 null.
 */
export async function saveRunAsSkill(
  term: Terminal,
  run: { request: string; tabUrl: string; entries: HistoryEntry[] },
  personalDir: string,
  takenIds: Set<string>,
): Promise<string | null> {
  const r = stepsFromRun(run);
  let steps = r.steps;
  term.print('\n옮긴 단계:');
  steps.forEach((s, i) => term.print(`  ${i + 1}. ${describe(s)}`));
  for (const n of r.notes) term.print(`  참고: ${n}`);

  // 매개변수 이름과 설명
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i];
    if ((s.kind !== 'type' && s.kind !== 'select') || !s.variable) continue;
    term.print(`\n"${s.value}"(${s.name})을(를) 실행할 때마다 받습니다.`);
    const from = s.param?.name ?? '';
    let name = await term.askDefault('  이름 (영문 소문자)', from);
    while (!PARAM_NAME.test(name)) name = await term.askDefault('  영문 소문자로 시작하고 영문·숫자·_만 씁니다. 이름', from);
    const description = await term.askDefault('  설명 (요청에서 이 값을 찾는 근거)', '');
    steps = renameParam(steps, from, name);
    steps[i] = { ...s, param: { name, ...(description ? { description } : {}) } };
  }

  let id = '';
  for (;;) {
    id = await term.askDefault('\n스킬 ID (영문 소문자·숫자·하이픈, 예: wip-count)', '');
    if (!id) return null;
    if (!/^[a-z][a-z0-9-]*$/.test(id)) {
      term.print('  영문 소문자로 시작하고 소문자·숫자·하이픈만 씁니다');
      continue;
    }
    if (takenIds.has(id) && !(await term.confirm(`  "${id}"는 이미 있습니다. 개인 스킬로 덮어쓸까요?`, false))) continue;
    break;
  }
  const name = await term.askDefault('이름', r.meta.name);
  const description = await term.askDefault('설명', r.meta.description);
  const owner = await term.askDefault('담당 부서', '');
  if (!owner) {
    term.print('담당 부서를 적어야 저장할 수 있습니다. 저장하지 않았습니다.');
    return null;
  }

  const draft = draftSkill({ id, name, description, owner }, r.start, steps);
  const report = lintSkill(draft.source);
  term.print(`\n품질 검사: ${report.grade} (${report.score}점)`);
  for (const f of report.findings) term.print(`  [${f.level}] ${f.rule}${f.step ? ` ${f.step}단계` : ''}: ${f.message}`);
  for (const n of draft.notes) term.print(`  참고: ${n}`);
  if (report.grade === 'F') {
    term.print('실행할 수 없는 초안이라 저장하지 않았습니다.');
    return null;
  }
  const dir = join(personalDir, id);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'SKILL.md');
  if (existsSync(file)) term.print(`  ${file}을(를) 바꿉니다.`);
  writeFileSync(file, draft.source);
  return file;
}
