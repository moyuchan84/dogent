import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  OpenAiCompatClient,
  PICK_STRATEGIES,
  formatPickSummary,
  parsePickCases,
  runPickEval,
  summarizePick,
  type PickStrategy,
} from '../../src/core';
import { DEFAULT_PICK_CASES, DISTRACTOR_SKILLS } from '../../tools/pick-cases';
import type { ClientConfig } from './config';
import { loadSkills } from './skills';
import { teamCacheDir } from './team';

export const EVAL_USAGE = `사용법: dogent eval pick [--cases 파일.json] [--strategies current,one-shot,index] [--repeat N] [--no-distractors]

  같은 요청을 스킬 고르는 방식만 바꿔 모델에 물어 맞힌 비율을 잰다 (브라우저는 쓰지 않는다).
  current   지금 방식: 코드가 후보를 줄이고 모델이 고른다
  one-shot  모든 스킬의 입력 설명까지 한 번에 보여 주고 고르기와 값 뽑기를 함께
  index     스킬 이름과 설명 한 줄씩만 보여 주고 모델이 고른 뒤, 그 스킬의 입력만 보고 값을 뽑는다 (Claude Code 방식)

  --cases          시험 문항 JSON. [{"request": "...", "expect": "스킬id 또는 null", "inputs": {"이름": "값"}}]
                   없으면 기본 스킬용 문항 ${DEFAULT_PICK_CASES.length}개
  --no-distractors 방해 스킬 ${DISTRACTOR_SKILLS.length}개를 섞은 목록으로는 재지 않는다
  결과는 ~/.dogent/evals/ 에 JSON으로 남는다 (요청 글이 들어 있으니 밖으로 보낼 때 주의)`;

/** dogent eval pick. 성공하면 0 */
export async function runEvalCommand(args: string[], cfg: ClientConfig, signal?: AbortSignal): Promise<number> {
  const [sub, ...rest] = args;
  if (sub !== 'pick') {
    console.log(EVAL_USAGE);
    return sub ? 1 : 0;
  }
  const opt = (name: string) => (rest.includes(name) ? rest[rest.indexOf(name) + 1] : undefined);
  const cases = opt('--cases') ? parsePickCases(readFileSync(opt('--cases')!, 'utf8')) : DEFAULT_PICK_CASES;
  const strategies = (opt('--strategies')?.split(',').map((s) => s.trim()) ?? PICK_STRATEGIES) as PickStrategy[];
  const unknown = strategies.filter((s) => !PICK_STRATEGIES.includes(s));
  if (unknown.length) throw new Error(`모르는 방식: ${unknown.join(', ')} (${PICK_STRATEGIES.join(', ')} 중에서)`);
  const repeat = Math.max(1, Number(opt('--repeat')) || 1);

  const { skills, errors } = loadSkills(
    { personal: cfg.personalSkills, team: cfg.teamSkills, teamCache: cfg.teamSkillsUrl ? teamCacheDir(cfg.home) : undefined },
    __DOGENT_SKILLS__,
  );
  for (const e of errors) console.log(`  (건너뜀) ${e}`);
  const missing = [...new Set(cases.flatMap((c) => [c.expect, c.with_distractors]))].filter(
    (id): id is string => typeof id === 'string' && !skills.some((s) => s.skill.id === id) && !DISTRACTOR_SKILLS.some((d) => d.id === id),
  );
  if (missing.length) throw new Error(`문항이 기대하는 스킬이 없습니다: ${missing.join(', ')}`);

  const distractors = rest.includes('--no-distractors') ? [] : DISTRACTOR_SKILLS;
  const total = cases.length * strategies.length * repeat * (distractors.length ? 2 : 1);
  console.log(`모델 ${cfg.llm.model} (${cfg.llm.baseUrl}) · 스킬 ${skills.length}개 · 문항 ${cases.length}개 · 방식 ${strategies.join(', ')} · 모두 ${total}번 묻습니다`);

  let done = 0;
  const trials = await runPickEval({
    cases,
    skills: skills.map((s) => s.skill),
    llm: new OpenAiCompatClient(cfg.llm),
    strategies,
    distractors,
    repeat,
    signal,
    onTrial: (t) => {
      done++;
      const mark = t.error ? '오류' : !t.skillOk ? '틀림' : t.inputsOk === false ? '값틀림' : '맞음';
      if (mark === '맞음') return void process.stdout.write(`\r  ${done}/${total}`);
      const detail = t.error ?? (t.skillOk ? Object.entries(t.wrongInputs ?? {}).map(([k, [a, b]]) => `${k}: ${a} → ${b}`).join(', ') : `기대 ${t.expect} → ${t.got}`);
      console.log(`\r  ${done}/${total} [${mark}] ${t.strategy}${t.distractors ? '+방해' : ''} "${t.request}" — ${detail}`);
    },
  });
  console.log('\n');
  const rows = summarizePick(trials);
  for (const l of formatPickSummary(rows)) console.log(l);

  const dir = join(cfg.home, 'evals');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `pick-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.json`);
  writeFileSync(file, JSON.stringify({ model: cfg.llm.model, at: new Date().toISOString(), summary: rows, trials }, null, 2));
  console.log(`\n자세한 결과: ${file}`);
  return 0;
}
