// 도구 호출 평가의 기본 케이스(evals/tool-calls/seed.json)를 모의 사이트와 모의 모델로 다시 만든다.
//
//   EVAL_SEED=1 pnpm vitest run tests/tool-eval-seed.test.ts
//
// 모의 모델은 스킬 절차를 규칙으로 따라가므로 그 답을 정답으로 둔다. 스킬에 인자가 적힌 단계도 모델에게 묻도록(direct: false)
// 돌려서, 모델이 정해야 하는 차례를 빠짐없이 모은다. 만든 뒤에는 tests/tool-eval.test.ts가 케이스를 검사한다.
// 사람이 손본 케이스(정답 여럿, $contains 등)는 evals/tool-calls/manual.json에 두고 이 파일로 덮어쓰지 않는다.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'vitest';
import { buildFreeSkill, captureCase, DatasetStore, resolveInputs, runSkill, type EvalCase, type Skill, type SkillInputs } from '../src/core';
import { adjustSkill, fwSkill, holdSkill, JsdomBrowser, memoryFiles, mockLlm, wipSkill } from './helpers';

const OUT = join(import.meta.dirname, '..', 'evals', 'tool-calls', 'seed.json');

/** 같은 화면·같은 동작이 되풀이되는 차례(페이지 넘김 등)는 하나만 남긴다 */
function dedupe(cases: EvalCase[]): EvalCase[] {
  const seen = new Set<string>();
  return cases.filter((c) => {
    const e = Array.isArray(c.expect) ? c.expect[0] : c.expect;
    const key = `${c.turn.skill.id}|${c.turn.step.n}|${e.tool}|${JSON.stringify(e.args)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

const firstExpect = (c: EvalCase) => (Array.isArray(c.expect) ? c.expect[0] : c.expect);

/**
 * 모델에 맞춘 채점 기준으로 고친다.
 * - row는 같은 이름의 요소 중 행을 가리는 보조 칸이다. ref 번호가 맞으면 된다.
 * - 정답이 next_step이 아닌데 이미 할 일이 끝난 화면은 없다(모의 모델 기준). 그대로 둔다.
 */
function relax(c: EvalCase): EvalCase {
  const e = firstExpect(c);
  delete e.args.row;
  return c;
}

/** 단계 글에서 "args는 다음을 그대로 쓴다"와 인자 원문, 도구 이름 머리를 지운다 (목표만 적힌 스킬처럼) */
function goalText(text: string): string {
  return text
    .replace(/\s*args는 다음을 그대로 쓴다\./g, '')
    .replace(/^[ \t]*`\{.*\}`[ \t]*\r?\n?/gm, '')
    .replace(/(^|\n)(\d+\.\s+)?[a-z_]+(?:으로|로)\s/g, '$1$2');
}

/**
 * 인자가 적힌 단계의 케이스로 "목표만 적힌 단계" 케이스를 만든다. 모델이 인자를 베끼지 않고 화면에서 요소를 골라야 한다.
 * 목표 글로는 알 수 없는 값(이동할 주소, 집계 식, 파일 이름, 보고 문장)이 정답인 차례는 만들지 않는다.
 */
function goalVariant(c: EvalCase): EvalCase | null {
  const e = firstExpect(c);
  if (!['select', 'click', 'type', 'extract_table', 'fill_table'].includes(e.tool)) return null;
  if (!c.turn.step.text.includes('args는 다음을 그대로 쓴다')) return null;
  const g = structuredClone(c);
  g.id = `${c.id}-goal`;
  g.tags = [...c.tags, 'goal'];
  g.turn.body = goalText(g.turn.body);
  g.turn.step.text = goalText(g.turn.step.text).trim();
  // 행 추가 버튼은 표의 빈 행이 모자랄 때만 쓴다. 목표 글에는 없으므로 주든 안 주든 맞게 본다.
  delete firstExpect(g).args.add_ref;
  return g;
}

describe.skipIf(!process.env.EVAL_SEED)('평가 기본 케이스 만들기', () => {
  it('모의 사이트의 스킬과 자유 요청을 돌려 모델이 정한 차례를 모은다', async () => {
    const cases: EvalCase[] = [];
    const goals: EvalCase[] = [];
    const run = async (name: string, skill: Skill, inputs: SkillInputs, opts: { start?: string; datasets?: DatasetStore; tags?: string[] } = {}) => {
      const mine: EvalCase[] = [];
      const browser = opts.start ? await JsdomBrowser.open(opts.start) : new JsdomBrowser();
      const result = await runSkill(skill, inputs, {
        llm: mockLlm,
        browser,
        ui: { ask: async () => '', approve: async () => false },
        files: memoryFiles(),
        direct: false,
        dryRun: true,
        datasets: opts.datasets,
        onTurn: (turn, snap, action) => mine.push(captureCase(turn, snap, action)),
      });
      if (result.status !== 'done' && result.status !== 'dryrun') throw new Error(`${name}: ${result.status} ${result.message}`);
      mine.forEach((c, i) => {
        c.id = `${name}-${String(i + 1).padStart(2, '0')}`;
        c.reviewed = true;
        c.source = 'seed';
        c.tags = [...new Set([c.turn.skill.id, ...(opts.tags ?? [])])];
      });
      const kept = dedupe(mine).map(relax);
      cases.push(...kept);
      goals.push(...kept.map(goalVariant).filter((g): g is EvalCase => g !== null));
    };

    await run('wip7', wipSkill(), { line: '7라인', hold_hours: 24 }, { tags: ['read'] });
    await run('wip8-photo', wipSkill(), { line: '8라인', step: 'PHOTO', hold_hours: 30 }, { tags: ['read'] });
    const fw = resolveInputs(fwSkill(), {
      src_ip: '10.10.1.15',
      dst_ip: '10.20.3.7',
      port: '1521',
      period_days: '90',
      reason: '개발 서버에서 운영 DB 조회 배치를 실행하기 위함',
    });
    await run('fw', fwSkill(), fw.values, { tags: ['write'] });
    await run('hold', holdSkill(), { lot: 'P7-00031', reason: '재검사 결과 이상 없음 확인' }, { tags: ['write', 'popup'] });
    const src = new DatasetStore();
    src.set('src', ['Lot ID', '공정', '조정수량', '사유'], [
      ['P7-00001', 'PHOTO', 5, '재측정'],
      ['P7-00002', 'ETCH', -3, '파손'],
    ]);
    await run('adjust', adjustSkill(), { source: '조정.xlsx' }, { datasets: src, tags: ['write', 'fill'] });
    await run('free-wip8', buildFreeSkill('http://localhost:4173/wip.html', false), { request: '8라인 재공 조회해서 총 몇 건인지 알려줘' }, { start: '/wip.html', tags: ['free'] });
    // 자유 요청의 보고는 정해진 문장이 없다. 답에 들어가야 할 숫자만 본다
    for (const c of cases) {
      const e = firstExpect(c);
      if (c.tags.includes('free') && e.tool === 'finish') {
        const n = /(\d+)건/.exec(String(e.args.summary))?.[1];
        e.args.summary = n ? { $contains: n } : { $any: true };
      }
    }
    cases.push(...goals);

    mkdirSync(join(OUT, '..'), { recursive: true });
    writeFileSync(OUT, `${JSON.stringify(cases, null, 1)}\n`);
    console.log(`${cases.length}개 케이스 → ${OUT}`);
  }, 120_000);
});
