import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  captureCase,
  describeCase,
  EvalCase,
  formatReports,
  OpenAiCompatClient,
  parseCases,
  runToolEval,
  type Action,
  type EvalReport,
  type LlmSettings,
  type PageSnapshot,
  type TurnInput,
} from '../../src/core';
import { setConfig, type ClientConfig } from './config';
import type { Terminal } from './terminal';

/** 클라이언트에 넣은 기본 평가 케이스 (evals/tool-calls/*.json을 합친 것). 빌드 밖(시험)에서는 없다 */
declare const __DOGENT_EVAL_CASES__: unknown[] | undefined;

export const EVAL_USAGE = `사용법:
  dogent eval tools [파일|폴더 …] [--modes plain,json,schema] [--tag <태그>] [--id <글>] [--all] [--limit <수>] [--out <파일>]
        도구 호출 평가. 같은 케이스를 답 형식별로 모델에 물어 정답률을 나란히 보여 준다 (기본 --modes json,schema).
        파일을 안 주면 기본 케이스(모의 사이트)와 ~/.dogent/evals 아래의 케이스. --all이면 검토 전 케이스도 넣는다
        plain = 형식 지정 없음, json = response_format json_object, schema = json_schema(제약 디코딩)
  dogent eval capture on|off|<폴더>   실제 실행에서 모델이 정한 차례를 케이스로 모은다 (기본 폴더 ~/.dogent/evals/captured)
  dogent eval review [폴더]           모은 케이스를 하나씩 보고 정답을 확인·고친다
  dogent eval list [파일|폴더 …]       케이스 수 (출처·검토 여부·태그별)`;

/** 실행이 모델에게 동작을 물을 때마다 케이스 파일을 하나씩 남긴다. 실패해도 실행은 멈추지 않는다 */
export function captureWriter(dir: string, warn: (msg: string) => void = () => {}): (turn: TurnInput, snap: PageSnapshot, action: Action) => void {
  let warned = false;
  return (turn, snap, action) => {
    try {
      const c = captureCase(turn, snap, action);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, `${c.id}.json`), `${JSON.stringify(c, null, 1)}\n`);
    } catch (e) {
      if (!warned) warn(`평가 케이스를 남기지 못했습니다 (${dir}): ${(e as Error).message}`);
      warned = true;
    }
  };
}

interface Loaded {
  file: string;
  cases: EvalCase[];
}

function filesIn(path: string): string[] {
  if (!existsSync(path)) return [];
  if (!statSync(path).isDirectory()) return [path];
  return readdirSync(path, { withFileTypes: true }).flatMap((d) =>
    d.isDirectory() ? (d.name === 'reports' ? [] : filesIn(join(path, d.name))) : /\.jsonl?$/.test(d.name) ? [join(path, d.name)] : [],
  );
}

/** 파일·폴더에서 케이스를 읽는다. 경로가 없으면 기본 케이스와 ~/.dogent/evals */
export function loadEvalCases(paths: string[], home: string, warn: (msg: string) => void): Loaded[] {
  const out: Loaded[] = [];
  const add = (file: string, text: string) => {
    const { cases, errors } = parseCases(text, file);
    for (const e of errors) warn(e);
    if (cases.length) out.push({ file, cases });
  };
  if (paths.length === 0) {
    if (typeof __DOGENT_EVAL_CASES__ !== 'undefined' && __DOGENT_EVAL_CASES__) add('(기본 케이스)', JSON.stringify(__DOGENT_EVAL_CASES__));
    paths = [join(home, 'evals')];
  }
  for (const p of paths) {
    const files = filesIn(p);
    if (files.length === 0 && paths.length > 0 && !p.endsWith('evals')) warn(`${p}: 케이스 파일이 없습니다`);
    for (const f of files) add(f, readFileSync(f, 'utf8'));
  }
  return out;
}

const MODES: Record<string, Partial<LlmSettings>> = {
  plain: { jsonMode: false, jsonSchema: false },
  json: { jsonMode: true, jsonSchema: false },
  // 서버가 json_schema를 거절하면 json_object로 다시 보낸다 (그 사실은 보고서에 적는다)
  schema: { jsonMode: true, jsonSchema: true },
};

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

/** dogent eval … */
export async function runEvalCommand(args: string[], cfg: ClientConfig, term: Terminal): Promise<number> {
  const [sub, ...rest] = args;
  const warn = (m: string) => term.print(`  (주의) ${m}`);
  if (sub === 'capture') {
    const v = rest[0];
    if (!v) {
      term.print(cfg.evalCapture ? `모으는 중: ${cfg.evalCapture}` : '꺼져 있습니다. 켜려면 dogent eval capture on');
      return 0;
    }
    setConfig('evalCapture', v);
    term.print(/^(off|false|0|끔)$/i.test(v) ? '평가 케이스 모으기를 껐습니다' : `켰습니다. 모델이 동작을 정할 때마다 ${/^(on|true|1|켬)$/i.test(v) ? join(cfg.home, 'evals', 'captured') : v}에 케이스가 쌓입니다.\n사내 화면의 글이 그대로 들어가므로 사내 밖(개인 저장소 등)에 올리지 마세요. 검토: dogent eval review`);
    return 0;
  }
  if (sub === 'list') {
    const loaded = loadEvalCases(rest, cfg.home, warn);
    const all = loaded.flatMap((l) => l.cases);
    const count = (key: (c: EvalCase) => string[]) => {
      const m = new Map<string, number>();
      for (const c of all) for (const k of key(c)) m.set(k, (m.get(k) ?? 0) + 1);
      return [...m].sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ${n}`).join(', ');
    };
    term.print(`케이스 ${all.length}개 (파일 ${loaded.length}개)`);
    term.print(`  출처: ${count((c) => [c.source ?? 'manual'])}`);
    term.print(`  검토: ${count((c) => [c.reviewed ? '검토함' : '검토 전'])}`);
    term.print(`  태그: ${count((c) => c.tags)}`);
    return 0;
  }
  if (sub === 'review') return review(rest[0] ?? join(cfg.home, 'evals', 'captured'), term);
  if (sub !== 'tools') {
    term.print(EVAL_USAGE);
    return sub ? 1 : 0;
  }

  const paths = rest.filter((a, i) => !a.startsWith('--') && !(i > 0 && rest[i - 1].startsWith('--') && rest[i - 1] !== '--all'));
  let cases = loadEvalCases(paths, cfg.home, warn).flatMap((l) => l.cases);
  const unreviewed = cases.filter((c) => !c.reviewed).length;
  if (!rest.includes('--all')) cases = cases.filter((c) => c.reviewed);
  const tag = flag(rest, '--tag');
  if (tag) cases = cases.filter((c) => c.tags.includes(tag));
  const id = flag(rest, '--id');
  if (id) cases = cases.filter((c) => c.id.includes(id));
  const limit = Number(flag(rest, '--limit'));
  if (limit > 0) cases = cases.slice(0, limit);
  if (cases.length === 0) {
    term.print(`평가할 케이스가 없습니다${unreviewed ? ` (검토 전 ${unreviewed}개는 --all 또는 dogent eval review)` : ''}`);
    return 1;
  }
  const modes = (flag(rest, '--modes') ?? 'json,schema').split(',').map((m) => m.trim()).filter(Boolean);
  const bad = modes.filter((m) => !(m in MODES));
  if (bad.length) throw new Error(`모르는 방식: ${bad.join(', ')} (plain, json, schema 중에서)`);

  term.print(`도구 호출 평가: 모델 ${cfg.llm.model} (${cfg.llm.baseUrl}) · 케이스 ${cases.length}개 · 방식 ${modes.join(', ')}`);
  if (unreviewed && !rest.includes('--all')) term.print(`  검토 전 케이스 ${unreviewed}개는 뺐습니다 (dogent eval review)`);
  const reports: EvalReport[] = [];
  for (const mode of modes) {
    const client = new OpenAiCompatClient({ ...cfg.llm, ...MODES[mode] });
    const report = await runToolEval(cases, client, {
      label: mode,
      onResult: (r, i) => term.print(`  [${mode}] ${String(i + 1).padStart(3)}/${cases.length} ${r.exact ? '맞음' : r.tool ? '인자 틀림' : r.error ? '호출 오류' : r.valid ? '도구 틀림' : '형식 오류'}  ${r.id} (${(r.ms / 1000).toFixed(1)}초)`),
    });
    if (client.schemaRejected) report.note = `서버가 json_schema를 받지 않아 json_object로 보냈습니다: ${client.schemaRejected}`;
    reports.push(report);
  }
  term.print('');
  term.print(formatReports(reports));
  const out = flag(rest, '--out') ?? join(cfg.home, 'evals', 'reports', `${new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15)}.json`);
  mkdirSync(join(out, '..'), { recursive: true });
  writeFileSync(out, JSON.stringify({ model: cfg.llm.model, baseUrl: cfg.llm.baseUrl, at: new Date().toISOString(), reports }, null, 1));
  term.print(`\n결과 파일: ${out}`);
  return 0;
}

/** 모은 케이스를 하나씩 보여 주고 정답을 확인받는다 */
async function review(dir: string, term: Terminal): Promise<number> {
  const files = filesIn(dir);
  const todo: { file: string; c: EvalCase }[] = [];
  for (const f of files) {
    const { cases } = parseCases(readFileSync(f, 'utf8'), f);
    if (cases.length === 1 && !cases[0].reviewed) todo.push({ file: f, c: cases[0] });
  }
  if (todo.length === 0) {
    term.print(`${dir}에 검토할 케이스가 없습니다`);
    return 0;
  }
  term.print(`검토할 케이스 ${todo.length}개. 정답 자리에는 그때 모델이 고른 동작이 들어 있습니다.`);
  let done = 0;
  for (const [i, { file, c }] of todo.entries()) {
    term.print(`\n──── ${i + 1}/${todo.length} ────`);
    term.print(describeCase(c));
    for (;;) {
      const a = (await term.ask('\n맞으면 y · 틀렸으면 정답 JSON {"tool":…,"args":{…}} · 지우기 d · 건너뛰기 Enter · 그만 q\n> '))?.trim();
      if (a === null || a === undefined || a === 'q') {
        term.print(`검토 ${done}개를 저장했습니다`);
        return 0;
      }
      if (a === '') break;
      if (a === 'd') {
        rmSync(file);
        break;
      }
      let next: EvalCase;
      if (a === 'y') next = { ...c, reviewed: true };
      else {
        try {
          const raw = JSON.parse(a) as unknown;
          next = EvalCase.parse({ ...c, reviewed: true, expect: raw });
        } catch (e) {
          term.print(`정답을 읽지 못했습니다: ${(e as Error).message.split('\n')[0]}. 예: {"tool":"click","args":{"ref":4}}`);
          continue;
        }
      }
      writeFileSync(file, `${JSON.stringify(next, null, 1)}\n`);
      done++;
      break;
    }
  }
  term.print(`\n검토 ${done}개를 저장했습니다. 평가: dogent eval tools`);
  return 0;
}
