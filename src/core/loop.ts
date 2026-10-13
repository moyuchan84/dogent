import { parseAction, type Action } from './actions';
import { evalCheck, stepCheck, stripCheckLines } from './check';
import { DatasetStore } from './dataset';
import { buildWorkbook } from './excel';
import { checkAction, findElement } from './policy';
import { buildTurnMessages } from './prompt';
import { extractSteps, fillTemplate, type Skill, type SkillInputs } from './skill';
import { renderSnapshot } from './snapshot';
import { transform } from './transform';
import type {
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
}

const MAX_FORMAT_RETRIES = 2;
const MAX_STRIKES = 3;
const MAX_PAGES = 500;

type Outcome = { ok: boolean; result: string; end?: RunStatus };

export async function runSkill(skill: Skill, inputs: SkillInputs, deps: RunDeps): Promise<RunResult> {
  const { llm, browser, ui, files, signal } = deps;
  const datasets = deps.datasets ?? new DatasetStore();
  const emit = deps.onEvent ?? (() => {});
  const started = Date.now();
  const history: HistoryEntry[] = [];
  const savedFiles: string[] = [];
  const body = fillTemplate(skill, inputs);
  const steps = extractSteps(body);
  // 검사 줄은 루프가 평가하므로 모델에게는 보여주지 않는다.
  const checks = steps.map(stepCheck);
  const promptBody = stripCheckLines(body);
  const promptSteps = steps.map(stripCheckLines);
  // 지금 할 단계. 모델이 아니라 루프가 관리한다. 검사가 있는 단계는 조건이 충족되면 자동으로,
  // 없는 단계는 모델의 next_step으로 한 칸씩 넘어간다.
  let current = 1;
  let didTools = new Set<string>();
  const unmetNow = (snap: PageSnapshot) => {
    const check = checks[current - 1];
    return check ? evalCheck(check, { snap, datasets, didTools }) : null;
  };
  let lastStep = 0;

  const end = (status: RunStatus, message: string): RunResult => {
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
      elapsedMs: Date.now() - started,
    };
  };

  if (skill.risk === 'R3') {
    return end('aborted', '저장·상신이 포함된 스킬(R3)은 승인 기능이 들어가는 다음 단계부터 지원합니다');
  }

  async function decide(n: number, snap: PageSnapshot): Promise<Action> {
    let messages = buildTurnMessages({
      skill,
      body: promptBody,
      inputs,
      history,
      datasets: datasets.describe(),
      page: renderSnapshot(snap),
      step: { n: current, total: steps.length, text: promptSteps[current - 1], unmet: unmetNow(snap) },
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
        current++;
        didTools = new Set();
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
        current++;
        didTools = new Set();
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
