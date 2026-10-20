import { directParts, parseAction, type Action } from './actions';
import { capture, evalCheck, stepCaptures, stepCheck, stripCheckLines, type Clause } from './check';
import { DatasetStore } from './dataset';
import { buildWorkbook, readDownloadedTable } from './excel';
import { extractPages } from './pages';
import { PathMemo } from './paths';
import { SUBMIT_PATTERN, checkAction, findElement, hostAllowed, optionsOf } from './policy';
import { buildSummarizeMessages, buildTurnMessages } from './prompt';
import { checkInputRules, extractSteps, fillTemplate, fillValue, type Skill, type SkillInputs } from './skill';
import { renderSnapshot } from './snapshot';
import { transform } from './transform';
import type {
  ActResult,
  ActionTarget,
  ApprovalRequest,
  BrowserPort,
  ConfirmPolicy,
  PageDialog,
  ElementItem,
  FilePort,
  HistoryEntry,
  OfficePort,
  LlmPort,
  PageSnapshot,
  PathStore,
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
  /** 엑셀 문서를 다루는 통로. 주면 excel_* 도구를 쓸 수 있다. */
  office?: OfficePort;
  datasets?: DatasetStore;
  onEvent?: (e: RunEvent) => void;
  signal?: AbortSignal;
  /** 시험 실행. 승인이 필요한 동작 직전에 멈추고 실제로 제출하지 않는다. */
  dryRun?: boolean;
  /**
   * 도구와 인자가 스킬에 적힌 단계는 모델을 부르지 않고 그대로 실행한다.
   * 그 동작이 실패하면 그 단계는 모델에게 넘긴다.
   */
  direct?: boolean;
  /**
   * 성공한 경로의 보관소. 주면 모델이 정한 동작으로 끝난 단계를 저장해 두었다가
   * 다음 실행에서 모델 없이 다시 한다. 통하지 않으면 그 단계는 모델에게 넘긴다.
   */
  paths?: PathStore;
  /**
   * 로그인 화면을 만났을 때 사람이 로그인하기를 기다리는 시간. 주면 실행을 멈추고 기다리다가,
   * 비밀번호 칸이 사라지면 그 단계부터 이어 간다. 0이거나 없으면 바로 끝낸다.
   * 에이전트는 비밀번호 칸에 입력하지 않는다 (docs/09 D9).
   */
  loginWaitMs?: number;
}

const MAX_FORMAT_RETRIES = 2;
const MAX_STRIKES = 3;
/** read_text 결과를 모델에 보여 줄 때의 최대 글자 수 */
const READ_TEXT_MAX = 4000;
/** summarize에 보내는 화면 글과 데이터셋 행의 최대 */
const SUMMARIZE_PAGE_MAX = 12000;
const SUMMARIZE_ROWS_MAX = 200;

const NO_OFFICE = '이 환경에서는 엑셀 도구를 쓸 수 없습니다 (오피스 도구 dogent-office.exe가 필요합니다)';

/** 열린 엑셀 문서를 모델에 보여 줄 글 */
export function describeDocs(docs: { name: string; fullName: string; readOnly: boolean }[]): string {
  if (docs.length === 0) return '열려 있는 엑셀 문서가 없습니다';
  return docs.map((d) => `- ${d.name}${d.readOnly ? ' (읽기 전용)' : ''} — ${d.fullName}`).join('\n');
}

const clipText = (text: string, max: number) => (text.length > max ? `${text.slice(0, max)}\n(이하 ${text.length - max}자 생략)` : text);
/** 로그인을 기다리는 동안 화면을 다시 읽는 간격 */
const LOGIN_POLL_MS = 1500;

/** ms만큼 기다린다. 중지하면 바로 끝난다. */
function pause(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((done) => {
    const t = setTimeout(done, ms);
    signal?.addEventListener('abort', () => (clearTimeout(t), done()), { once: true });
  });
}
/** 승인 요청에 현재 값으로 보여줄 입력 요소 */
const FIELD_ROLES = new Set(['textbox', 'combobox', 'checkbox', 'radio']);

type Outcome = { ok: boolean; result: string; end?: RunStatus };
/** 표 이름과 그 표에 넣은 데이터셋 */
type Fill = { table: string; dataset: string };

/** 데이터셋의 값을 화면에 넣을 글자로 바꾼다. */
const cellText = (cell: string | number) => (typeof cell === 'number' ? String(cell) : cell.trim());

export async function runSkill(skill: Skill, inputs: SkillInputs, deps: RunDeps): Promise<RunResult> {
  await deps.browser.setActive?.(true).catch(() => {});
  try {
    const memo = deps.paths ? await PathMemo.open(skill, inputs, deps.paths) : null;
    const result = await run(skill, inputs, deps, memo);
    await memo?.commit(result).catch(() => {});
    return result;
  } finally {
    await deps.browser.setActive?.(false).catch(() => {});
  }
}

async function run(skill: Skill, inputs: SkillInputs, deps: RunDeps, memo: PathMemo | null): Promise<RunResult> {
  const { llm, browser, ui, files, office, signal } = deps;
  const datasets = deps.datasets ?? new DatasetStore();
  const emit = deps.onEvent ?? (() => {});
  const started = Date.now();
  // 이 실행에서 쓸 수 있는 엑셀 문서(실행을 시작할 때 열려 있던 것). 모델이 excel_docs로 다시 볼 수 있다.
  const officeNote = office ? describeDocs(await office.docs().catch(() => [])) : undefined;
  // 로그인을 기다린 시간. 스킬의 제한 시간에서 뺀다.
  let waited = 0;
  const history: HistoryEntry[] = [];
  /** 동작마다 하기 직전 화면의 지문. 같은 동작을 되풀이해도 화면이 바뀌고 있으면 막힌 것이 아니다. */
  const screens: string[] = [];
  const savedFiles: string[] = [];
  const body = fillTemplate(skill, inputs);
  const steps = extractSteps(body);
  // 검사 줄은 루프가 평가하므로 모델에게는 보여주지 않는다.
  // 검사 식은 값을 넣기 전의 원문에서 읽고, 비교값만 따로 채운다 (값에 따옴표가 있어도 식이 깨지지 않게).
  const fill = (text: string) => fillValue(skill, inputs, text);
  const checks = extractSteps(skill.body).map((raw) =>
    stepCheck(raw)?.map((c): Clause => {
      if (c.kind === 'text' || c.kind === 'dialog') return { ...c, text: fill(c.text) };
      if (c.kind === 'value') return { ...c, expected: fill(c.expected) };
      return c;
    }) ?? null,
  );
  const promptBody = stripCheckLines(body);
  const promptSteps = steps.map(stripCheckLines);
  // 단계가 끝날 때 화면에서 읽어 둔 값. 뒤 단계의 {out.이름} 자리에 들어가고 실행 결과에도 남는다.
  const captures = extractSteps(skill.body).map(stepCaptures);
  const outputs: Record<string, string> = {};
  // inJson이면 JSON 인자의 문자열 안에 넣는 것이라 줄바꿈·따옴표를 이스케이프한다 (정리한 글은 여러 줄이다).
  const withOutputs = (text: string, inJson = false) =>
    text
      .replace(/\{out\.([a-z_][a-z0-9_]*)\}/g, (whole, name: string) =>
        name in outputs ? (inJson ? JSON.stringify(outputs[name]).slice(1, -1) : outputs[name]) : whole,
      )
      // {rows.이름}: 데이터셋의 현재 행 수. 모델이 세지 않아도 보고에 정확한 숫자가 들어간다.
      .replace(/\{rows\.([A-Za-z_][A-Za-z0-9_]*)\}/g, (whole, name: string) => {
        const ds = datasets.list().find((d) => d.name === name);
        return ds ? String(ds.rows.length) : whole;
      });
  // 지금 할 단계. 모델이 아니라 루프가 관리한다. 검사가 있는 단계는 조건이 충족되면 자동으로,
  // 없는 단계는 모델의 next_step으로 한 칸씩 넘어간다.
  let current = 1;
  let didTools = new Set<string>();
  // 지금 단계에서 페이지가 띄운 알림·확인 창의 내용. 실제 창은 뜨지 않고 내용만 받아 둔 것이다.
  let stepDialogs: string[] = [];
  // 동작이 끝난 뒤에 늦게 뜬 창. 다음 차례에 모델에게 알려준다.
  const lateDialogs: string[] = [];
  const describeDialog = (d: PageDialog) =>
    d.kind === 'alert'
      ? `알림 창: "${d.message}"`
      : `${d.kind === 'confirm' ? '확인' : '입력'} 창 "${d.message}" → ${d.accepted ? '확인' : '취소'}`;
  const unmetNow = (snap: PageSnapshot) => {
    const check = checks[current - 1];
    return check ? evalCheck(check, { snap, datasets, didTools, dialogs: stepDialogs }) : null;
  };
  let lastStep = 0;
  /** 지금 단계를 끝내고 다음 단계로 넘어간다. 그 시점의 화면에서 기록 값을 읽는다. */
  const completeStep = (snap: PageSnapshot) => {
    for (const c of captures[current - 1]) {
      outputs[c.name] = capture(c, snap, stepDialogs) ?? (c.from === 'dialog' ? '(알림 창에서 찾지 못함)' : '(화면에서 찾지 못함)');
    }
    current++;
    didTools = new Set();
    stepDialogs = [];
  };
  /** 화면 조작의 결과에 그 뒤에 뜬 창의 내용을 붙인다. 취소한 확인 창이 있으면 동작이 이뤄지지 않은 것으로 본다. */
  const acted = (r: ActResult): Outcome => {
    const shown = r.dialogs ?? [];
    if (shown.length === 0) return { ok: r.ok, result: r.message };
    stepDialogs.push(...shown.map((d) => d.message));
    const result = `${r.message}. ${shown.map(describeDialog).join(' / ')}`;
    const refused = shown.find((d) => d.kind !== 'alert' && !d.accepted);
    if (!refused) return { ok: r.ok, result };
    const hint =
      refused.kind === 'prompt'
        ? '입력 창에는 답할 수 없습니다'
        : SUBMIT_PATTERN.test(refused.message)
          ? '저장·상신 계열 확인 창은 승인받은 제출 단계의 버튼에서만 확인을 누릅니다'
          : '확인을 눌러야 하면 click의 args에 "accept_dialog": true 를 넣으세요';
    return { ok: false, result: `${result}. ${hint}` };
  };

  const end = (status: RunStatus, message: string, cause?: RunResult['cause']): RunResult => {
    const progress = `스킬 ${lastStep}/${skill.steps.length}단계, 동작 ${history.length}회 수행`;
    const full = status === 'done' ? message : `${message} (${progress})`;
    emit({ type: 'end', status, message: full });
    return {
      status,
      message: full,
      ...(cause ? { cause } : {}),
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
    return end('aborted', `입력값이 정책에 맞지 않아 시작하지 않았습니다: ${violations.join(' / ')}`, 'policy');
  }
  // 파일 입력은 호출하는 쪽이 미리 읽어 데이터셋에 넣어 둔다.
  for (const spec of skill.inputs) {
    if (spec.type !== 'file' || !spec.dataset || !(spec.name in inputs)) continue;
    if (!datasets.list().some((d) => d.name === spec.dataset)) {
      return end('aborted', `${spec.label ?? spec.name}: 파일 내용을 읽은 데이터셋 "${spec.dataset}"이 없어 시작하지 않았습니다`);
    }
  }
  // 승인을 받아 제출 버튼을 누른 단계. 같은 단계에서 두 번 제출하지 않는다.
  const submitted = new Set<number>();
  // 이번 실행에서 채운 표. 제출 전에 화면에서 다시 읽어 원본과 대조한다.
  const fills: Fill[] = [];

  /** 표를 화면에서 다시 읽어 데이터셋과 비교한다. 다른 점을 문장으로 돌려주며, 빈 배열이면 일치. */
  async function verifyFill(fill: Fill, snap: PageSnapshot): Promise<string[]> {
    const ds = datasets.get(fill.dataset);
    const el = snap.items.find((i): i is ElementItem => i.kind === 'el' && i.role === 'table' && i.name === fill.table);
    if (!el) return [`표 "${fill.table}"을(를) 화면에서 찾을 수 없음`];
    const screen = await browser.extractTable(el.ref);
    const idx = ds.columns.map((c) => screen.columns.indexOf(c));
    const missing = ds.columns.filter((_, i) => idx[i] < 0);
    if (missing.length > 0) return [`표에 ${missing.join(', ')} 컬럼이 없음`];
    // 값이 하나라도 들어 있는 행만 본다 (표 끝의 빈 행은 무시).
    const filled = screen.rows.filter((r) => idx.some((i) => r[i] !== ''));
    if (filled.length !== ds.rows.length) return [`화면에 ${filled.length}행, 원본은 ${ds.rows.length}행`];
    const diffs: string[] = [];
    ds.rows.forEach((row, r) =>
      row.forEach((cell, c) => {
        const want = cellText(cell);
        const got = filled[r][idx[c]];
        if (got !== want && diffs.length < 5) {
          diffs.push(`${r + 1}행 "${ds.columns[c]}": 화면 "${got}", 원본 "${want}"`);
        }
      }),
    );
    return diffs;
  }

  // 직전 차례의 화면 줄. ref 번호는 화면이 바뀌면 달라지므로 떼고 비교한다.
  let seenLines: Set<string> | null = null;
  const MAX_CHANGES = 10;

  async function decide(n: number, snap: PageSnapshot): Promise<Action> {
    const page = renderSnapshot(snap);
    const lines = page.split('\n').map((l) => l.replace(/^\[\d+\] /, ''));
    const late = lateDialogs.splice(0);
    const fresh = seenLines && lines.filter((l) => !seenLines!.has(l)).slice(0, MAX_CHANGES);
    const changes = fresh || late.length > 0 ? [...late, ...(fresh ?? [])] : null;
    seenLines = new Set(lines);
    let messages = buildTurnMessages({
      skill,
      body: withOutputs(promptBody),
      inputs,
      history,
      datasets: datasets.describe(),
      office: officeNote,
      page,
      changes,
      step: { n: current, total: steps.length, text: withOutputs(promptSteps[current - 1]), unmet: unmetNow(snap) },
    });
    for (let attempt = 0; ; attempt++) {
      const text = await llm.complete(messages, signal);
      const parsed = parseAction(text, snap);
      if (parsed.ok) return parsed.action;
      if (attempt >= MAX_FORMAT_RETRIES) {
        throw new Error(`모델이 형식에 맞는 응답을 내지 못했습니다: ${parsed.error}`);
      }
      emit({ type: 'llm_retry', n, reason: parsed.error, raw: text.slice(0, 400) });
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

  /** approved는 사용자 승인을 받은 저장·상신 버튼을 누르는 경우다. */
  async function execute(action: Action, snap: PageSnapshot, approved = false): Promise<Outcome> {
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
        // 승인받은 제출의 확인 창은 확인을 누른다. 그 밖에는 스킬이 요청한 경우에만, 저장·상신을 묻는 창이 아닐 때 누른다.
        const confirm: ConfirmPolicy | undefined = approved
          ? { accept: true }
          : action.args.accept_dialog
            ? { accept: true, unless: SUBMIT_PATTERN.source }
            : undefined;
        return acted(await browser.click(action.args.ref, confirm));
      }
      case 'close_tab': {
        if (!browser.closeTab) return { ok: false, result: '이 환경에서는 창을 닫을 수 없습니다' };
        return acted(await browser.closeTab());
      }
      case 'type':
        return acted(await browser.type(action.args.ref, action.args.text));
      case 'select':
        return acted(await browser.select(action.args.ref, action.args.value));
      case 'wait_for': {
        const found = await browser.waitFor(action.args.text, action.args.timeout_sec * 1000);
        return found
          ? { ok: true, result: '화면에 나타남' }
          : { ok: false, result: `${action.args.timeout_sec}초 안에 나타나지 않음` };
      }
      case 'extract_table': {
        const { dataset, append } = action.args;
        let firstRows = 0;
        const pages = await extractPages(browser, snap, action.args.ref, action.args.next_ref, (table, first) => {
          if (first) firstRows = table.rows.length;
          datasets.put(dataset, table, first ? append : true);
        });
        const ds = datasets.get(dataset);
        return {
          ok: true,
          result:
            action.args.next_ref === undefined
              ? `${firstRows}행 추출, "${ds.name}" 누적 ${ds.rows.length}행`
              : `${pages}페이지 추출, "${ds.name}" 누적 ${ds.rows.length}행`,
        };
      }
      case 'download_table': {
        if (!browser.download) return { ok: false, result: '이 환경에서는 파일 내려받기를 쓸 수 없습니다. extract_table로 표를 추출하세요' };
        // 페이지가 직접 만든 파일(blob:)은 그 페이지의 주소로, 서버에서 받는 파일은 받는 주소로 허용 도메인을 본다.
        const allowed = (url: string) => url.startsWith('data:') || hostAllowed(url.replace(/^blob:/, ''), skill.domains);
        const file = await browser.download(action.args.ref, action.args.timeout_sec * 1000, allowed);
        const table = await readDownloadedTable(file.data);
        const ds = datasets.set(action.args.dataset, table.columns, table.rows);
        return { ok: true, result: `${file.filename} 내려받음, "${ds.name}" ${ds.rows.length}행` };
      }
      case 'fill_table': {
        const ds = datasets.get(action.args.dataset);
        if (ds.rows.length === 0) return { ok: false, result: `"${ds.name}"에 입력할 행이 없습니다` };
        const tableEl = findElement(snap, action.args.ref)!;
        const rows = ds.rows.map((r) => r.map(cellText));
        const r = await browser.fillTable(action.args.ref, ds.columns, rows, action.args.add_ref);
        if (!r.ok) return acted(r);
        stepDialogs.push(...(r.dialogs ?? []).map((d) => d.message));
        // 넣은 값을 화면에서 다시 읽어 원본과 대조한다. 다르면 실패로 돌려 다음 단계로 넘어가지 못하게 한다.
        const fill: Fill = { table: tableEl.name, dataset: ds.name };
        const diffs = await verifyFill(fill, await browser.snapshot());
        if (diffs.length > 0) return { ok: false, result: `입력 후 대조 실패: ${diffs.join(' / ')}` };
        fills.push(fill);
        return { ok: true, result: `${r.message}. 화면 값이 "${ds.name}"과 일치함` };
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
      case 'excel_docs': {
        if (!office) return { ok: false, result: NO_OFFICE };
        const docs = await office.docs();
        return { ok: true, result: describeDocs(docs) };
      }
      case 'excel_read': {
        if (!office) return { ok: false, result: NO_OFFICE };
        const { doc, dataset, sheet, range } = action.args;
        const t = await office.read(doc, { sheet, range });
        const ds = datasets.set(dataset, t.columns, t.rows);
        const more = t.total > ds.rows.length ? ` (표 전체 ${t.total}행 중 ${ds.rows.length}행)` : '';
        return {
          ok: true,
          result: `"${doc}" 시트 "${t.sheet}"을(를) "${ds.name}"에 읽음: ${ds.rows.length}행${more}, 컬럼 ${JSON.stringify(ds.columns)}. 문서의 시트: ${t.sheets.join(', ')}`,
        };
      }
      case 'excel_write':
      case 'excel_save': {
        if (!office) return { ok: false, result: NO_OFFICE };
        const { doc } = action.args;
        const inPlace = action.tool === 'excel_save' && !action.args.path;
        const what =
          action.tool === 'excel_write'
            ? `"${doc}" 문서의 "${action.args.sheet}" 시트에 "${action.args.dataset}"(${datasets.get(action.args.dataset).rows.length}행)을 씁니다`
            : inPlace
              ? `"${doc}" 문서를 열린 곳에 저장합니다 (원본이 바뀝니다)`
              : `"${doc}" 문서를 "${action.args.path}"에 다른 이름으로 저장합니다`;
        if (deps.dryRun) return { ok: true, result: `시험 실행이라 하지 않았습니다: ${what}`, end: 'dryrun' };
        if (!ui.confirm || !(await ui.confirm(what + '. 진행할까요?'))) {
          return { ok: false, result: `사용자가 허락하지 않았습니다: ${what}` };
        }
        if (action.tool === 'excel_write') {
          const ds = datasets.get(action.args.dataset);
          const at = await office.write(doc, action.args.sheet, { columns: ds.columns, rows: ds.rows }, action.args.start);
          return { ok: true, result: `${at}에 ${ds.rows.length}행을 씀 (저장은 아직 안 함. 저장하려면 excel_save)` };
        }
        const saved = await office.save(doc, action.args.path);
        return { ok: true, result: `${saved}에 저장함` };
      }
      case 'read_text': {
        if (!browser.readText) return { ok: false, result: '이 환경에서는 화면 글을 읽을 수 없습니다' };
        const text = await browser.readText(action.args.ref);
        return { ok: true, result: clipText(text, READ_TEXT_MAX) || '(보이는 글이 없습니다)' };
      }
      case 'summarize': {
        const { instruction, source, name } = action.args;
        let material: string;
        let what: string;
        if (source === 'page') {
          if (!browser.readText) return { ok: false, result: '이 환경에서는 화면 글을 읽을 수 없습니다' };
          material = clipText(await browser.readText(), SUMMARIZE_PAGE_MAX);
          what = `화면의 글 (${snap.title})`;
        } else {
          const ds = datasets.get(source);
          // 데이터셋은 앞부분 행만 보낸다. 많으면 스킬이 transform으로 먼저 줄여 두어야 한다.
          const rows = ds.rows.slice(0, SUMMARIZE_ROWS_MAX);
          material = [ds.columns.join('\t'), ...rows.map((r) => r.map(cellText).join('\t'))].join('\n');
          what = `데이터셋 "${ds.name}" (${ds.rows.length}행${ds.rows.length > rows.length ? `, 앞의 ${rows.length}행만` : ''})`;
        }
        if (!material.trim()) return { ok: false, result: `정리할 자료가 비어 있습니다: ${what}` };
        const text = (await llm.complete(buildSummarizeMessages(instruction, what, material), signal)).trim();
        if (!text) return { ok: false, result: '모델이 정리한 내용을 돌려주지 않았습니다' };
        outputs[name] = text;
        return { ok: true, result: `${what}을(를) 정리해 {out.${name}}에 남김: ${clipText(text, 300)}` };
      }
      case 'ask_user': {
        const answer = await ui.ask(action.args.question);
        return { ok: true, result: `사용자 답변: ${answer}` };
      }
      case 'finish':
        // 모델이 쓴 보고에도 {rows.이름}, {out.이름}을 채운다. 숫자와 정리한 글을 모델이 옮겨 적지 않아도 된다.
        return { ok: true, result: withOutputs(action.args.summary), end: 'done' };
      case 'abort':
        return { ok: true, result: action.args.reason, end: 'aborted' };
    }
  }

  // 단계가 "도구로 ..."로 시작하고 `{...}` 인자가 적혀 있으면 모델 없이 그대로 실행한다.
  // 단계마다 한 번만 시도한다. 실패하거나 한 번으로 단계가 끝나지 않으면 그 뒤는 모델이 맡는다.
  const directTried = new Set<number>();
  function directAction(snap: PageSnapshot): Action | null {
    if (!deps.direct || directTried.has(current)) return null;
    const parts = directParts(promptSteps[current - 1]);
    if (!parts) return null;
    directTried.add(current);
    try {
      const reply = JSON.stringify({
        thought: '스킬에 적힌 대로 실행',
        tool: parts.tool,
        args: JSON.parse(withOutputs(parts.literal, true)),
      });
      const parsed = parseAction(reply, snap);
      return parsed.ok ? parsed.action : null;
    } catch {
      return null;
    }
  }

  let strikes = 0;
  let firstFailure = '';
  try {
    for (let n = 1; n <= skill.limits.max_steps; n++) {
      if (signal?.aborted) return end('stopped', '사용자가 중지했습니다');
      if (Date.now() - started - waited > skill.limits.timeout_sec * 1000) {
        return end('aborted', `제한 시간 ${skill.limits.timeout_sec}초를 넘었습니다`);
      }

      let snap = await browser.snapshot();
      emit({ type: 'observe', n, url: snap.url, title: snap.title });
      if (snap.hasPassword) {
        const waitMs = deps.loginWaitMs ?? 0;
        if (waitMs <= 0) return end('aborted', '로그인 화면이 감지되었습니다. 직접 로그인한 뒤 다시 실행해 주세요', 'login');
        // 사람이 이 탭에서 로그인하기를 기다린다. 그동안은 조작 중 표시를 끄고 화면을 사람에게 넘긴다.
        emit({ type: 'login_wait', url: snap.url, timeoutSec: Math.round(waitMs / 1000) });
        const since = Date.now();
        await browser.setActive?.(false).catch(() => {});
        while (snap.hasPassword) {
          if (signal?.aborted) return end('stopped', '사용자가 중지했습니다');
          if (Date.now() - since >= waitMs) {
            return end('aborted', `로그인이 필요합니다. ${Math.round(waitMs / 60000) || 1}분 안에 로그인하지 않아 멈췄습니다`, 'login');
          }
          await pause(Math.min(LOGIN_POLL_MS, waitMs), signal);
          snap = await browser.snapshot();
        }
        waited += Date.now() - since;
        await browser.setActive?.(true).catch(() => {});
        emit({ type: 'login_done', url: snap.url });
      }
      if (snap.dialogs?.length) {
        stepDialogs.push(...snap.dialogs.map((d) => d.message));
        lateDialogs.push(...snap.dialogs.map(describeDialog));
      }

      // 검사가 충족된 단계는 모델을 부르지 않고 넘긴다.
      while (current < steps.length && unmetNow(snap)?.length === 0) {
        emit({ type: 'step_done', step: current });
        completeStep(snap);
      }

      const direct = directAction(snap);
      const remembered = direct ? null : (memo?.next(current, snap, (text) => withOutputs(fill(text))) ?? null);
      const action = direct ?? remembered ?? (await decide(n, snap));
      const by = direct ? 'skill' : remembered ? 'cache' : 'model';
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
        // 채운 표도 지금 화면 기준으로 다시 대조한다.
        if (!submitted.has(current)) {
          for (const fill of fills) drift.push(...(await verifyFill(fill, snap)));
        }
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
            tables: fills.map((f) => {
              const ds = datasets.get(f.dataset);
              return {
                name: f.table,
                dataset: f.dataset,
                columns: ds.columns,
                rowCount: ds.rows.length,
                preview: ds.rows.slice(0, 10).map((r) => r.map(cellText)),
              };
            }),
          };
          if (deps.dryRun) {
            emit({ type: 'approval', n, request, approved: false, dryRun: true });
            return end('dryrun', `시험 실행이라 "${button}" 직전에 멈췄습니다. 화면의 입력 내용은 그대로 남아 있습니다`);
          }
          const approved = await ui.approve(request);
          emit({ type: 'approval', n, request, approved, dryRun: false });
          if (!approved) return end('aborted', `사용자가 "${button}"을(를) 승인하지 않았습니다`, 'user');
          submitted.add(current);
          try {
            outcome = await execute(action, snap, true);
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
        by,
        ...targetsOf(action.args as Record<string, unknown>, snap),
      };
      history.push(entry);
      screens.push(screenPrint(snap));
      emit({ type: 'action', entry });

      if (outcome.ok) didTools.add(action.tool);
      if (by === 'cache' && !outcome.ok) memo?.fail(current);
      if (by !== 'skill' && outcome.ok && !outcome.end) memo?.record(current, action, snap, outputs, by);

      if (outcome.end) return end(outcome.end, outcome.result);

      strikes = outcome.ok ? 0 : strikes + 1;
      if (strikes === 1) firstFailure = outcome.result;
      if (strikes >= MAX_STRIKES) {
        // 원인은 보통 첫 실패에 있고, 뒤의 실패는 모델이 다른 시도를 하다 난 것이다.
        const cause =
          firstFailure === outcome.result
            ? `오류: ${outcome.result}`
            : `처음 오류: ${firstFailure} / 마지막 오류: ${outcome.result}`;
        return end('aborted', `동작이 ${MAX_STRIKES}번 연속 실패했습니다. ${cause}`);
      }
      // 막힘: 한 단계 안에서 같은 동작을 세 번 했는데 그동안 화면이 그대로다.
      // "행 추가"를 여러 번 누르거나 다음 페이지로 넘기는 것처럼 화면이 바뀌면 되풀이해도 괜찮다.
      // 녹화한 스킬에서 같은 버튼을 이어 누르는 단계들은 단계가 달라 해당하지 않는다.
      const last3 = history.slice(-3);
      const key = (h: HistoryEntry) => `${h.step}|${h.tool}${JSON.stringify(h.args)}`;
      if (
        action.tool !== 'next_step' &&
        last3.length === 3 &&
        last3.every((h) => key(h) === key(last3[0])) &&
        screens.slice(-3).every((s) => s === screens.at(-1))
      ) {
        return end('aborted', `같은 동작(${action.tool})을 3번 했지만 화면이 바뀌지 않아 중단했습니다`);
      }
    }
    return end('aborted', `최대 동작 수 ${skill.limits.max_steps}회를 넘었습니다`);
  } catch (e) {
    if (signal?.aborted) return end('stopped', '사용자가 중지했습니다');
    return end('error', (e as Error).message);
  }
}

/** 동작이 가리킨 요소의 이름을 남긴다. 실행을 스킬로 저장할 때 번호 대신 이 이름을 쓴다. */
function targetsOf(args: Record<string, unknown>, snap: PageSnapshot): { targets?: Record<string, ActionTarget> } {
  const targets: Record<string, ActionTarget> = {};
  for (const key of ['ref', 'next_ref', 'add_ref']) {
    if (typeof args[key] !== 'number') continue;
    const el = findElement(snap, args[key] as number);
    if (!el || !el.name.trim()) continue;
    const same = snap.items.filter((i) => i.kind === 'el' && i.role === el.role && i.name === el.name).length;
    const options = optionsOf(el);
    targets[key] = { role: el.role, name: el.name, dup: same > 1, ...(el.row ? { row: el.row } : {}), ...(options ? { options } : {}) };
  }
  return Object.keys(targets).length ? { targets } : {};
}

/** 화면의 지문. 주소와 읽은 화면 글이 같으면 같은 화면으로 본다. */
function screenPrint(snap: PageSnapshot): string {
  const text = `${snap.url}
${renderSnapshot(snap)}`;
  let h = 5381;
  for (let i = 0; i < text.length; i++) h = ((h * 33) ^ text.charCodeAt(i)) >>> 0;
  return `${text.length}:${h.toString(36)}`;
}
