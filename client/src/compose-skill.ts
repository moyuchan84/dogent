import { spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  composeSkill,
  composeStart,
  finalizeDraft,
  lintSkill,
  reviseSkill,
  stripCheckLines,
  type ComposeDraft,
  type LintReport,
  type LlmPort,
  type PageSnapshot,
  type RunResult,
  type Skill,
} from '../../src/core';
import type { Ui } from './session';
import type { SkillEntry } from './skills';

/**
 * 말로 스킬 만들기 (dogent skill new, 앱의 "스킬 만들기").
 *
 *   업무를 말로 설명 → 모델이 지금 화면을 보고 초안 → 말로 고치기 ↔ 시험 실행 → 저장
 *
 * 초안은 저장하기 전까지 파일로 쓰지 않는다. 시험 실행은 저장·상신 직전에 멈춘다.
 */
export interface ComposeDeps {
  ui: Ui;
  llm: LlmPort;
  personalDir: string;
  takenIds: Set<string>;
  /** 지금 브라우저 탭과 화면 */
  page(): Promise<{ url: string; title: string; snap: PageSnapshot }>;
  /** 초안을 시험 실행한다 (입력값은 묻고, 저장·상신 직전에 멈춤). 그만두면 null */
  test(skill: Skill): Promise<RunResult | null>;
  /** 기억해 둔 담당 부서 */
  owner?: string;
  /** 처음 정한 담당 부서를 기억한다 */
  rememberOwner?(owner: string): void;
}

const COMMANDS = '고칠 점을 말하거나: 시험 · 저장 · 보기 · 그만';

export function describeFindings(report: LintReport): string[] {
  const lines = [`품질 검사: ${report.grade} (${report.score}점)${report.deployable ? '' : report.grade === 'F' ? ' — 오류를 고쳐야 저장할 수 있습니다' : ' — 팀에 올리려면 B 이상'}`];
  for (const f of report.findings) if (f.level !== 'info') lines.push(`  [${f.level === 'error' ? '오류' : '경고'}] ${f.step ? `${f.step}단계: ` : ''}${f.message}`);
  return lines;
}

/** 초안을 사람이 읽을 모양으로 */
export function describeDraft(d: ComposeDraft): string {
  const out: string[] = [];
  const skill = d.report.skill;
  out.push(`\n${d.spec.name} (${d.spec.id}, ${d.spec.risk})`);
  out.push(`  ${d.spec.description}`);
  if (skill) {
    if (skill.inputs.length) {
      out.push('  입력:');
      for (const i of skill.inputs) out.push(`    {${i.name}} ${i.label ?? ''}${i.default !== undefined ? ` (기본 ${i.default})` : i.required ? ' (필수)' : ''}${i.description ? ` — ${i.description}` : ''}`);
    }
    out.push('  단계:');
    skill.steps.forEach((s, k) => {
      const check = /- 검사:\s*(.+)/.exec(s)?.[1];
      const head = stripCheckLines(s).split('\n')[0].replace(/\. args는 다음을 그대로 쓴다\..*$/, '');
      out.push(`    ${k + 1}. ${head}${check ? `\n       확인: ${check}` : ''}`);
    });
  }
  out.push(...describeFindings(d.report).map((l) => `  ${l}`));
  for (const n of d.notes) out.push(`  참고: ${n}`);
  return out.join('\n');
}

function resultLine(r: RunResult): string {
  const state = { done: '성공', dryrun: '시험 실행 완료(저장·상신 직전에 멈춤)', error: '실패', aborted: '중단', stopped: '멈춤' } as Record<string, string>;
  return `${state[r.status] ?? r.status} · ${r.lastStep}단계까지 · 동작 ${r.actions}번: ${r.message ?? ''}`.trim();
}

/** 말로 스킬을 만든다. 저장한 파일 경로를 돌려준다. 그만두면 null. */
export async function composeFlow(deps: ComposeDeps, request?: string): Promise<string | null> {
  const { ui } = deps;
  const first = await deps.page();
  ui.print(`시작 화면: ${first.title || first.url}\n  ${first.url}\n이 화면에서 시작하는 스킬을 만듭니다. 다른 화면에서 시작하려면 그 탭을 앞에 두고 다시 하세요.`);
  const start = composeStart(first.url, first.title, first.snap, deps.owner);

  let draft: ComposeDraft | null = null;
  let text = request?.trim() ?? '';
  while (!draft) {
    if (!text) {
      const a = await ui.ask('\n어떤 업무를 스킬로 만들까요? 하는 일과, 실행할 때마다 바뀌는 값을 말해 주세요\n  예: 라인을 골라 HOLD Lot을 찾고 사유별로 몇 건인지 정리해 줘. 라인은 매번 다름\n> ');
      if (a === null || !a.trim() || a.trim() === '그만') return null;
      text = a.trim();
    }
    ui.print('초안을 쓰는 중… (지금 화면을 읽고 모델이 절차를 씁니다)');
    try {
      draft = await composeSkill(text, deps.llm, { start, snap: first.snap, takenIds: deps.takenIds });
    } catch (e) {
      ui.print(`초안을 쓰지 못했습니다: ${(e as Error).message}\n설명을 조금 바꿔 다시 말해 주세요.`);
      text = '';
    }
  }
  ui.print(describeDraft(draft));

  let lastRun: string | undefined;
  for (;;) {
    const a = await ui.ask(`\n${COMMANDS}\n> `);
    const line = a?.trim() ?? '그만';
    if (!line) continue;
    if (line === '그만' || line === 'exit') {
      if (await ui.confirm('저장하지 않고 끝낼까요?', true)) return null;
      continue;
    }
    if (line === '보기') {
      ui.print(`\n${draft.source}`);
      continue;
    }
    if (line === '시험') {
      if (draft.report.grade === 'F' || !draft.report.skill) {
        ui.print('품질 검사 오류가 있어 실행할 수 없습니다. 오류를 말로 고쳐 달라고 하세요.');
        continue;
      }
      const r = await deps.test(draft.report.skill);
      if (!r) continue;
      lastRun = resultLine(r);
      ui.print(`\n시험 결과: ${lastRun}`);
      ui.print(r.status === 'done' || r.status === 'dryrun' ? '잘 됐으면 "저장", 바꿀 것이 있으면 말해 주세요.' : '고칠 점을 말하면 이 결과를 참고해 고칩니다 (예: "조회 뒤 결과가 뜰 때까지 기다리게 해 줘").');
      continue;
    }
    if (line === '저장') {
      const saved = await save(deps, draft);
      if (saved) return saved;
      continue;
    }
    // 그 밖의 말은 고칠 점이다. 화면이 바뀌었을 수 있어 지금 화면을 다시 읽는다 (시작 화면은 처음 것을 쓴다).
    ui.print('고치는 중…');
    try {
      const now = await deps.page().catch(() => first);
      draft = await reviseSkill(draft, line, deps.llm, { start: draft.start, snap: now.snap, takenIds: deps.takenIds }, lastRun);
      lastRun = undefined;
      ui.print(describeDraft(draft));
    } catch (e) {
      ui.print(`고치지 못했습니다: ${(e as Error).message}`);
    }
  }
}

async function save(deps: ComposeDeps, draft: ComposeDraft): Promise<string | null> {
  const { ui } = deps;
  let owner = deps.owner ?? '';
  while (!owner.trim()) {
    owner = await ui.askDefault('담당 부서 (스킬을 고칠 책임이 있는 곳, 예: 생산관리)', '');
    if (!owner.trim() && !(await ui.confirm('담당 부서를 적어야 저장할 수 있습니다. 다시 적을까요?', true))) return null;
  }
  if (!deps.owner) deps.rememberOwner?.(owner.trim());
  let id = draft.spec.id;
  for (;;) {
    id = (await ui.askDefault('스킬 ID (영문 소문자·숫자·하이픈)', id)).trim();
    if (!/^[a-z][a-z0-9-]*$/.test(id)) {
      ui.print('  영문 소문자로 시작하고 소문자·숫자·하이픈만 씁니다');
      continue;
    }
    if (deps.takenIds.has(id) && !(await ui.confirm(`  "${id}"는 이미 있습니다. 개인 스킬로 덮어쓸까요? (같은 id면 개인 스킬이 먼저 쓰입니다)`, false))) continue;
    break;
  }
  const final = finalizeDraft(draft, owner.trim(), id);
  if (final.report.grade === 'F') {
    ui.print(describeFindings(final.report).join('\n'));
    return null;
  }
  const dir = join(deps.personalDir, id);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'SKILL.md');
  writeFileSync(file, final.source);
  ui.print(`\n저장했습니다: ${file}\n  등급 ${final.report.grade}. 쓸수록 성공한 동작을 기억해 빨라집니다. 팀에 나누려면 팀 스킬 저장소에 PR로 올리세요.`);
  return file;
}

/**
 * 스킬 파일을 편집기로 연다 (dogent skill edit). 편집기를 닫으면 품질 검사를 돌린다.
 * 팀·기본 스킬은 개인 폴더에 복사해서 연다 (같은 id면 개인 스킬이 먼저 쓰인다).
 */
export async function editSkill(ui: Ui, entry: SkillEntry, personalDir: string, bundledSource?: string): Promise<string | null> {
  let file = entry.path;
  if (entry.source !== '개인') {
    const target = join(personalDir, entry.skill.id, 'SKILL.md');
    if (!(await ui.confirm(`[${entry.source}] 스킬은 개인 스킬로 복사해서 고칩니다 (${target}). 팀에 반영하려면 팀 저장소에 PR로 올리세요. 계속할까요?`, true))) return null;
    mkdirSync(dirname(target), { recursive: true });
    if (!existsSync(target)) {
      if (file) {
        copyFileSync(file, target);
        const policy = join(dirname(file), 'policy.yaml');
        if (existsSync(policy)) copyFileSync(policy, join(dirname(target), 'policy.yaml'));
      } else writeFileSync(target, bundledSource ?? '');
    }
    file = target;
  }
  if (!file) return null;
  const editor = process.env.DOGENT_EDITOR || process.env.EDITOR || 'notepad';
  ui.print(`편집기로 엽니다: ${file}\n  (${editor}. 바꾸려면 환경 변수 DOGENT_EDITOR, VS Code라면 "code --wait") 편집기를 닫으면 품질 검사를 합니다.`);
  await new Promise<void>((resolve) => {
    const child = spawn(`${editor} "${file}"`, { shell: true, stdio: 'inherit' });
    child.on('exit', () => resolve());
    child.on('error', (e) => (ui.print(`편집기를 열지 못했습니다: ${e.message}`), resolve()));
  });
  const policyFile = join(dirname(file), 'policy.yaml');
  const report = lintSkill(readFileSync(file, 'utf8'), existsSync(policyFile) ? readFileSync(policyFile, 'utf8') : undefined);
  ui.print(describeFindings(report).join('\n'));
  return file;
}
