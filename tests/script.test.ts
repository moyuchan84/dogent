import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { localScripts } from '../client/src/scripts';
import { loadSkills } from '../client/src/skills';
import {
  DatasetStore,
  lintSkill,
  noBrowser,
  parseScriptOutput,
  parseSkill,
  renderSpec,
  runSkill,
  scriptHash,
  syncSkills,
  ComposeSpec,
  type RunEvent,
  type ScriptPort,
  type ScriptRequest,
} from '../src/core';
import { memoryFiles, scriptedLlm } from './helpers';

const SKILL = `---
id: lot-merge
name: Lot 합치기
description: 재공 표와 HOLD 표를 LOT으로 합친다
version: 0.1.0
owner: 생산관리
risk: R1
domains: ["mes.example.com"]
inputs:
  - name: wip_file
    type: file
    dataset: wip
  - name: hold_file
    type: file
    dataset: hold
scripts:
  - name: merge
    file: scripts/merge.mjs
    description: 두 표를 LOT 열로 합쳐 merged 표를 돌려준다
---

## 단계

1. run_script로 두 표를 합친다. args는 다음을 그대로 쓴다.
   \`{"script":"merge","datasets":["wip","hold"],"args":{"key":"LOT"},"name":"note"}\`
   - 검사: did("run_script")
2. finish로 보고한다. args는 다음을 그대로 쓴다.
   \`{"summary":"{rows.merged}행. {out.note}"}\`

## 예외

- 오류가 나면 abort로 알린다.
`;

/** 두 표를 key 열로 합친다. 권한 모드에서도 도는 표준 입출력만 쓴다 */
const MERGE = `let raw = '';
process.stdin.setEncoding('utf8').on('data', (c) => (raw += c)).on('end', () => {
  const { args, datasets } = JSON.parse(raw);
  const [a, b] = Object.values(datasets);
  const ka = a.columns.indexOf(args.key), kb = b.columns.indexOf(args.key);
  const extra = b.columns.filter((_, i) => i !== kb);
  const byKey = new Map(b.rows.map((r) => [r[kb], r.filter((_, i) => i !== kb)]));
  const rows = a.rows.map((r) => [...r, ...(byKey.get(r[ka]) ?? extra.map(() => null))]);
  console.log('합치는 중'); // 앞에 찍은 로그는 건너뛴다
  console.log(JSON.stringify({ datasets: { merged: { columns: [...a.columns, ...extra], rows } }, text: 'HOLD ' + byKey.size + '건', files: [{ name: 'merged.csv', text: 'ok' }] }));
});
`;

const files = { 'scripts/merge.mjs': MERGE };
const datasets = () => {
  const d = new DatasetStore();
  d.set('wip', ['LOT', '수량'], [['L1', 10], ['L2', 20]]);
  d.set('hold', ['LOT', '사유'], [['L2', '검사 대기']]);
  return d;
};

/** 실제로 실행하지 않고 요청을 받아 두는 통로 */
function fakePort(reply: Partial<{ stdout: string; stderr: string; code: number | null; timedOut: boolean }> = {}) {
  const approved = new Set<string>();
  const runs: ScriptRequest[] = [];
  const port: ScriptPort = {
    async run(req) {
      runs.push(req);
      return { stdout: '', stderr: '', code: 0, ...reply };
    },
    approved: async (h) => approved.has(h),
    remember: async (h) => void approved.add(h),
    sandbox: () => '시험용',
  };
  return { port, runs, approved };
}

function run(port: ScriptPort | undefined, answer = true) {
  const asked: string[] = [];
  const events: RunEvent[] = [];
  const out = memoryFiles();
  const done = runSkill(parseSkill(SKILL, undefined, files), {}, {
    llm: scriptedLlm([{ tool: 'abort', args: { reason: '모델까지 옴' } }]),
    browser: noBrowser(),
    datasets: datasets(),
    files: out,
    direct: true,
    scripts: port,
    ui: { ask: async () => '', approve: async () => false, confirm: async (m) => (asked.push(m), answer) },
    onEvent: (e) => events.push(e),
  });
  return done.then((result) => ({ result, asked, events, files: out }));
}

describe('스킬 스크립트 선언', () => {
  it('선언과 스킬 폴더의 파일을 함께 읽는다', () => {
    const s = parseSkill(SKILL, undefined, files);
    expect(s.scripts).toEqual([{ name: 'merge', file: 'scripts/merge.mjs', description: '두 표를 LOT 열로 합쳐 merged 표를 돌려준다', network: false, timeout_sec: 60 }]);
    expect(s.scriptSources['scripts/merge.mjs']).toBe(MERGE);
    expect(() => parseSkill(SKILL.replace('file: scripts/merge.mjs', 'file: ../merge.mjs'))).toThrow(/scripts\//);
  });

  it('품질 검사: 선언하지 않은 스크립트, 없는 파일, Python, 선언 없는 네트워크', () => {
    expect(lintSkill(SKILL, undefined, files).findings.filter((f) => f.level !== 'info')).toEqual([]);
    expect(lintSkill(SKILL, undefined, {}).findings.some((f) => f.rule === 'E07' && f.message.includes('스킬 폴더에 없습니다'))).toBe(true);
    expect(lintSkill(SKILL.replace('"script":"merge"', '"script":"join"'), undefined, files).findings.some((f) => f.rule === 'E07')).toBe(true);
    const py = SKILL.replace('scripts/merge.mjs', 'scripts/merge.py');
    expect(lintSkill(py, undefined, { 'scripts/merge.py': 'import json' }).findings.some((f) => f.rule === 'W10' && f.message.includes('Python'))).toBe(true);
    expect(lintSkill(SKILL, undefined, { 'scripts/merge.mjs': 'await fetch("http://x")' }).findings.some((f) => f.rule === 'W10' && f.message.includes('네트워크'))).toBe(true);
  });

  it('출력: 마지막 JSON 줄을 읽고, 모양이 틀리면 이유를 알린다', () => {
    expect(parseScriptOutput('로그\n{"text":"a"}').text).toBe('a');
    expect(() => parseScriptOutput('그냥 글')).toThrow(/JSON이 아닙니다/);
    expect(() => parseScriptOutput('{"datasets":{"a b":{"columns":[],"rows":[]}}}')).toThrow(/모양이 맞지 않습니다/);
  });
});

describe('run_script 실행', () => {
  it('처음에는 코드를 보여 주고 승인받고, 같은 내용은 다시 묻지 않는다', async () => {
    const stdout = JSON.stringify({ datasets: { merged: { columns: ['LOT'], rows: [['L1'], [null]] } }, text: '좋음', files: [{ name: 'a/b.txt', text: 'hi' }] });
    const { port, runs } = fakePort({ stdout });
    const first = await run(port);
    expect(first.result.status, first.result.message).toBe('done');
    expect(first.result.message).toBe('2행. 좋음');
    expect(first.asked).toHaveLength(1);
    expect(first.asked[0]).toContain('scripts/merge.mjs');
    expect(first.asked[0]).toContain("const { args, datasets } = JSON.parse(raw);");
    expect(JSON.parse(runs[0].input)).toEqual({ args: { key: 'LOT' }, datasets: { wip: { columns: ['LOT', '수량'], rows: [['L1', 10], ['L2', 20]] }, hold: { columns: ['LOT', '사유'], rows: [['L2', '검사 대기']] } } });
    expect(first.result.files).toEqual(['a_b.txt']);
    const again = await run(port);
    expect(again.result.status).toBe('done');
    expect(again.asked).toHaveLength(0);
  });

  it('승인하지 않으면 실행하지 않고 멈춘다', async () => {
    const { port, runs } = fakePort();
    const { result } = await run(port, false);
    expect(result.status).toBe('aborted');
    expect(result.message).toContain('허락하지 않았습니다');
    expect(runs).toHaveLength(0);
  });

  it('내용이 바뀌면 해시가 달라 다시 묻는다', async () => {
    expect(await scriptHash('lot-merge', 'scripts/merge.mjs', MERGE)).not.toBe(await scriptHash('lot-merge', 'scripts/merge.mjs', `${MERGE}// 한 줄`));
    expect(await scriptHash('a', 'f', 'x\r\ny')).toBe(await scriptHash('a', 'f', 'x\ny'));
  });

  it('실패하면 오류 끝부분을 모델에 넘기고, 실행 통로가 없으면 그렇다고 알린다', async () => {
    const failed = await run(fakePort({ code: 1, stderr: 'TypeError: x is undefined' }).port);
    const entry = failed.events.find((e) => e.type === 'action' && e.entry.tool === 'run_script');
    expect(entry && entry.type === 'action' && entry.entry.result).toContain('TypeError: x is undefined');
    const none = await run(undefined);
    const e2 = none.events.find((e) => e.type === 'action' && e.entry.tool === 'run_script');
    expect(e2 && e2.type === 'action' && e2.entry.result).toContain('데스크탑 앱이나 터미널 클라이언트');
  });
});

describe('이 PC에서 실행 (Node 권한 모드)', () => {
  const home = () => mkdtempSync(join(tmpdir(), 'dogent-scripts-'));
  const req = (code: string, input = '{"args":{},"datasets":{}}', timeoutMs = 20_000): ScriptRequest => ({ skill: 't', name: 'x', file: 'scripts/x.mjs', lang: 'node', code, input, timeoutMs });

  it('스크립트로 표를 합친다 (끝까지)', async () => {
    const h = home();
    const { result, files: out } = await run(localScripts(h));
    expect(result.status, result.message).toBe('done');
    expect(result.message).toBe('2행. HOLD 1건');
    expect(new TextDecoder().decode(out.saved.get('merged.csv'))).toBe('ok');
    // 승인은 파일에 남아 다음 실행에서 다시 묻지 않는다
    expect((await run(localScripts(h))).asked).toHaveLength(0);
  });

  it('파일 쓰기와 다른 프로그램 실행은 막힌다', async () => {
    const port = localScripts(home());
    const write = await port.run(req(`import { writeFileSync } from 'node:fs'; writeFileSync('x.txt', '1');`));
    expect(write.code).not.toBe(0);
    expect(write.stderr).toContain('ERR_ACCESS_DENIED');
    const exec = await port.run(req(`import { execSync } from 'node:child_process'; execSync('echo hi');`));
    expect(exec.code).not.toBe(0);
    expect(exec.stderr).toContain('ERR_ACCESS_DENIED');
  });

  it('시간이 지나면 끊는다', async () => {
    const r = await localScripts(home()).run(req('setInterval(() => {}, 1000);', '{}', 500));
    expect(r.timedOut).toBe(true);
    expect(r.code).toBeNull();
  });
});

describe('스킬 폴더·저장소·만들기', () => {
  it('개인 폴더와 기본 스킬의 scripts/를 함께 읽는다', () => {
    const root = mkdtempSync(join(tmpdir(), 'dogent-skills-'));
    mkdirSync(join(root, 'lot-merge', 'scripts'), { recursive: true });
    writeFileSync(join(root, 'lot-merge', 'SKILL.md'), SKILL);
    writeFileSync(join(root, 'lot-merge', 'scripts', 'merge.mjs'), MERGE);
    const mine = loadSkills({ personal: root }).skills[0].skill;
    expect(mine.scriptSources['scripts/merge.mjs']).toBe(MERGE);
    const built = loadSkills({ personal: join(root, '없음') }, { 'lot-merge/SKILL.md': SKILL, 'lot-merge/scripts/merge.mjs': MERGE }).skills[0].skill;
    expect(built.scriptSources['scripts/merge.mjs']).toBe(MERGE);
  });

  it('공유 저장소는 목록에 적힌 스크립트를 받고, 없으면 스킬을 쓰지 않는다', async () => {
    const base = 'https://git.example.com/skills/';
    const store: Record<string, string> = { 'index.json': '', 'lot-merge/SKILL.md': SKILL, 'lot-merge/scripts/merge.mjs': MERGE };
    const ports = { fetchText: async (u: string) => store[u.slice(base.length)] ?? Promise.reject(new Error('404')) };
    store['index.json'] = JSON.stringify({ skills: [{ id: 'lot-merge', path: 'lot-merge/SKILL.md', files: [{ path: 'lot-merge/scripts/merge.mjs' }] }] });
    const ok = await syncSkills(`${base}index.json`, ports);
    expect(ok.errors).toEqual([]);
    expect(ok.skills[0].files).toEqual({ 'scripts/merge.mjs': MERGE });
    store['index.json'] = JSON.stringify({ skills: [{ id: 'lot-merge', path: 'lot-merge/SKILL.md' }] });
    const missing = await syncSkills(`${base}index.json`, ports);
    expect(missing.skills).toEqual([]);
    expect(missing.errors[0]).toContain('스킬 폴더에 없습니다');
  });

  it('말로 만들기: 모델이 쓴 스크립트를 선언과 파일로 만든다', () => {
    const spec = ComposeSpec.parse({
      id: 'lot-merge',
      name: 'Lot 합치기',
      description: '두 표를 합친다',
      steps: [
        { text: '"재공" 표를 읽는다' },
        { text: '읽은 표로 HOLD 사유를 붙인다', script: 'Merge Lots' },
        { text: '결과를 정리해 보고한다' },
      ],
      scripts: [{ name: 'Merge Lots', lang: 'node', description: '표를 LOT으로 합친다', code: MERGE }],
    });
    const { source, files: out, notes } = renderSpec(spec, { url: 'https://mes.example.com/wip', owner: '생산관리' });
    expect(Object.keys(out)).toEqual(['scripts/merge-lots.mjs']);
    expect(source).toContain('scripts:\n  - name: merge-lots\n    file: scripts/merge-lots.mjs');
    expect(source).toContain('스크립트 "merge-lots"을(를) run_script로 부르고');
    expect(notes.join('\n')).not.toContain('스크립트');
    const report = lintSkill(source, undefined, out);
    expect(report.findings.filter((f) => f.level === 'error')).toEqual([]);
  });
});
