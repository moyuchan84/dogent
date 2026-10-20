import { parseAction, type Action } from './actions';
import { findElement } from './policy';
import type { Skill } from './skill';
import type { CachedAction, PageSnapshot, PathStore, RunResult, SkillPaths } from './types';

/**
 * 성공한 경로의 기억.
 *
 * 모델이 정한 동작으로 단계가 끝나면 그 동작들을 단계별로 저장해 두고, 같은 스킬을 다시 실행할 때
 * 모델을 부르지 않고 그대로 다시 한다. 저장한 동작이 지금 화면에서 통하지 않으면 그 단계는 모델에게
 * 넘기고, 모델이 새로 찾은 경로로 바꿔 저장한다.
 *
 * - 요소는 번호가 아니라 이름(과 표의 행)으로 저장한다. 번호는 화면이 바뀌면 달라진다.
 * - 입력값과 똑같은 글자는 {이름} 자리표시자로 저장해, 다른 입력값으로 실행해도 그 값이 들어간다.
 * - 입력값에서 나왔는지 알 수 없는 글자가 섞인 경로는 입력값이 같을 때만 다시 쓴다.
 * - 다시 하는 동작도 정책 검사, 사용자 승인, 단계 검사를 똑같이 거친다.
 */

/** 한 단계에 저장하는 동작 수의 한도. 이보다 길면 헤맨 것으로 보고 저장하지 않는다. */
const MAX_PATH_ACTIONS = 8;
/** 저장하지 않는 도구. 끝내는 말과 질문은 그때그때 모델이 정한다. */
const NEVER = new Set(['finish', 'abort', 'ask_user', 'excel_docs', 'excel_read', 'excel_write', 'excel_save', 'call_tool', 'tab_list', 'switch_tab']);
const REF_KEYS = ['ref', 'next_ref', 'add_ref'];
/** 값이 아니라 이름을 담는 인자. 입력값과 무관한 글자로 본다. */
const NAME_KEYS = new Set(['dataset', 'source', 'target', 'name', 'row']);
const ROW_TOOLS = new Set(['click', 'type', 'select']);

/** 스킬의 내용이 바뀌면 저장한 경로를 쓰지 않도록 본문까지 넣어 만든 키 */
export function pathKey(skill: Skill): string {
  let h = 5381;
  for (let i = 0; i < skill.body.length; i++) h = ((h * 33) ^ skill.body.charCodeAt(i)) >>> 0;
  return `${skill.id}@${skill.version}#${h.toString(36)}`;
}

function mapStrings(value: unknown, fn: (s: string, key: string) => string, key = ''): unknown {
  if (typeof value === 'string') return fn(value, key);
  if (Array.isArray(value)) return value.map((v) => mapStrings(v, fn, key));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, mapStrings(v, fn, k)]));
  }
  return value;
}

/** 저장한 동작을 지금 화면의 번호로 바꾼다. 요소를 하나로 찾지 못하면 null. */
function rebuild(cached: CachedAction, snap: PageSnapshot, fill: (text: string) => string): Action | null {
  const args = mapStrings(cached.args, (s) => fill(s));
  const parsed = parseAction(JSON.stringify({ thought: '지난번에 성공한 경로를 다시 사용', tool: cached.tool, args }), snap);
  return parsed.ok ? parsed.action : null;
}

/**
 * 방금 성공한 동작을 저장할 모양으로 바꾼다. 다시 찾을 수 없는 요소를 가리키면 null.
 * free는 입력값에서 나왔는지 알 수 없는 글자가 들어 있다는 뜻이다. 스킬 본문(body)에 그대로 적힌 글자는
 * 입력값과 무관하므로 해당하지 않는다.
 */
export function toCached(
  action: Action,
  snap: PageSnapshot,
  values: Record<string, string>,
  body = '',
): { cached: CachedAction; free: boolean } | null {
  if (NEVER.has(action.tool)) return null;
  const holders = Object.entries(values).filter(([, v]) => v !== '');
  let free = false;
  /** 값이 정확히 하나의 입력값과 같으면 자리표시자로 바꾼다. */
  const template = (s: string, valueBearing: boolean) => {
    const same = holders.filter(([, v]) => v === s);
    if (same.length === 1) return `{${same[0][0]}}`;
    if (valueBearing && !body.includes(s)) free = true;
    return s;
  };

  const raw = action.args as Record<string, unknown>;
  const args: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (REF_KEYS.includes(key)) {
      if (value === undefined) continue;
      const el = findElement(snap, value as number);
      if (!el || el.name.trim() === '') return null;
      args[key] = template(el.name, false);
    } else if (key !== 'row') {
      args[key] = mapStrings(value, (s, k) => template(s, !NAME_KEYS.has(k)), key);
    }
  }

  const plain = (text: string) => text.replace(/\{([a-z_.0-9]+)\}/gi, (whole, name: string) => values[name] ?? whole);
  const same = (candidate: CachedAction) => {
    const back = rebuild(candidate, snap, plain);
    return back !== null && REF_KEYS.every((k) => (back.args as Record<string, unknown>)[k] === raw[k]);
  };
  const cached: CachedAction = { tool: action.tool, args };
  if (same(cached)) return { cached, free };
  // 같은 이름이 표의 행마다 있으면 그 행에만 있는 글자를 함께 적는다.
  const el = typeof raw.ref === 'number' ? findElement(snap, raw.ref) : undefined;
  if (el?.row && ROW_TOOLS.has(action.tool)) {
    for (const cell of el.row.split(' | ')) {
      if (cell.endsWith('…')) continue;
      const withRow = { tool: action.tool, args: { ...args, row: template(cell, false) } };
      if (same(withRow)) return { cached: withRow, free };
    }
  }
  return null;
}

export class PathMemo {
  private broken = new Set<number>();
  private pos = new Map<number, number>();
  private taken = new Map<number, ({ cached: CachedAction; free: boolean } | null)[]>();
  /** 모델이 동작을 정한 단계. 이 단계의 경로는 새로 저장한다. */
  private fresh = new Set<number>();

  private constructor(
    private key: string,
    private store: PathStore,
    private paths: SkillPaths,
    private inputs: Record<string, string>,
    private body: string,
  ) {}

  static async open(skill: Skill, inputs: Record<string, string | number>, store: PathStore): Promise<PathMemo> {
    const key = pathKey(skill);
    const paths = (await store.load(key).catch(() => null)) ?? {};
    const text = Object.fromEntries(Object.entries(inputs).map(([k, v]) => [k, String(v)]));
    return new PathMemo(key, store, { ...paths }, text, skill.body);
  }

  /** 이 단계에서 다음에 할 저장된 동작. 없거나 지금 화면에서 통하지 않으면 null. */
  next(step: number, snap: PageSnapshot, fill: (text: string) => string): Action | null {
    const path = this.paths[step];
    const at = this.pos.get(step) ?? 0;
    if (!path || this.broken.has(step) || at >= path.actions.length) return null;
    if (path.inputs && JSON.stringify(path.inputs) !== JSON.stringify(this.inputs)) return null;
    const action = rebuild(path.actions[at], snap, fill);
    if (!action) {
      this.broken.add(step);
      return null;
    }
    this.pos.set(step, at + 1);
    return action;
  }

  /** 저장된 동작이 실패했다. 이 단계의 나머지는 모델이 맡는다. */
  fail(step: number): void {
    this.broken.add(step);
  }

  /** 성공한 동작 하나를 적어 둔다. outputs는 앞 단계에서 화면에서 읽어 둔 값이다. */
  record(step: number, action: Action, snap: PageSnapshot, outputs: Record<string, string>, by: 'model' | 'cache'): void {
    // 단계를 넘길지는 그때의 화면을 보고 정해야 하므로 저장하지 않는다.
    if (action.tool === 'next_step') return;
    const values = { ...this.inputs, ...Object.fromEntries(Object.entries(outputs).map(([k, v]) => [`out.${k}`, v])) };
    const list = this.taken.get(step) ?? [];
    if (by === 'cache') {
      const stored = this.paths[step]?.actions[(this.pos.get(step) ?? 1) - 1];
      list.push(stored ? { cached: stored, free: this.paths[step].inputs !== undefined } : null);
    } else {
      this.fresh.add(step);
      list.push(toCached(action, snap, values, this.body));
    }
    this.taken.set(step, list);
  }

  /** 실행이 끝난 뒤 저장소를 고친다. 끝까지 간 단계의 새 경로를 넣고, 통하지 않은 경로는 지운다. */
  async commit(result: RunResult): Promise<void> {
    let changed = false;
    const finished = result.status === 'done' ? result.lastStep : result.status === 'dryrun' ? result.lastStep - 1 : 0;
    for (const step of this.broken) {
      if (this.paths[step]) {
        delete this.paths[step];
        changed = true;
      }
    }
    for (const [step, list] of this.taken) {
      if (step > finished) continue;
      if (!this.fresh.has(step)) {
        if (this.paths[step] && !this.broken.has(step)) {
          this.paths[step] = { ...this.paths[step], hits: this.paths[step].hits + 1 };
          changed = true;
        }
        continue;
      }
      const known = list.filter((a) => a !== null);
      if (known.length === list.length && list.length <= MAX_PATH_ACTIONS) {
        this.paths[step] = {
          actions: known.map((a) => a.cached),
          ...(known.some((a) => a.free) ? { inputs: this.inputs } : {}),
          hits: 0,
        };
        changed = true;
      } else if (this.paths[step]) {
        delete this.paths[step];
        changed = true;
      }
    }
    if (changed) await this.store.save(this.key, this.paths);
  }
}
