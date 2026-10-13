import { parseAction, type Action } from './actions';
import { capture, evalCheck, stepCaptures, stepCheck, stripCheckLines, type Clause } from './check';
import { DatasetStore } from './dataset';
import { buildWorkbook } from './excel';
import { checkAction, findElement } from './policy';
import { buildTurnMessages } from './prompt';
import { checkInputRules, extractSteps, fillTemplate, fillValue, type Skill, type SkillInputs } from './skill';
import { renderSnapshot } from './snapshot';
import { transform } from './transform';
import type {
  ApprovalRequest,
  BrowserPort,
  ElementItem,
  FilePort,
  HistoryEntry,
  LlmPort,
  PageSnapshot,
  RunEvent,
  RunResult,
  RunStatus,
  UiPort,
} from './types';

export interface RunDeps {
  llm: LlmPort;
  browser: BrowserPort;
  ui: UiPort;
  files: FilePort;
  datasets?: DatasetStore;
  onEvent?: (e: RunEvent) => void;
  signal?: AbortSignal;
  /** 시험 실행. 승인이 필요한 동작 직전에 멈추고 실제로 제출하지 않는다. */
  dryRun?: boolean;
}

const MAX_FORMAT_RETRIES = 2;
const MAX_STRIKES = 3;
const MAX_PAGES = 500;
/** 승인 요청에 현재 값으로 보여줄 입력 요소 */
const FIELD_ROLES = new Set(['textbox', 'combobox', 'checkbox', 'radio']);

type Outcome = { ok: boolean; result: string; end?: RunStatus };

export async function runSkill(skill: Skill, inputs: SkillInputs, deps: RunDeps): Promise<RunResult> {
  await deps.browser.setActive?.(true).catch(() => {});
  try {
    return await run(skill, inputs, deps);
  } finally {
    await deps.browser.setActive?.(false).catch(() => {});
  }
}

async function run(skill: Skill, inputs: SkillInputs, deps: RunDeps): Promise<RunResult> {
  const { llm, browser, ui, files, signal } = deps;
  const datasets = deps.datasets ?? new DatasetStore();
  const emit = deps.onEvent ?? (() => {});
  const started = Date.now();
  const history: HistoryEntry[] = [];
  const savedFiles: string[] = [];
  const body = fillTemplate(skill, inputs);
  const steps = extractSteps(body);
  // 검사 줄은 루프가 평가하므로 모델에게는 보여주지 않는다.
  // 검사 식은 값을 넣기 전의 원문에서 읽고, 비교값만 따로 채운다 (값에 따옴표가 있어도 식이 깨지지 않게).
  const fill = (text: string) => fillValue(skill, inputs, text);
  const checks = extractSteps(skill.body).map((raw) =>
    stepCheck(raw)?.map((c): Clause => {
      if (c.kind === 'text') return { ...c, text: fill(c.text) };
      if (c.kind === 'value') return { ...c, expected: fill(c.expected) };
      return c;
    }) ?? null,
  );
  const promptBody = stripCheckLines(body);
  const promptSteps = steps.map(stripCheckLines);
  // 단계가 끝날 때 화면에서 읽어 둔 값. 뒤 단계의 {out.이름} 자리에 들어가고 실행 결과에도 남는다.
  const captures = extractSteps(skill.body).map(stepCaptures);
  const outputs: Record<string, string> = {};
  const withOutputs = (text: string) =>
    text.replace(/\{out\.([a-z_][a-z0-9_]*)\}/g, (whole, name: string) => outputs[name] ?? whole);
  // 지금 할 단계. 모델이 아니라 루프가 관리한다. 검사가 있는 단계는 조건이 충족되면 자동으로,
  // 없는 단계는 모델의 next_step으로 한 칸씩 넘어간다.
  let current = 1;
  let didTools = new Set<string>();
  const unmetNow = (snap: PageSnapshot) => {
    const check = checks[current - 1];
    return check ? evalCheck(check, { snap, datasets, didTools }) : null;
  };
  let lastStep = 0;
  /** 지금 단계를 끝내고 다음 단계로 넘어간다. 그 시점의 화면에서 기록 값을 읽는다. */
  const completeStep = (snap: PageSnapshot) => {
    for (const c of captures[current - 1]) outputs[c.name] = capture(c, snap) ?? '(화면에서 찾지 못함)';
    current++;
    didTools = new Set();
  };

  const end =(status: RunStatus, message: string): RunResult => {
    const progress = `스킬 ${lastStep}/${skill.steps.length}단계, 동작 ${history.length}회 수행`;
    const full = status === 'done' ? message : `${message} (${progress})`;
    emit({ type: 'end', status, message: full });
    return {
      status,
      message: full,
      lastStep,
      actions: history.length,
      files: savedFiles,
      datasets: datasets.info(),
      outputs,
      elapsedMs: Date.now() - started,
    };
  };

  // 입력값 정책은 화면에 접속하기 전에 적용한다. 호출하는 쪽이 검증을 빠뜨려도 여기서 막는다.
  const violations = checkInputRules(skill, inputs);
  if (violations.length > 0) {
    return end('aborted', `입력값이 정책에 맞지 않아 시작하지 않았습니다: ${violations.join(' / ')}`);
  }
  // 승인을 받아 제출 버튼을 누른 단계. 같은 단계에서 두 번 제출하지 않는다.
  const submitted = new Set<number>();

  async function decide(n: number, snap: PageSnapshot): Promise<Action> {
    let messages = buildTurnMessages({
      skill,
      body: withOutputs(promptBody),
      inputs,
      history,
      datasets: datasets.describe(),
      page: renderSnapshot(snap),
      step: { n: current, total: steps.length, text: withOutputs(promptSteps[current - 1]), unmet: unmetNow(snap) },
    });
    for (let attempt = 0; ; attempt++) {
      const text = await llm.complete(messages, signal);
      const parsed = parseAction(text, snap);
      if (parsed.ok) return parsed.action;
      if (attempt >= MAX_FORMAT_RETRIES) {
        throw new Error(`모델이 형식에 맞는 응답을 내지 못했습니다: ${parsed.error}`);
      }
      emit({ type: 'llm_retry', n, reason: parsed.error });
      messages = [
        ...messages,
        { role: 'assistant', content: text },
        {
          role: 'user',
          content: `응답 형식이 잘못됐습니다.\n${parsed.error}\nJSON 객체 하나로만 다시 답하세요.`,
        },
      ];
    }
  }

  async function execute(action: Action, snap: PageSnapshot): Promise<Outcome> {
    switch (action.tool) {
      case 'next_step': {
        if (current >= steps.length) {
          return { ok: false, result: '마지막 단계입니다. finish로 결과를 보고하세요' };
        }
        completeStep(snap);
        return { ok: true, result: `${current}단계로 넘어감` };
      }
      case 'navigate': {
        const r = await browser.navigate(action.args.url);
        return { ok: r.ok, result: r.message };
      }
      case 'click': {
        const r = await browser.click(action.args.ref);
        return { ok: r.ok, result: r.message };
      }
      case 'type': {
        const r = await browser.type(action.args.ref, action.args.text);
        return { ok: r.ok, result: r.message };
      }
      case 'select': {
        const r = await browser.select(action.args.ref, action.args.value);
        return { ok: r.ok, result: r.message };
      }
      case 'wait_for': {
        const found = await browser.waitFor(action.args.text, action.args.timeout_sec * 1000);
        return found
          ? { ok: true, result: '화면에 나타남' }
          : { ok: false, result: `${action.args.timeout_sec}초 안에 나타나지 않음` };
      }
      case 'extract_table': {
        const table = await browser.extractTable(action.args.ref);
        const ds = datasets.put(action.args.dataset, table, action.args.append);
        if (action.args.next_ref === undefined) {
          return {
            ok: true,
            result: `${table.rows.length}행 추출, "${ds.name}" 누적 ${ds.rows.length}행`,
          };
        }
        // 페이지 넘김은 판단이 필요 없는 반복이라 모델을 거치지 않고 여기서 끝까지 돈다.
        // ref는 화면이 바뀌면 새로 매겨지므로 표와 버튼을 역할·이름으로 다시 찾는다.
        const tableEl = findElement(snap, action.args.ref)!;
        const nextEl = findElement(snap, action.args.next_ref)!;
        const again = (s: PageSnapshot, like: ElementItem) =>
          s.items.find((i): i is ElementItem => i.kind === 'el' && i.role === like.role && i.name === like.name);
        let pages = 1;
        for (let s = snap; pages < MAX_PAGES; pages++) {
          const next = again(s, nextEl);
          if (!next || next.disabled) break;
          const clicked = await browser.click(next.ref);
          if (!clicked.ok) throw new Error(`"${nextEl.name}" 클릭 실패: ${clicked.message}`);
          s = await browser.snapshot();
          const t = again(s, tableEl);
          if (!t) throw new Error(`${pages + 1}페이지에서 표 "${tableEl.name}"을(를) 찾지 못했습니다`);
          datasets.put(action.args.dataset, await browser.extractTable(t.ref), true);
        }
        return { ok: true, result: `${pages}페이지 추출, "${ds.name}" 누적 ${ds.rows.length}행` };
      }
      case 'transform': {
        const out = transform(datasets.get(action.args.source), action.args.steps);
        datasets.set(action.args.target, out.columns, out.rows);
        return {
          ok: true,
          result: `"${action.args.target}" ${out.rows.length}행, 컬럼 ${JSON.stringify(out.columns)}`,
        };
      }
      case 'write_excel': {
        const sheets = action.args.sheets.map((s) => ({ name: s.name, dataset: datasets.get(s.dataset) }));
        const base = action.args.filename.replace(/[\\/:*?"<>|]/g, '_').replace(/\.xlsx$/i, '');
        const filename = `${base}.xlsx`;
        await files.save(filename, await buildWorkbook(sheets));
        savedFiles.push(filename);
        return { ok: true, result: `${filename} 저장 (시트 ${sheets.length}개)` };
      }
      case 'ask_user': {
        const answer = await ui.ask(action.args.question);
        return { ok: true, result: `사용자 답변: ${answer}` };
      }
      case 'finish':
        return { ok: true, result: action.args.summary, end: 'done' };
      case 'abort':
        return { ok: true, result: action.args.reason, end: 'aborted' };
    }
  }

  let strikes = 0;
  try {
    for (let n = 1; n <= skill.limits.max_steps; n++) {
      if (signal?.aborted) return end('stopped', '사용자가 중지했습니다');
      if (Date.now() - started > skill.limits.timeout_sec * 1000) {
        return end('aborted', `제한 시간 ${skill.limits.timeout_sec}초를 넘었습니다`);
      }

      const snap = await browser.snapshot();
      emit({ type: 'observe', n, url: snap.url, title: snap.title });
      if (snap.hasPassword) {
        return end('aborted', '로그인 화면이 감지되었습니다. 직접 로그인한 뒤 다시 실행해 주세요');
      }

      // 검사가 충족된 단계는 모델을 부르지 않고 넘긴다.
      while (current < steps.length && unmetNow(snap)?.length === 0) {
        emit({ type: 'step_done', step: current });
        completeStep(snap);
      }

      const action = await decide(n, snap);
      action.step = current;
      lastStep = current;

      const verdict = checkAction(action, snap, skill);
      // 작은 모델은 "이 단계 끝"을 finish로 잘못 표현하곤 한다. 중간 단계에서 끝난 실행이
      // "완료"로 보이면 안 되므로 finish는 마지막 단계에서만 받고, 조기 종료는 abort로만 한다.
      const earlyFinish = action.tool === 'finish' && current < steps.length;
      const unmet = action.tool === 'next_step' ? unmetNow(snap) : null;
      let outcome: Outcome;
      if (unmet) {
        outcome = { ok: false, result: `이 단계는 아직 끝나지 않았습니다: ${unmet.join(' / ')}` };
      } else if (earlyFinish) {
        outcome = {
          ok: false,
          result: `아직 ${current}/${steps.length}단계라서 finish할 수 없습니다. 이 단계가 끝났으면 next_step을 쓰세요. "예외" 절에 따라 여기서 그만둬야 하면 abort를 쓰세요`,
        };
      } else if (!verdict.ok) {
        emit({ type: 'blocked', n, tool: action.tool, reason: verdict.reason });
        outcome = { ok: false, result: `차단됨: ${verdict.reason}` };
      } else if (verdict.approval) {
        const button = verdict.approval.name;
        // 제출 전 대조: 앞 단계에서 확인한 입력값이 지금 화면에도 그대로인지 다시 본다.
        const drift = checks
          .slice(0, current - 1)
          .flatMap((c) => (c ? evalCheck(c.filter((x) => x.kind === 'value'), { snap, datasets, didTools }) : []));
        if (submitted.has(current)) {
          outcome = { ok: false, result: `이 단계에서 이미 "${button}"을(를) 눌렀습니다. 다시 누르지 않습니다` };
        } else if (drift.length > 0) {
          outcome = { ok: false, result: `제출 전 대조 실패, "${button}"을(를) 누르지 않았습니다: ${drift.join(' / ')}` };
        } else {
          const request: ApprovalRequest = {
            skill: skill.name,
            button,
            url: snap.url,
            fields: snap.items.flatMap((i) =>
              i.kind === 'el' && FIELD_ROLES.has(i.role) ? [{ name: i.name, value: i.value ?? '' }] : [],
            ),
          };
          if (deps.dryRun) {
            emit({ type: 'approval', n, request, approved: false, dryRun: true });
            return end('dryrun', `시험 실행이라 "${button}" 직전에 멈췄습니다. 화면의 입력 내용은 그대로 남아 있습니다`);
          }
          const approved = await ui.approve(request);
          emit({ type: 'approval', n, request, approved, dryRun: false });
          if (!approved) return end('aborted', `사용자가 "${button}"을(를) 승인하지 않았습니다`);
          submitted.add(current);
          try {
            outcome = await execute(action, snap);
          } catch (e) {
            if (signal?.aborted) throw e;
            outcome = { ok: false, result: (e as Error).message };
          }
        }
      } else {
        try {
          outcome = await execute(action, snap);
        } catch (e) {
          if (signal?.aborted) throw e;
          outcome = { ok: false, result: (e as Error).message };
        }
      }

      const entry: HistoryEntry = {
        n,
        step: action.step,
        tool: action.tool,
        args: action.args as Record<string, unknown>,
        thought: action.thought,
        ok: outcome.ok,
        result: outcome.result,
      };
      history.push(entry);
      emit({ type: 'action', entry });

      if (outcome.ok) didTools.add(action.tool);

      if (outcome.end) return end(outcome.end, outcome.result);

      strikes = outcome.ok ? 0 : strikes + 1;
      if (strikes >= MAX_STRIKES) {
        return end('aborted', `동작이 ${MAX_STRIKES}번 연속 실패했습니다. 마지막 오류: ${outcome.result}`);
      }
      const last3 = history.slice(-3).map((h) => `${h.tool}${JSON.stringify(h.args)}`);
      if (action.tool !== 'next_step' && last3.length === 3 && last3.every((s) => s === last3[0])) {
        return end('aborted', `같은 동작(${action.tool})을 3번 반복해 중단했습니다`);
      }
    }
    return end('aborted', `최대 동작 수 ${skill.limits.max_steps}회를 넘었습니다`);
  } catch (e) {
    if (signal?.aborted) return end('stopped', '사용자가 중지했습니다');
    return end('error', (e as Error).message);
  }
}
