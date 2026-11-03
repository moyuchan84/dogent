import { parse as parseYaml } from 'yaml';
import { PARAM_NAME } from './author';
import { stepCheck } from './check';
import { SUBMIT_PATTERN } from './policy';

/**
 * 스킬 흐름 편집기의 코어. SKILL.md가 정본이고, 카드 편집기는 그 문서의 "## 단계" 절을 보여 주고 고치는 뷰다.
 * 그래서 이 모듈은 문서를 Flow(선언부 + 단계 블록 + 앞뒤 본문)로 열고, 고친 뒤 같은 모양의 문서로 되돌린다.
 *
 * - 순수 모듈이다. 브라우저·chrome API에 의존하지 않는다. 모든 연산은 불변이다 (새 Flow를 돌려준다).
 * - 문서의 형식(docs/05-skill-spec.md)은 바꾸지 않는다. 알 수 없는 줄은 버리지 않고 그대로 보존한다.
 * - 통제: 시작 화면 단계는 옮기거나 지울 수 없고, 저장·상신 단계는 지우면 선언을 함께 정리한다.
 */

// ---------------------------------------------------------------------------
// 모양

/** 단계 하나. 문서의 "N. 머리" 줄과 그 아래에 딸린 줄들 */
export interface FlowBlock {
  /** 순서와 무관한 고유 id. 번호는 문서에 쓸 때 다시 매긴다 */
  key: string;
  /** 번호를 뺀 첫 줄 문장 */
  head: string;
  /** 백틱으로 감싼 JSON 인자 줄의 안쪽 (없으면 null). 있으면 모델 없이 실행되는 단계다 */
  literal: string | null;
  /** "- 목적:" 줄 */
  note: string | null;
  /** "- 검사:" 줄의 식 */
  check: string | null;
  /** "- 기록:" 줄의 식 */
  record: string | null;
  /** 그 밖의 알 수 없는 줄 (예: "- 확인:"). 원문 그대로 */
  extra: string[];
  /** 저장·상신 단계 (submit_steps에 있는 단계) */
  submit: boolean;
  /** 딸린 줄의 원래 순서. 숫자는 extra의 위치 */
  layout: (LayoutPart | number)[];
}
type LayoutPart = 'literal' | 'note' | 'check' | 'record';

/** 입력 선언 (선언부 inputs의 항목) */
export interface FlowInput {
  name: string;
  label?: string;
  description?: string;
  type?: string;
  required?: boolean;
  default?: string | number;
  values?: string[];
  dataset?: string;
}

export interface FlowMeta {
  id: string;
  name: string;
  description: string;
  version: string;
  owner: string;
  risk: string;
  domains: string[];
  tags: string[];
  inputs: FlowInput[];
  submit_steps: number[];
  submit_labels: string[];
  scripts: unknown[];
  limits: { max_steps?: number; timeout_sec?: number };
}

export interface FlowWarning {
  /** 문제가 있는 단계의 key. 스킬 전체에 대한 것이면 없다 */
  key?: string;
  message: string;
}

export interface Flow {
  ok: true;
  /** 선언부 YAML 텍스트 (--- 사이) */
  front: string;
  /** front를 읽은 값 */
  meta: FlowMeta;
  /** 선언부 끝(---) 뒤부터 "## 단계" 줄까지 */
  lead: string[];
  /** "## 단계" 줄과 첫 단계 사이에 있던 글 (빈 줄 포함) */
  pre: string[];
  blocks: FlowBlock[];
  /** 단계 사이 빈 줄 수 (문서가 단계를 띄워 썼을 때) */
  gap: number;
  /** 단계 절 끝의 빈 줄 */
  tail: string[];
  /** 다음 절("## 예외" 등)부터 끝까지. 원문 그대로 */
  after: string[];
  /** 지금 상태에서 사람이 알아야 할 것 (저장·상신 선언 빠짐 등). 연산마다 다시 계산한다 */
  warnings: FlowWarning[];
  /** 마지막 연산이 알리는 것 (지우지 못했다, 이름이 바뀌었다 등) */
  notices: string[];
}

export type FlowParse = Flow | { ok: false; reason: string };

// ---------------------------------------------------------------------------
// 열기

let keySeq = 0;
const newKey = () => `b${++keySeq}`;

const NOTE_LINE = /^\s*-\s*목적:\s*(.*)$/;
const CHECK_LINE = /^\s*-\s*검사:\s*(.+)$/;
const RECORD_LINE = /^\s*-\s*기록:\s*(.+)$/;
const LITERAL_LINE = /^\s*`(.*)`\s*$/;
const STEP_LINE = /^\d+\.\s+(.+)$/;

/** 문서를 Flow로 연다. 열 수 없으면 오류를 던지지 않고 이유를 돌려준다 (화면이 원문 편집으로 안내한다). */
export function parseFlow(source: string): FlowParse {
  const lines = source.replace(/^﻿/, '').replace(/\r\n/g, '\n').split('\n');
  if (lines[0]?.trim() !== '---') return { ok: false, reason: '맨 위에 --- 로 감싼 선언부(YAML)가 없습니다' };
  const end = lines.findIndex((l, i) => i > 0 && l.trim() === '---');
  if (end < 0) return { ok: false, reason: '선언부(YAML)를 닫는 --- 줄이 없습니다' };
  const front = lines.slice(1, end).join('\n');
  let meta: FlowMeta;
  try {
    meta = readMeta(front);
  } catch (e) {
    return { ok: false, reason: `선언부를 읽지 못했습니다: ${(e as Error).message}` };
  }
  const rest = lines.slice(end + 1);
  const at = rest.findIndex((l) => /^##\s*단계\s*$/.test(l));
  if (at < 0) return { ok: false, reason: '"## 단계" 절이 없습니다' };
  let stop = rest.findIndex((l, i) => i > at && /^##\s/.test(l));
  if (stop < 0) stop = rest.length;
  const section = rest.slice(at + 1, stop);
  const first = section.findIndex((l) => STEP_LINE.test(l));
  if (first < 0) return { ok: false, reason: '"## 단계" 절에 번호 목록(1. 2. …)이 없습니다' };

  const pre = section.slice(0, first);
  const body = section.slice(first);
  // 끝의 빈 줄은 단계가 아니라 절 사이의 간격이다 (문서 끝 줄바꿈 포함)
  let tailAt = body.length;
  while (tailAt > 0 && body[tailAt - 1].trim() === '') tailAt--;
  const tail = body.slice(tailAt);
  const blocks: FlowBlock[] = [];
  let gap = 0;
  let blanks = 0;
  for (const line of body.slice(0, tailAt)) {
    const head = STEP_LINE.exec(line);
    if (head) {
      if (blocks.length > 0) gap = Math.max(gap, blanks);
      blanks = 0;
      blocks.push({ key: newKey(), head: head[1].trim(), literal: null, note: null, check: null, record: null, extra: [], submit: false, layout: [] });
      continue;
    }
    if (line.trim() === '') {
      blanks++;
      continue;
    }
    blanks = 0;
    const b = blocks[blocks.length - 1];
    const lit = LITERAL_LINE.exec(line);
    const note = NOTE_LINE.exec(line);
    const check = CHECK_LINE.exec(line);
    const record = RECORD_LINE.exec(line);
    if (lit && b.literal === null) {
      b.literal = lit[1];
      b.layout.push('literal');
    } else if (note && b.note === null) {
      b.note = note[1].trim();
      b.layout.push('note');
    } else if (check && b.check === null) {
      b.check = check[1].trim();
      b.layout.push('check');
    } else if (record && b.record === null) {
      b.record = record[1].trim();
      b.layout.push('record');
    } else {
      b.layout.push(b.extra.length);
      b.extra.push(line);
    }
  }
  blocks.forEach((b, i) => {
    b.submit = meta.submit_steps.includes(i + 1);
  });
  // 열 때는 문서를 고치지 않는다 (선언부 맞춤은 고치거나 쓸 때 한다)
  const flow: Flow = { ok: true, front, meta, lead: rest.slice(0, at + 1), pre, blocks, gap, tail, after: rest.slice(stop), warnings: [], notices: [] };
  return { ...flow, warnings: computeWarnings(flow) };
}

// ---------------------------------------------------------------------------
// 선언부(YAML) 줄 단위 편집. 고치지 않은 곳은 글자 하나 바뀌지 않게 한다.

const q = (s: string) => JSON.stringify(s);
const yamlValue = (v: string | number) => (typeof v === 'number' ? String(v) : q(v));

function readMeta(front: string): FlowMeta {
  const raw = (parseYaml(front) ?? {}) as Record<string, unknown>;
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new Error('선언부가 항목 목록이 아닙니다');
  const str = (v: unknown) => (typeof v === 'string' ? v : v === undefined || v === null ? '' : String(v));
  const list = (v: unknown) => (Array.isArray(v) ? v.map(String) : []);
  const inputs = (Array.isArray(raw.inputs) ? raw.inputs : []).flatMap((i): FlowInput[] =>
    i && typeof i === 'object' && typeof (i as { name?: unknown }).name === 'string' ? [i as FlowInput] : [],
  );
  const limits = raw.limits && typeof raw.limits === 'object' ? (raw.limits as FlowMeta['limits']) : {};
  return {
    id: str(raw.id),
    name: str(raw.name),
    description: str(raw.description),
    version: str(raw.version),
    owner: str(raw.owner),
    risk: str(raw.risk),
    domains: list(raw.domains),
    tags: list(raw.tags),
    inputs,
    submit_steps: (Array.isArray(raw.submit_steps) ? raw.submit_steps : []).map(Number).filter((n) => Number.isInteger(n) && n > 0),
    submit_labels: list(raw.submit_labels),
    scripts: Array.isArray(raw.scripts) ? raw.scripts : [],
    limits,
  };
}

/** 최상위 키 하나가 차지하는 줄 범위 [시작, 끝) */
function keyRange(lines: string[], key: string): [number, number] | null {
  const start = lines.findIndex((l) => new RegExp(`^${key}:(\\s|$)`).test(l));
  if (start < 0) return null;
  let end = start + 1;
  while (end < lines.length && (/^\s+\S/.test(lines[end]) || /^-\s/.test(lines[end]))) end++;
  return [start, end];
}

/** key의 줄들을 바꾼다. newLines가 null이면 지운다. 없던 키는 limits 앞(없으면 끝)에 넣는다. */
function setKey(front: string, key: string, newLines: string[] | null): string {
  const lines = front.split('\n');
  const r = keyRange(lines, key);
  if (r) lines.splice(r[0], r[1] - r[0], ...(newLines ?? []));
  else if (newLines) {
    const at = keyRange(lines, 'limits') ?? keyRange(lines, 'schedulable');
    lines.splice(at ? at[0] : lines.length, 0, ...newLines);
  }
  return lines.join('\n');
}

function inputLines(inputs: FlowInput[]): string[] | null {
  if (inputs.length === 0) return null;
  const out = ['inputs:'];
  for (const i of inputs) {
    out.push(`  - name: ${i.name}`);
    if (i.label !== undefined) out.push(`    label: ${q(i.label)}`);
    if (i.description) out.push(`    description: ${q(i.description)}`);
    if (i.type) out.push(`    type: ${i.type}`);
    if (i.values?.length) out.push(`    values: [${i.values.map(q).join(', ')}]`);
    if (i.default !== undefined && i.default !== '') out.push(`    default: ${yamlValue(i.default)}`);
    if (i.required !== undefined) out.push(`    required: ${i.required}`);
    if (i.dataset) out.push(`    dataset: ${i.dataset}`);
  }
  return out;
}

const TOOL_HEAD =
  /^(navigate|open_tab|click|close_tab|press_key|scroll|go_back|type|select|extract_table|download_table|fill_table|transform|write_excel|write_html|excel_docs|excel_read|excel_write|excel_save|word_read|word_write|word_save|ppt_read|ppt_write|ppt_save|call_tool|run_skill|run_script|read_text|summarize|finish)(?:으로|로)\s/;

/** 단계 머리에서 도구 이름 (모델이 고르는 말로 적은 단계면 null) */
export function toolOf(block: FlowBlock): string | null {
  return TOOL_HEAD.exec(block.head)?.[1] ?? null;
}

/** 시작 화면으로 이동하는 단계인가 */
export function isStartBlock(block: FlowBlock | undefined): boolean {
  return !!block && toolOf(block) === 'navigate' && block.literal !== null;
}

/** 선언부를 단계에 맞춘다: submit_steps를 새 번호로, max_steps를 단계 수에 맞게 */
function syncFront(front: string, blocks: FlowBlock[], submitNow: number[]): string {
  let out = front;
  const want = blocks.flatMap((b, i) => (b.submit ? [i + 1] : []));
  if (want.join(',') !== submitNow.join(',')) {
    out = setKey(out, 'submit_steps', want.length ? [`submit_steps: [${want.join(', ')}]`] : null);
    if (want.length === 0) out = setKey(out, 'submit_labels', null);
  }
  const lines = out.split('\n');
  const lim = keyRange(lines, 'limits');
  if (lim) {
    for (let i = lim[0]; i < lim[1]; i++) {
      const m = /^(\s+max_steps:\s*)(\d+)(.*)$/.exec(lines[i]);
      if (m && Number(m[2]) < blocks.length * 3) lines[i] = `${m[1]}${Math.max(Number(m[2]), blocks.length * 3)}${m[3]}`;
    }
    out = lines.join('\n');
  }
  return out;
}

/** 연산 뒤에 파생값(선언부 맞춤, 읽은 값, 경고)을 다시 맞춘다 */
function sync(f: Flow): Flow {
  const front = syncFront(f.front, f.blocks, f.meta.submit_steps);
  const meta = front === f.front ? f.meta : readMeta(front);
  const next: Flow = { ...f, front, meta };
  return { ...next, warnings: computeWarnings(next) };
}

function computeWarnings(f: Flow): FlowWarning[] {
  const out: FlowWarning[] = [];
  f.blocks.forEach((b, i) => {
    const kind = describeBlock(b).kind;
    if (b.submit) return;
    // 저장·상신 버튼을 누르는 단계는 submit_steps에 있어야 누를 수 있다 (실행 때 그 버튼은 막힌다)
    const clickTarget = kind === 'click' ? literalString(b, 'ref') : kind === 'goal' ? b.head : null;
    if (clickTarget && SUBMIT_PATTERN.test(clickTarget)) {
      out.push({
        key: b.key,
        message: `${i + 1}번 단계가 저장·상신 계열 버튼을 누르는 것으로 보이는데 "승인 필요" 표시가 없어, 실행할 때 그 버튼은 막힙니다. 실제로 누르는 단계라면 표시하고 위험 등급을 R3로 바꾸세요.`,
      });
    }
  });
  if (f.blocks.some((b) => b.submit) && f.meta.risk !== 'R3') {
    out.push({ message: `저장·상신 단계가 있는데 위험 등급이 ${f.meta.risk || '(없음)'}입니다. R3로 바꾸세요.` });
  }
  return out;
}

function literalString(b: FlowBlock, key: string): string | null {
  const v = literalObject(b)?.[key];
  return typeof v === 'string' ? v : null;
}

export function literalObject(b: FlowBlock): Record<string, unknown> | null {
  if (b.literal === null) return null;
  try {
    const v = JSON.parse(b.literal) as unknown;
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// 쓰기

function blockLines(b: FlowBlock): string[] {
  const out = [`N. ${b.head}`];
  const shown = new Set<LayoutPart>();
  const emit = (p: LayoutPart | number) => {
    if (typeof p === 'number') {
      if (b.extra[p] !== undefined) out.push(b.extra[p]);
      return;
    }
    if (shown.has(p)) return;
    shown.add(p);
    if (p === 'literal' && b.literal !== null) out.push(`   \`${b.literal}\``);
    if (p === 'note' && b.note) out.push(`   - 목적: ${b.note}`);
    if (p === 'check' && b.check) out.push(`   - 검사: ${b.check}`);
    if (p === 'record' && b.record) out.push(`   - 기록: ${b.record}`);
  };
  for (const p of b.layout) emit(p);
  // 배치에 없는 값(새로 쓴 목적·검사)은 정해진 자리에 붙인다
  for (const p of ['literal', 'note', 'check', 'record'] as const) emit(p);
  return out;
}

/** Flow를 문서로 쓴다. 단계를 1부터 다시 매기고 선언부를 맞춘다. */
export function renderFlow(flow: Flow): string {
  const f = sync(flow);
  const body: string[] = [];
  f.blocks.forEach((b, i) => {
    if (i > 0) for (let k = 0; k < f.gap; k++) body.push('');
    body.push(...blockLines(b).map((l, j) => (j === 0 ? l.replace(/^N\./, `${i + 1}.`) : l)));
  });
  return ['---', f.front, '---', ...f.lead, ...f.pre, ...body, ...f.tail, ...f.after].join('\n');
}

// ---------------------------------------------------------------------------
// 연산

const done = (f: Flow, notices: string[] = []): Flow => ({ ...sync(f), notices });
const keep = (f: Flow, notice: string): Flow => ({ ...f, notices: [notice] });

/** 시작 화면 단계가 맨 앞에 있어 잠겨 있는가 */
export function startLocked(flow: Flow): boolean {
  return isStartBlock(flow.blocks[0]);
}
const LOCK_MSG = '1번(시작 화면) 단계는 옮기거나 지울 수 없고, 그 앞에는 단계를 넣을 수 없습니다.';

/** 새 단계 블록. 인자 줄 없는 목표 단계가 기본이다. */
export function makeBlock(p: { head: string; note?: string | null; check?: string | null; literal?: string | null; record?: string | null }): FlowBlock {
  const layout: LayoutPart[] = [];
  if (p.literal) layout.push('literal');
  if (p.note) layout.push('note');
  if (p.check) layout.push('check');
  if (p.record) layout.push('record');
  return {
    key: newKey(),
    head: oneLine(p.head),
    literal: p.literal ?? null,
    note: p.note ? oneLine(p.note) : null,
    check: p.check ? oneLine(p.check) : null,
    record: p.record ? oneLine(p.record) : null,
    extra: [],
    submit: false,
    layout,
  };
}

/** 한 줄로 만든다. 줄바꿈과 백틱은 문서 구조를 깨므로 없앤다. */
function oneLine(s: string): string {
  return s
    .replace(/`/g, '"')
    .replace(/\s*\n\s*/g, ' ')
    .replace(/^\d+\.\s+/, '')
    .trim();
}

export function moveBlock(flow: Flow, from: number, to: number): Flow {
  const n = flow.blocks.length;
  if (from < 0 || from >= n || to < 0 || to >= n) return keep(flow, '옮길 수 없는 위치입니다.');
  if (from === to) return { ...flow, notices: [] };
  if (startLocked(flow) && (from === 0 || to === 0)) return keep(flow, LOCK_MSG);
  const blocks = [...flow.blocks];
  const [b] = blocks.splice(from, 1);
  blocks.splice(to, 0, b);
  return done({ ...flow, blocks });
}

/** at 위치에 새 단계를 끼운다 (0부터). 시작 화면이 잠겨 있으면 그 앞에는 넣지 않고 1번 뒤에 넣는다. */
export function insertBlock(flow: Flow, at: number, block: Parameters<typeof makeBlock>[0] | FlowBlock): Flow {
  const b = 'key' in block ? { ...block } : makeBlock(block);
  const min = startLocked(flow) ? 1 : 0;
  const pos = Math.min(Math.max(at, min), flow.blocks.length);
  const blocks = [...flow.blocks];
  blocks.splice(pos, 0, b);
  return done({ ...flow, blocks }, at < min ? ['1번(시작 화면) 앞에는 넣을 수 없어 1번 뒤에 넣었습니다.'] : []);
}

export function removeBlock(flow: Flow, i: number): Flow {
  const b = flow.blocks[i];
  if (!b) return keep(flow, '없는 단계입니다.');
  if (i === 0 && startLocked(flow)) return keep(flow, LOCK_MSG);
  if (flow.blocks.length === 1) return keep(flow, '단계가 하나뿐이라 지울 수 없습니다.');
  const blocks = flow.blocks.filter((_, j) => j !== i);
  const notices: string[] = [];
  if (b.submit) {
    notices.push(
      `저장·상신 단계를 지웠습니다. 승인 필요 표시와 버튼 이름 목록을 함께 정리했습니다.${blocks.some((x) => x.submit) ? '' : ' 위험 등급은 그대로이니 필요하면 직접 바꾸세요.'}`,
    );
  }
  return done({ ...flow, blocks }, notices);
}

export function duplicateBlock(flow: Flow, i: number): Flow {
  const b = flow.blocks[i];
  if (!b) return keep(flow, '없는 단계입니다.');
  if (i === 0 && startLocked(flow)) return keep(flow, '1번(시작 화면) 단계는 복제할 수 없습니다.');
  const copy: FlowBlock = { ...b, key: newKey(), extra: [...b.extra], layout: [...b.layout], submit: false };
  const blocks = [...flow.blocks];
  blocks.splice(i + 1, 0, copy);
  return done({ ...flow, blocks }, b.submit ? ['복제한 단계는 "승인 필요" 표시를 물려받지 않습니다. 같은 저장·상신 버튼을 또 누르는 것이면 직접 표시하세요.'] : []);
}

export interface BlockPatch {
  head?: string;
  note?: string | null;
  check?: string | null;
  record?: string | null;
}

export function updateBlock(flow: Flow, i: number, patch: BlockPatch): Flow {
  const b = flow.blocks[i];
  if (!b) return keep(flow, '없는 단계입니다.');
  const next: FlowBlock = { ...b, layout: [...b.layout] };
  if (patch.head !== undefined) {
    const head = oneLine(patch.head);
    if (!head) return keep(flow, '단계 문장은 비울 수 없습니다.');
    next.head = head;
  }
  const field = (name: 'note' | 'check' | 'record', value: string | null | undefined) => {
    if (value === undefined) return;
    const v = value === null ? '' : oneLine(value);
    next[name] = v || null;
    if (v && !next.layout.includes(name)) {
      // 목적은 인자 줄 바로 뒤, 검사는 목적·확인 줄 뒤, 기록은 맨 끝에 둔다
      if (name === 'note') next.layout.splice(next.layout.includes('literal') ? next.layout.indexOf('literal') + 1 : 0, 0, name);
      else if (name === 'check') next.layout.splice(next.layout.includes('record') ? next.layout.indexOf('record') : next.layout.length, 0, name);
      else next.layout.push(name);
    }
  };
  field('note', patch.note);
  field('check', patch.check);
  field('record', patch.record);
  const blocks = flow.blocks.map((x, j) => (j === i ? next : x));
  return done({ ...flow, blocks });
}

// --- 선언부 ---

export interface MetaPatch {
  id?: string;
  name?: string;
  description?: string;
  owner?: string;
  risk?: string;
  version?: string;
  tags?: string[];
}

/** 스킬 정보를 고친다. 사이트(domains)와 시작 주소는 여기서 바꾸지 않는다. */
export function setMeta(flow: Flow, patch: MetaPatch): Flow {
  let front = flow.front;
  let blocks = flow.blocks;
  const line = (key: string, v: string) => (front = setKey(front, key, [`${key}: ${q(v)}`]));
  // 값이 YAML을 깨지 않게 단순한 글자가 아니면 따옴표로 감싼다
  const plain = (v: string) => (/^[\w.-]+$/.test(v) ? v : q(v));
  if (patch.name !== undefined && flow.meta.name && patch.name.trim() !== flow.meta.name) {
    // 엑셀 파일 이름과 보고 문구에 들어간 옛 이름을 따라 바꾼다
    const from = flow.meta.name;
    const to = patch.name.trim();
    blocks = blocks.map((b) => {
      const a = literalObject(b);
      if (!a || (toolOf(b) !== 'write_excel' && toolOf(b) !== 'finish')) return b;
      const text = JSON.stringify(a);
      const next = text.split(JSON.stringify(from).slice(1, -1)).join(JSON.stringify(to).slice(1, -1));
      return next === text ? b : { ...b, literal: next };
    });
  }
  if (patch.id !== undefined) front = setKey(front, 'id', [`id: ${plain(patch.id)}`]);
  if (patch.name !== undefined) line('name', patch.name.trim());
  if (patch.description !== undefined) line('description', patch.description.trim());
  if (patch.owner !== undefined) line('owner', patch.owner.trim());
  if (patch.version !== undefined) front = setKey(front, 'version', [`version: ${plain(patch.version)}`]);
  if (patch.risk !== undefined) front = setKey(front, 'risk', [`risk: ${patch.risk}`]);
  if (patch.tags !== undefined) {
    const tags = [...new Set(patch.tags.map((t) => t.trim()).filter(Boolean))];
    front = setKey(front, 'tags', tags.length ? [`tags: [${tags.map(q).join(', ')}]`] : null);
  }
  return done({ ...flow, front, blocks, meta: readMeta(front) });
}

const INPUT_TYPES = ['string', 'number', 'text', 'enum', 'ip', 'port', 'file'];

function withInputs(flow: Flow, inputs: FlowInput[], blocks = flow.blocks, notices: string[] = []): Flow {
  const front = setKey(flow.front, 'inputs', inputLines(inputs));
  return done({ ...flow, front, meta: readMeta(front), blocks }, notices);
}

/** 이름의 {이름}을 모든 단계의 글(머리, 인자, 목적, 검사, 기록, 그 밖의 줄)에서 바꾼다. 기존 renameParam과 같은 규칙. */
function renameInBlocks(blocks: FlowBlock[], from: string, to: string): FlowBlock[] {
  const swap = (s: string) => s.split(`{${from}}`).join(`{${to}}`);
  const opt = (s: string | null) => (s === null ? null : swap(s));
  return blocks.map((b) => ({ ...b, head: swap(b.head), literal: opt(b.literal), note: opt(b.note), check: opt(b.check), record: opt(b.record), extra: b.extra.map(swap) }));
}

export function addInput(flow: Flow, input: FlowInput): Flow {
  if (!PARAM_NAME.test(input.name)) return keep(flow, `입력 이름 "${input.name}"은(는) 영문 소문자로 시작하는 영문·숫자·_만 쓸 수 있습니다.`);
  if (flow.meta.inputs.some((i) => i.name === input.name)) return keep(flow, `입력 "${input.name}"이(가) 이미 있습니다.`);
  return withInputs(flow, [...flow.meta.inputs, normalizeInput(input)]);
}

function normalizeInput(i: FlowInput): FlowInput {
  const type = i.type && INPUT_TYPES.includes(i.type) ? i.type : 'string';
  const hasDefault = i.default !== undefined && i.default !== '';
  return { ...i, type, required: i.required ?? !hasDefault };
}

/** 입력을 고친다. name을 바꾸면 모든 단계의 {이름}도 함께 바뀐다. */
export function setInput(flow: Flow, name: string, patch: Partial<FlowInput>): Flow {
  const cur = flow.meta.inputs.find((i) => i.name === name);
  if (!cur) return keep(flow, `입력 "${name}"이(가) 없습니다.`);
  let blocks = flow.blocks;
  const next: FlowInput = { ...cur, ...patch };
  if (patch.name !== undefined && patch.name !== name) {
    if (!PARAM_NAME.test(patch.name)) return keep(flow, `입력 이름 "${patch.name}"은(는) 영문 소문자로 시작하는 영문·숫자·_만 쓸 수 있습니다.`);
    if (flow.meta.inputs.some((i) => i.name === patch.name)) return keep(flow, `입력 "${patch.name}"이(가) 이미 있습니다.`);
    blocks = renameInBlocks(blocks, name, patch.name);
  }
  if (next.default === '' || next.default === undefined) delete next.default;
  if (next.type && !INPUT_TYPES.includes(next.type)) next.type = 'string';
  return withInputs(
    flow,
    flow.meta.inputs.map((i) => (i.name === name ? next : i)),
    blocks,
    next.name !== name ? [`입력 이름을 {${name}}에서 {${next.name}}(으)로 바꾸고 단계의 글도 함께 고쳤습니다.`] : [],
  );
}

export function removeInput(flow: Flow, name: string): Flow {
  if (!flow.meta.inputs.some((i) => i.name === name)) return keep(flow, `입력 "${name}"이(가) 없습니다.`);
  const used = flow.blocks.filter((b) => mentions(b, name)).length;
  return withInputs(
    flow,
    flow.meta.inputs.filter((i) => i.name !== name),
    flow.blocks,
    used ? [`{${name}}을(를) 쓰는 단계가 ${used}개 남아 있습니다. 고치거나 입력을 다시 추가하세요.`] : [],
  );
}

function mentions(b: FlowBlock, name: string): boolean {
  const t = `{${name}}`;
  return [b.head, b.literal ?? '', b.note ?? '', b.check ?? '', b.record ?? '', ...b.extra].some((s) => s.includes(t));
}

/** 단계 글에서 쓰였지만 선언되지 않은 입력 이름 (이름 → 쓰는 단계 key). {out.x}, {rows.x}는 입력이 아니다. */
export function undeclaredInputs(flow: Flow): { name: string; keys: string[] }[] {
  const declared = new Set(flow.meta.inputs.map((i) => i.name));
  const found = new Map<string, string[]>();
  for (const b of flow.blocks) {
    const text = [b.head, b.literal ?? '', b.note ?? '', b.check ?? '', b.record ?? '', ...b.extra].join('\n');
    for (const m of text.matchAll(/\{([a-z][a-z0-9_]*)\}/g)) {
      if (declared.has(m[1])) continue;
      const keys = found.get(m[1]) ?? [];
      if (!keys.includes(b.key)) keys.push(b.key);
      found.set(m[1], keys);
    }
  }
  return [...found].map(([name, keys]) => ({ name, keys }));
}

// --- 끼워 넣기 ---

/** 단계가 쓰는 데이터셋 이름 (인자의 dataset, 검사의 dataset("…")) */
function datasetsOf(flow: Flow): Set<string> {
  const out = new Set<string>();
  for (const b of flow.blocks) {
    const d = literalString(b, 'dataset');
    if (d) out.add(d);
    for (const m of (b.check ?? '').matchAll(/dataset\("([^"]+)"\)/g)) out.add(m[1]);
  }
  for (const i of flow.meta.inputs) if (i.dataset) out.add(i.dataset);
  return out;
}

/**
 * fragment(다른 Flow)의 단계를 target의 at 위치에 끼운다. 시작 이동 단계와 보고(finish) 단계는 가져오지 않는다.
 * 입력은 함께 가져오고, 이름이 겹치면 이름을 바꿔 해결한다. 저장·상신 표시도 따라온다.
 */
export function spliceFlow(target: Flow, fragment: Flow, at: number): Flow {
  const notices: string[] = [];
  let blocks = fragment.blocks.filter((b, i) => !(i === 0 && isStartBlock(b)) && toolOf(b) !== 'finish').map((b) => ({ ...b, key: newKey(), extra: [...b.extra], layout: [...b.layout] }));
  if (blocks.length === 0) return keep(target, '끼워 넣을 단계가 없습니다.');

  const inputs = [...target.meta.inputs];
  for (const decl of fragment.meta.inputs) {
    const clash = inputs.some((i) => i.name === decl.name);
    if (!clash) {
      inputs.push(decl);
      continue;
    }
    let name = decl.name;
    for (let k = 2; inputs.some((i) => i.name === name) || fragment.meta.inputs.some((i) => i.name === name); k++) name = `${decl.name}${k}`;
    blocks = renameInBlocks(blocks, decl.name, name);
    inputs.push({ ...decl, name });
    notices.push(`입력 이름 {${decl.name}}이(가) 겹쳐 새로 넣은 쪽을 {${name}}(으)로 바꿨습니다.`);
  }
  // 데이터셋 이름이 겹치면 새로 넣은 쪽을 바꾼다
  const taken = datasetsOf(target);
  for (const ds of datasetsOf(fragment)) {
    if (!taken.has(ds)) continue;
    let name = `${ds}_2`;
    for (let k = 3; taken.has(name); k++) name = `${ds}_${k}`;
    const re = new RegExp(`(?<![\\w])${ds}(?![\\w])`, 'g');
    const swap = (s: string) => s.replace(re, name);
    const opt = (s: string | null) => (s === null ? null : swap(s));
    blocks = blocks.map((b) => ({ ...b, head: swap(b.head), literal: opt(b.literal), note: opt(b.note), check: opt(b.check), record: opt(b.record), extra: b.extra.map(swap) }));
    for (const i of inputs) if (i.dataset === ds && !target.meta.inputs.includes(i)) i.dataset = name;
    notices.push(`데이터셋 이름 ${ds}이(가) 겹쳐 새로 넣은 쪽을 ${name}(으)로 바꿨습니다.`);
  }

  const min = startLocked(target) ? 1 : 0;
  const pos = Math.min(Math.max(at, min), target.blocks.length);
  const all = [...target.blocks];
  all.splice(pos, 0, ...blocks);

  let front = setKey(target.front, 'inputs', inputLines(inputs));
  const submits = blocks.filter((b) => b.submit);
  if (submits.length) {
    const labels = [...new Set([...target.meta.submit_labels, ...fragment.meta.submit_labels])];
    if (labels.length) front = setKey(front, 'submit_labels', [`submit_labels: [${labels.map(q).join(', ')}]`]);
    notices.push(
      `저장·상신 단계 ${submits.length}개가 함께 들어왔습니다.${target.meta.risk === 'R3' ? '' : ' 위험 등급을 R3로 바꾸세요.'}`,
    );
  }
  if (blocks.some((b) => toolOf(b) === 'write_excel')) notices.push('끼워 넣은 단계에 엑셀 저장이 있어, 그 조각이 읽은 표만 따로 저장합니다.');
  // 선언을 먼저 맞춰 둔 뒤 sync가 submit_steps를 새 번호로 쓴다
  return done({ ...target, front, meta: readMeta(front), blocks: all }, notices);
}

// ---------------------------------------------------------------------------
// 시험용 소스

/**
 * 1번부터 upTo번(0부터) 단계까지에 보고 단계만 붙인 임시 문서. 저장하지 않고 시험 실행에만 쓴다.
 * 저장·상신 표시는 그대로 두어, 시험 실행(dryRun)이 그 버튼 직전에서 멈추게 한다.
 */
export function trialSource(flow: Flow, upTo: number): string {
  const blocks = flow.blocks.slice(0, upTo + 1);
  const report = makeBlock({
    head: 'finish로 결과를 보고한다. args는 다음을 그대로 쓴다.',
    literal: JSON.stringify({ summary: `시험 실행: ${blocks.length}번 단계까지 마쳤습니다.` }),
  });
  return renderFlow({ ...flow, blocks: [...blocks, report], gap: 0 });
}

// ---------------------------------------------------------------------------
// 카드 표현

export type BlockKind = 'navigate' | 'click' | 'type' | 'select' | 'extract' | 'fill' | 'summarize' | 'download' | 'goal' | 'report' | 'other';

export const KIND_LABEL: Record<BlockKind, string> = {
  navigate: '이동',
  click: '누르기',
  type: '입력',
  select: '선택',
  extract: '표 읽기',
  fill: '엑셀 채우기',
  summarize: '정리',
  download: '내려받기',
  goal: '말로 적은 단계',
  report: '보고',
  other: '기타',
};

export interface BlockView {
  title: string;
  kind: BlockKind;
  label: string;
  /** 아이콘을 고르는 키 (kind와 같다) */
  icon: BlockKind;
  /** 도구 이름 (말로 적은 단계면 null) */
  tool: string | null;
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);

/** 카드 제목과 종류. 문서에서 읽은 블록 기준이다. */
export function describeBlock(block: FlowBlock): BlockView {
  const tool = toolOf(block);
  const a = literalObject(block) ?? {};
  const s = (k: string) => (typeof a[k] === 'string' ? (a[k] as string) : '');
  const view = (kind: BlockKind, title: string): BlockView => ({ title, kind, label: KIND_LABEL[kind], icon: kind, tool });
  // 인자 줄이 없으면 모델이 화면을 보고 하는 말로 적은 단계
  if (block.literal === null) return view('goal', clip(block.head, 70));
  switch (tool) {
    case 'navigate': {
      const name = /"([^"]+)"/.exec(block.head)?.[1];
      return view('navigate', name ? `"${name}" 화면으로 이동` : '시작 화면으로 이동');
    }
    case 'click':
      return view('click', `"${s('ref') || '(이름 없음)'}"${s('row') ? ` (${s('row')} 행)` : ''} 누름`);
    case 'type':
      return view('type', `"${s('ref') || '(이름 없음)'}"에 입력: ${clip(s('text'), 30)}`);
    case 'select':
      return view('select', `"${s('ref') || '(이름 없음)'}"에서 선택: ${clip(s('value'), 30)}`);
    case 'extract_table':
      return view('extract', `"${s('ref')}" 표 읽기${s('next_ref') ? ` ("${s('next_ref')}" 버튼으로 끝 페이지까지)` : ''}`);
    case 'fill_table':
      return view('fill', `"${s('ref')}" 표에 엑셀 채우기`);
    case 'download_table':
      return view('download', `"${s('ref')}" 버튼으로 파일 내려받기`);
    case 'summarize':
      return view('summarize', `정리: ${clip(s('instruction'), 40)}`);
    case 'finish':
      return view('report', '결과 보고');
    case 'write_excel':
      return view('other', '엑셀 파일로 저장');
    case 'run_script':
      return view('other', '스크립트 실행');
    default:
      return view('other', clip(block.head, 70));
  }
}

// ---------------------------------------------------------------------------
// 되돌리기/다시 하기

export interface History<T> {
  past: T[];
  present: T;
  future: T[];
  /** 마지막 변경의 합치기 표식 */
  key?: string;
}

export function newHistory<T>(present: T): History<T> {
  return { past: [], present, future: [] };
}

/**
 * 새 값을 쌓는다. coalesceKey가 바로 앞 변경과 같으면(글자 입력처럼 같은 종류의 연속 편집) 한 번으로 합친다.
 * 값이 그대로면(참조가 같으면) 쌓지 않는다.
 */
export function pushHistory<T>(h: History<T>, next: T, opts: { coalesceKey?: string; max?: number } = {}): History<T> {
  if (Object.is(h.present, next)) return h;
  const max = opts.max ?? 100;
  if (opts.coalesceKey !== undefined && opts.coalesceKey === h.key && h.past.length > 0) {
    return { past: h.past, present: next, future: [], key: opts.coalesceKey };
  }
  return { past: [...h.past, h.present].slice(-max), present: next, future: [], key: opts.coalesceKey };
}

export const canUndo = <T,>(h: History<T>) => h.past.length > 0;
export const canRedo = <T,>(h: History<T>) => h.future.length > 0;

export function undoHistory<T>(h: History<T>): History<T> {
  if (h.past.length === 0) return h;
  return { past: h.past.slice(0, -1), present: h.past[h.past.length - 1], future: [h.present, ...h.future] };
}

export function redoHistory<T>(h: History<T>): History<T> {
  if (h.future.length === 0) return h;
  return { past: [...h.past, h.present], present: h.future[0], future: h.future.slice(1) };
}

/** 검사 식으로 읽을 수 있는지 (카드에서 고친 식을 확인할 때 쓴다). 읽을 수 없으면 이유를 돌려준다. */
export function checkProblem(check: string): string | null {
  if (!check.trim()) return null;
  try {
    stepCheck(`- 검사: ${check.trim()}`);
    return null;
  } catch (e) {
    return (e as Error).message.split('\n')[0];
  }
}

// ---------------------------------------------------------------------------
// 카드에서 쓰는 조작: 입력 단계의 값, 정리·표 읽기 단계 만들기

const VALUE_KEY: Record<string, string> = { type: 'text', select: 'value' };

/** 입력·선택 단계가 넣는 값 (없으면 null) */
export function blockValue(block: FlowBlock): string | null {
  const key = VALUE_KEY[toolOf(block) ?? ''];
  return key ? literalString(block, key) : null;
}

/** 입력·선택 단계의 값이 {입력이름} 하나이면 그 이름 */
export function blockInputName(block: FlowBlock): string | null {
  return /^\{([a-z][a-z0-9_]*)\}$/.exec(blockValue(block) ?? '')?.[1] ?? null;
}

/**
 * 입력·선택 단계가 넣는 값을 바꾼다 (인자 줄의 text/value와 검사 식의 같은 값).
 * 다른 단계의 인자, 특히 시작 주소는 바꾸지 않는다.
 */
export function setBlockValue(flow: Flow, i: number, value: string): Flow {
  const b = flow.blocks[i];
  const key = b ? VALUE_KEY[toolOf(b) ?? ''] : undefined;
  const args = b ? literalObject(b) : null;
  if (!b || !key || !args) return keep(flow, '값을 고칠 수 없는 단계입니다.');
  const old = typeof args[key] === 'string' ? (args[key] as string) : '';
  const literal = JSON.stringify({ ...args, [key]: value });
  const check = b.check && old ? b.check.split(q(old)).join(q(value)) : b.check;
  const next = { ...b, literal, check };
  return done({ ...flow, blocks: flow.blocks.map((x, j) => (j === i ? next : x)) });
}

/** 입력·선택 단계를 "실행할 때마다 입력받기"로 바꾼다: 입력을 새로 선언하고 값을 {이름}으로 둔다. 지금 값은 기본값이 된다. */
export function convertToInput(flow: Flow, i: number, wanted?: string): Flow {
  const b = flow.blocks[i];
  const value = b ? blockValue(b) : null;
  if (!b || value === null) return keep(flow, '입력받을 수 있는 단계가 아닙니다.');
  if (blockInputName(b)) return flow;
  const taken = new Set(flow.meta.inputs.map((x) => x.name));
  let name = wanted && PARAM_NAME.test(wanted) && !taken.has(wanted) ? wanted : '';
  for (let k = 1; !name; k++) if (!taken.has(`v${k}`)) name = `v${k}`;
  const label = literalString(b, 'ref') ?? name;
  const withInput = withInputs(flow, [...flow.meta.inputs, { name, label, type: 'string', ...(value ? { default: value } : {}), required: !value }]);
  return { ...setBlockValue(withInput, i, `{${name}}`), notices: [`{${name}}(으)로 실행할 때마다 입력받습니다. 지금 값 "${value}"은(는) 기본값입니다.`] };
}

/** "실행할 때마다 입력받기"를 끈다: 값을 입력의 기본값으로 되돌리고, 다른 단계가 쓰지 않으면 입력 선언을 지운다. */
export function convertToFixed(flow: Flow, i: number): Flow {
  const b = flow.blocks[i];
  const name = b ? blockInputName(b) : null;
  if (!b || !name) return flow;
  const decl = flow.meta.inputs.find((x) => x.name === name);
  const fixed = setBlockValue(flow, i, decl?.default !== undefined ? String(decl.default) : '');
  const still = fixed.blocks.some((x, j) => j !== i && mentions(x, name));
  return still ? fixed : { ...removeInput(fixed, name), notices: [`{${name}} 입력은 다른 단계가 쓰지 않아 지웠습니다.`] };
}

function freshName(prefix: string, taken: Set<string>): string {
  for (let k = 1; ; k++) if (!taken.has(`${prefix}${k}`)) return `${prefix}${k}`;
}

function usedWords(flow: Flow): Set<string> {
  const words = datasetsOf(flow);
  for (const b of flow.blocks) {
    const a = literalObject(b);
    for (const k of ['name', 'source']) if (typeof a?.[k] === 'string') words.add(a[k] as string);
  }
  return words;
}

/** 화면의 글이나 표를 정리하는 단계들 (표는 먼저 읽는다). 정리한 내용은 reportN 이름으로 남는다. */
export function summarizeBlocks(flow: Flow, instruction: string, source: 'page' | { table: string; next?: string }): FlowBlock[] {
  const taken = usedWords(flow);
  const report = freshName('report', taken);
  const blocks: FlowBlock[] = [];
  let from = 'page';
  if (source !== 'page') {
    from = freshName('sum', taken);
    blocks.push(
      makeBlock({
        head: `extract_table로 "${source.table}" 표를 ${source.next ? `"${source.next}" 버튼으로 마지막 페이지까지 넘기며 ` : ''}데이터셋 \`${from}\`에 읽는다. args는 다음을 그대로 쓴다.`,
        literal: JSON.stringify(source.next ? { ref: source.table, dataset: from, next_ref: source.next } : { ref: source.table, dataset: from }),
        check: `dataset(${q(from)})`,
      }),
    );
  }
  blocks.push(
    makeBlock({
      head: `summarize로 ${source === 'page' ? '화면의 글' : `"${source.table}" 표`}을(를) 정리한다. args는 다음을 그대로 쓴다.`,
      literal: JSON.stringify({ instruction: instruction.trim(), source: from, name: report }),
      check: 'did("summarize")',
    }),
  );
  return blocks;
}

/** 표를 읽는 단계 */
export function extractBlock(flow: Flow, table: string, next?: string): FlowBlock {
  const dataset = freshName('data', usedWords(flow));
  return makeBlock({
    head: `extract_table로 "${table}" 표를 ${next ? `"${next}" 버튼으로 마지막 페이지까지 넘기며 ` : ''}데이터셋 \`${dataset}\`에 추출한다. args는 다음을 그대로 쓴다.`,
    literal: JSON.stringify(next ? { ref: table, dataset, next_ref: next } : { ref: table, dataset }),
    check: `dataset(${q(dataset)})`,
  });
}

/** 여러 단계를 한 번에 at 위치에 끼운다 */
export function insertBlocks(flow: Flow, at: number, blocks: FlowBlock[]): Flow {
  let f = flow;
  const notices: string[] = [];
  blocks.forEach((b, k) => {
    f = insertBlock(f, at + k, b);
    notices.push(...f.notices);
  });
  return { ...f, notices: [...new Set(notices)] };
}
