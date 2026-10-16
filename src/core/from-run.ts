import { PARAM_NAME, type AuthorStep, type DraftMeta, type DraftStart } from './author';
import type { HistoryEntry } from './types';

/**
 * 자유 요청 실행을 스킬로 저장한다.
 *
 * 말로 시켜서 잘 된 실행의 동작을 녹화한 조작과 같은 모양(AuthorStep)으로 바꾼다. 그러면 녹화와
 * 똑같이 매개변수 이름·설명, 목적, 말로 적은 단계를 고친 뒤 초안을 만들 수 있다.
 *
 * - 성공한 동작만 쓴다. 모델이 헤매다 실패한 동작은 버린다.
 * - 요소는 번호가 아니라 실행할 때 남긴 이름(targets)으로 적는다. 이름이 없는 동작은 버리고 알린다.
 * - 입력한 값이 요청 문장에 있으면 실행할 때마다 받는 매개변수로 제안한다 ("DR5 검색해줘"의 DR5).
 * - 마지막에는 요청 문장을 목표 단계로 둔다. 모델이 화면을 보고 그 요청에 답하며 끝낸다.
 *   요청의 값은 매개변수 자리표시자로 바꿔 둬, 다른 값으로 실행하면 그 값으로 답한다.
 */
export interface RunAsSkill {
  start: DraftStart;
  steps: AuthorStep[];
  meta: DraftMeta;
  notes: string[];
}

/** 라벨에 이 말이 들어 있으면 매개변수 이름으로 제안한다. 앞의 것이 먼저다. */
const NAME_HINTS: [RegExp, string][] = [
  [/제품|품목|모델/, 'product'],
  [/라인/, 'line'],
  [/공정/, 'process'],
  [/설비|장비/, 'equipment'],
  [/lot/i, 'lot'],
  [/날짜|일자|기간/, 'date'],
  [/코드/, 'code'],
  [/이름|성명/, 'name'],
  [/검색|키워드|조회어/, 'keyword'],
];

/** 이 도구는 스킬 단계로 옮기지 않는다. 읽고 기다리고 답하는 일은 마지막 목표 단계가 다시 한다. */
const SKIP = new Set(['next_step', 'read_text', 'wait_for', 'close_tab', 'ask_user', 'finish', 'abort']);

export function stepsFromRun(run: { request: string; tabUrl: string; entries: HistoryEntry[] }): RunAsSkill {
  const notes: string[] = [];
  const steps: AuthorStep[] = [];
  /** 데이터셋 이름 → 그것을 읽은 표 단계 */
  const tables = new Map<string, Extract<AuthorStep, { kind: 'extract' }>>();
  const used = new Set<string>();
  const request = run.request.trim();
  let start: DraftStart = { url: run.tabUrl };

  const suggest = (label: string, fallback: string) => {
    const base = NAME_HINTS.find(([re]) => re.test(label))?.[1] ?? fallback;
    let name = base;
    for (let i = 2; used.has(name); i++) name = `${base}${i}`;
    used.add(name);
    return name;
  };
  /** 요청 문장에 그대로 나온 값만 매개변수로 제안한다. */
  const inRequest = (value: string) => value.trim() !== '' && request.includes(value.trim());

  const done = run.entries.filter((e) => e.ok);
  done.forEach((e, i) => {
    if (SKIP.has(e.tool)) return;
    const args = e.args;
    const target = e.targets?.ref;
    const missing = () => notes.push(`${e.tool} 동작 하나는 가리킨 요소의 이름을 알 수 없어 넣지 않았습니다. 필요하면 녹화로 더하세요.`);

    if (e.tool === 'navigate') {
      // 맨 처음 이동은 시작 화면이다. 그 뒤의 이동은 말로 적은 단계로 둔다.
      if (i === 0 && steps.length === 0) start = { url: String(args.url) };
      else steps.push({ kind: 'goal', text: `"${String(args.url)}" 화면으로 이동한다` });
      return;
    }
    if (e.tool === 'click' || e.tool === 'download_table') {
      if (!target) return missing();
      const click: AuthorStep = { kind: 'click', role: e.tool === 'download_table' ? 'button' : target.role, name: target.name, dup: target.dup, ...(target.row ? { row: target.row } : {}) };
      if (args.accept_dialog === true) click.dialogs = [{ kind: 'confirm', message: '', accepted: true }];
      steps.push(click);
      return;
    }
    if (e.tool === 'type' || e.tool === 'select') {
      if (!target) return missing();
      const value = String(e.tool === 'type' ? args.text : args.value);
      const variable = inRequest(value);
      // 같은 칸을 고쳐 입력한 것은 마지막 값만 남긴다. 앞의 값에 제안한 이름은 다시 쓸 수 있게 돌려 둔다.
      const prev = steps.at(-1);
      const replacing = prev !== undefined && prev.kind === e.tool && 'name' in prev && prev.name === target.name;
      if (replacing && (prev.kind === 'type' || prev.kind === 'select') && prev.param?.name) used.delete(prev.param.name);
      const param = variable ? { param: { name: suggest(target.name, e.tool === 'type' ? 'keyword' : 'option') } } : {};
      const step: AuthorStep =
        e.tool === 'type'
          ? { kind: 'type', name: target.name, value, dup: target.dup, multiline: value.includes('\n'), numeric: /^-?[\d,.]+$/.test(value), variable, ...param }
          : { kind: 'select', name: target.name, value, options: target.options ?? [value], dup: target.dup, variable, ...param };
      if (replacing) steps[steps.length - 1] = step;
      else steps.push(step);
      return;
    }
    if (e.tool === 'extract_table') {
      if (!target) return missing();
      const next = e.targets?.next_ref?.name;
      const step = { kind: 'extract' as const, name: target.name, ...(next ? { next } : {}) };
      tables.set(String(args.dataset), step);
      steps.push(step);
      return;
    }
    if (e.tool === 'summarize') {
      const instruction = String(args.instruction ?? '').trim() || '주요 내용을 정리한다';
      const source = String(args.source ?? 'page');
      if (source === 'page') {
        steps.push({ kind: 'summarize', instruction, source: 'page' });
        return;
      }
      const table = tables.get(source);
      if (!table) {
        steps.push({ kind: 'goal', text: `데이터셋 ${source}을(를) ${instruction}` });
        return;
      }
      // 표 정리 단계는 그 표를 스스로 읽는다. 앞의 표 읽기 단계는 빼서 두 번 읽지 않게 한다.
      const at = steps.indexOf(table);
      if (at >= 0) steps.splice(at, 1);
      steps.push({ kind: 'summarize', instruction, source: { table: table.name, ...(table.next ? { next: table.next } : {}) } });
      return;
    }
    notes.push(`${e.tool} 동작은 스킬 단계로 옮기지 않았습니다. 필요하면 초안에서 단계를 더하세요.`);
  });

  // 요청에 나온 값을 자리표시자로 바꿔 마지막 목표 단계로 둔다. 긴 값부터 바꿔 짧은 값이 그 안을 건드리지 않게 한다.
  const params = steps
    .flatMap((s) => ((s.kind === 'type' || s.kind === 'select') && s.variable && s.param?.name ? [{ value: s.value.trim(), name: s.param.name }] : []))
    .sort((a, b) => b.value.length - a.value.length);
  let goal = request;
  for (const p of params) goal = goal.split(p.value).join(`{${p.name}}`);
  if (request) steps.push({ kind: 'goal', text: `화면의 결과를 확인해 다음 요청에 답한다: ${goal}` });

  if (steps.length <= 1) notes.push('옮길 수 있는 조작이 없었습니다. 요청만 목표 단계로 넣었습니다.');
  if (params.length) notes.push(`요청에 나온 값 ${params.map((p) => `"${p.value}"`).join(', ')}을(를) 실행할 때마다 받는 매개변수로 제안했습니다. 이름과 설명을 확인하세요.`);

  return {
    start,
    steps,
    meta: { id: '', name: request.slice(0, 30), description: request, owner: '' },
    notes,
  };
}

/**
 * 매개변수 이름이 바뀌거나 빠질 때 말로 적은 단계와 정리 기준의 자리표시자를 따라 고친다.
 * to가 없으면(실행할 때마다 받지 않기로 하면) 자리표시자를 원래 값으로 되돌린다.
 */
export function renameParam(steps: AuthorStep[], from: string, to: string | { value: string }): AuthorStep[] {
  if (!from) return steps;
  const with_ = typeof to === 'string' ? (PARAM_NAME.test(to) ? `{${to}}` : null) : to.value;
  if (with_ === null) return steps;
  const swap = (text: string) => text.split(`{${from}}`).join(with_);
  return steps.map((s) => (s.kind === 'goal' ? { ...s, text: swap(s.text) } : s.kind === 'summarize' ? { ...s, instruction: swap(s.instruction) } : s));
}
