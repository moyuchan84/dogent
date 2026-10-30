import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  addRecorded,
  draftSkill,
  firstHeading,
  lintSkill,
  parseSkill,
  pickAppeared,
  resolveInputs,
  runSkill,
  type ApprovalRequest,
  type AuthorStep,
  type LlmPort,
  type RecordedEvent,
} from '../src/core';
import { createPageAgent } from '../src/page/agent';
import { JsdomBrowser, fwLog, memoryFiles, readWorkbook } from './helpers';

const SKILLS = join(import.meta.dirname, '../skills');
const META = { id: 'fw-recorded', name: '방화벽 신청(녹화)', description: '녹화로 만든 방화벽 신청 스킬', owner: '인프라운영' };

const noLlm: LlmPort = {
  async complete() {
    throw new Error('모델이 호출되면 안 됩니다');
  },
};

function approver(answer: boolean) {
  const requests: ApprovalRequest[] = [];
  return { requests, ask: async () => '', approve: async (r: ApprovalRequest) => (requests.push(r), answer) };
}

/** 사람이 칸에 값을 넣고 빠져나온 것처럼 만든다. */
function userSet(browser: JsdomBrowser, id: string, value: string) {
  const el = browser.document.getElementById(id) as HTMLInputElement;
  el.value = value;
  el.dispatchEvent(new browser.dom.window.Event('change', { bubbles: true }));
}

beforeEach(() => {
  fwLog.length = 0;
});

describe('스킬 품질 검사', () => {
  it('번들된 스킬은 모두 A등급이고 전 단계가 모델 없이 실행된다', () => {
    for (const id of readdirSync(SKILLS).filter((d) => d !== 'systems')) {
      const policy = join(SKILLS, id, 'policy.yaml');
      const report = lintSkill(
        readFileSync(join(SKILLS, id, 'SKILL.md'), 'utf8'),
        existsSync(policy) ? readFileSync(policy, 'utf8') : undefined,
      );
      // 어느 사이트에서나 쓰는 기본 스킬(domains "*")은 화면을 미리 알 수 없어 목표 단계를 모델이 판단한다. 오류만 없으면 된다.
      if (/^domains:\s*\n\s*-\s*"\*"/m.test(readFileSync(join(SKILLS, id, 'SKILL.md'), 'utf8'))) {
        expect(report.findings.filter((f) => f.level === 'error'), id).toEqual([]);
        continue;
      }
      expect(report.findings, id).toEqual([]);
      expect(report.grade, id).toBe('A');
      expect(report.direct.count, id).toBe(report.direct.total);
    }
  });

  const base = (steps: string, front = '') => `---
id: t
name: 시험
description: 검사 규칙 시험용
version: 0.1.0
owner: 시험
risk: R1
domains: [localhost:4173]
${front}---

## 단계

${steps}

## 예외

- 오류가 나오면 abort한다.
`;
  const rules = (source: string) => lintSkill(source).findings.map((f) => `${f.rule}@${f.step ?? 0}`);

  it('형식이 깨진 문서는 F', () => {
    const r = lintSkill('없음');
    expect(r.grade).toBe('F');
    expect(r.deployable).toBe(false);
  });

  it('인자 형식, 없는 입력, 없는 데이터셋, 허용 밖 주소를 오류로 잡는다', () => {
    const found = rules(
      base(
        [
          '1. navigate로 이동한다.\n   `{"url": "http://evil.example/x"}`\n   - 검사: url("/x")',
          '2. select로 고른다.\n   `{"ref": "라인"}`\n   - 검사: value("라인") == "{line}"',
          '3. write_excel로 저장한다.\n   `{"filename": "a", "sheets": [{"name": "s", "dataset": "none"}]}`\n   - 검사: did("write_excel")',
          '4. finish로 보고한다.\n   `{"summary": "{out.id} {rows.none}"}`',
        ].join('\n'),
      ),
    );
    expect(found).toEqual(['E06@1', 'E03@2', 'E02@2', 'E05@3', 'E03@4', 'E05@4']);
  });

  it('엑셀 도구: excel_read가 만든 데이터셋은 뒤 단계가 쓰고, 없는 데이터셋을 쓰면 오류', () => {
    const ok = rules(
      base(
        [
          '1. excel_read로 읽는다.\n   `{"doc": "재공.xlsx", "dataset": "wip"}`\n   - 검사: did("excel_read")',
          '2. finish로 보고한다.\n   `{"summary": "{rows.wip}행"}`',
        ].join('\n'),
      ),
    );
    expect(ok).not.toContain('E05@2');
    const bad = rules(base('1. excel_write로 쓴다.\n   `{"doc": "a.xlsx", "dataset": "none", "sheet": "s"}`\n   - 검사: did("excel_write")'));
    expect(bad).toContain('E05@1');
  });

  it('저장·상신 버튼은 R3와 submit_steps 선언이 있어야 한다', () => {
    const steps = '1. click으로 누른다.\n   `{"ref": "상신"}`\n   - 검사: did("click") and text("접수")\n2. finish로 보고한다.\n   `{"summary": "끝"}`';
    expect(rules(base(steps))).toEqual(['E04@1']);
    const r3 = base(steps, 'submit_steps: [1]\nsubmit_labels: [상신]\n').replace('risk: R1', 'risk: R3');
    expect(rules(r3)).toEqual([]);
    expect(rules(r3.replace('submit_steps: [1]', 'submit_steps: [2]'))).toEqual(['E04@1']);
    expect(rules(r3.replace('[상신]', '[저장]'))).toEqual(['E04@1']);
  });

  it('검사 없는 중간 단계와 약한 검사는 경고로, 목표 단계는 안내로 알린다', () => {
    const r = lintSkill(
      base(
        [
          '1. 조회 화면으로 간다.',
          '2. click으로 누른다.\n   `{"ref": "조회"}`\n   - 검사: did("click")',
          '3. 결과를 알려준다.',
        ].join('\n'),
        'inputs:\n  - name: line\n',
      ),
    );
    expect(r.findings.map((f) => `${f.rule}@${f.step ?? 0}`)).toEqual([
      'I01@1',
      'W01@1',
      'W03@2',
      'I01@3',
      'W04@0',
    ]);
    expect(r.grade).toBe('C');
    expect(r.deployable).toBe(false);
    expect(r.direct).toEqual({ count: 1, total: 3 });
  });
});

describe('조작 녹화로 스킬 초안 만들기', () => {
  it('누른 뒤 새로 나타난 글자에서 바뀌는 부분을 뺀 것을 결과 조건으로 고른다', () => {
    const snap = (...texts: string[]) => ({
      url: 'http://a/',
      title: '',
      hasPassword: false,
      items: texts.map((text) => ({ kind: 'text' as const, text })),
    });
    expect(pickAppeared(snap('조회 조건'), snap('조회 조건', '총 142건'))).toBe('총');
    expect(pickAppeared(snap(), snap('신청이 접수되었습니다. 신청 번호: FW-000001 (결재 대기)'))).toBe('신청이 접수되었습니다.');
    expect(pickAppeared(snap('a'), snap('a'))).toBeUndefined();
  });

  it('같은 칸을 고쳐 쓰면 마지막 값만 남긴다', () => {
    const type = (value: string): RecordedEvent => ({ kind: 'type', name: '포트', value, dup: false, multiline: false, numeric: false });
    const steps = addRecorded(addRecorded([], type('15')), type('1521'));
    expect(steps).toHaveLength(1);
    expect(steps[0]).toMatchObject({ value: '1521', variable: true });
  });

  it('방화벽 신청을 한 번 해 보이면 같은 품질의 스킬이 나오고, 그 스킬이 모델 없이 그대로 돈다', async () => {
    // 1) 사람이 한 번 해 보인다.
    const page = await JsdomBrowser.open('/fw.html');
    let steps: AuthorStep[] = [];
    const recorder = createPageAgent(page.dom.window as any, (e) => (steps = addRecorded(steps, e)));
    const start = { url: page.dom.window.location.href, heading: firstHeading(await page.snapshot()) };
    recorder.record(true);
    userSet(page, 'src', '10.10.1.15');
    userSet(page, 'dst', '10.20.3.7');
    userSet(page, 'port', '15');
    userSet(page, 'port', '1521');
    (page.document.getElementById('proto') as HTMLSelectElement).value = 'UDP';
    page.document.getElementById('proto')!.dispatchEvent(new page.dom.window.Event('change', { bubbles: true }));
    userSet(page, 'days', '90');
    userSet(page, 'reason', '개발 서버에서 운영 DB 조회 배치 실행');
    const before = await page.snapshot();
    page.document.getElementById('submit')!.click();
    await page.waitFor('신청 번호', 3000);
    const clicked = steps[steps.length - 1];
    expect(clicked).toMatchObject({ kind: 'click', name: '상신', role: 'button' });
    steps = [...steps.slice(0, -1), { ...clicked, expect: pickAppeared(before, await page.snapshot()) } as AuthorStep];
    recorder.record(false);

    expect(steps.map((s) => s.kind)).toEqual(['type', 'type', 'type', 'select', 'type', 'type', 'click']);
    // 프로토콜은 늘 UDP로 고정하고 나머지는 실행할 때 받는다.
    steps = steps.map((s) => (s.kind === 'select' ? { ...s, variable: false } : s));

    // 2) 초안은 손대지 않아도 형식과 통제 선언을 갖춘다.
    const { source } = draftSkill(META, start, steps);
    const skill = parseSkill(source);
    expect(skill.risk).toBe('R3');
    expect(skill.submit_steps).toEqual([8]);
    expect(skill.submit_labels).toEqual(['상신']);
    expect(skill.inputs.map((i) => [i.name, i.label, i.type])).toEqual([
      ['v1', '출발지 IP', 'string'],
      ['v2', '목적지 IP', 'string'],
      ['v3', '포트', 'string'],
      ['v4', '기간(일)', 'number'],
      ['v5', '사유', 'text'],
    ]);
    expect(source).toContain('- 검사: did("click") and text("신청이 접수되었습니다.")');
    const report = lintSkill(source);
    // 남는 지적은 입력값 규칙(policy.yaml)을 사람이 정하라는 것 하나다.
    expect(report.findings.map((f) => f.rule)).toEqual(['W07']);
    expect(report.grade).toBe('B');
    expect(report.direct).toEqual({ count: 9, total: 9 });

    // 3) 만든 스킬을 다른 값으로 실행한다. 모델은 부르지 않고, 상신 승인은 받는다.
    const { values, errors } = resolveInputs(skill, { v1: '10.10.9.9', v2: '10.20.9.9', v3: '443', v4: '30', v5: '테스트 서버 연동 확인' });
    expect(errors).toEqual([]);
    fwLog.length = 0;
    const ui = approver(true);
    const result = await runSkill(skill, values, { llm: noLlm, browser: new JsdomBrowser(), ui, files: memoryFiles(), direct: true });
    expect(result.status, result.message).toBe('done');
    expect(ui.requests).toHaveLength(1);
    expect(fwLog).toEqual([
      { id: 'FW-000001', src: '10.10.9.9', dst: '10.20.9.9', port: '443', protocol: 'UDP', days: '30', reason: '테스트 서버 연동 확인' },
    ]);
  });

  it('표를 읽는 조회 업무도 녹화로 만들어 엑셀까지 저장한다', async () => {
    const page = await JsdomBrowser.open('/wip.html');
    let steps: AuthorStep[] = [];
    const recorder = createPageAgent(page.dom.window as any, (e) => (steps = addRecorded(steps, e)));
    const start = { url: page.dom.window.location.href, heading: firstHeading(await page.snapshot()) };
    recorder.record(true);
    const line = [...page.document.querySelectorAll('select')][0];
    line.value = [...line.options].find((o) => o.textContent!.includes('7라인'))!.value;
    line.dispatchEvent(new page.dom.window.Event('change', { bubbles: true }));
    const before = await page.snapshot();
    const search = [...page.document.querySelectorAll('button')].find((b) => b.textContent!.trim() === '조회')!;
    search.click();
    await page.waitFor('총', 3000);
    const after = await page.snapshot();
    steps = [...steps.slice(0, -1), { ...steps[steps.length - 1], expect: pickAppeared(before, after) } as AuthorStep];
    const table = after.items.find((i) => i.kind === 'el' && i.role === 'table');
    steps.push({ kind: 'extract', name: (table as { name: string }).name });

    const { source } = draftSkill({ ...META, id: 'wip-recorded', name: '재공 조회(녹화)' }, start, steps);
    const report = lintSkill(source);
    expect(report.findings).toEqual([]);
    const skill = report.skill!;
    expect(skill.risk).toBe('R1');
    expect(skill.inputs[0]).toMatchObject({ name: 'v1', label: '라인', type: 'enum' });

    const files = memoryFiles();
    const result = await runSkill(skill, { v1: '8라인' }, { llm: noLlm, browser: new JsdomBrowser(), ui: approver(true), files, direct: true });
    expect(result.status, result.message).toBe('done');
    const book = await readWorkbook(files.saved.get('재공 조회(녹화).xlsx')!);
    expect(book['표1'].length).toBeGreaterThan(1);
    expect(result.message).toContain(`표1 ${book['표1'].length - 1}행`);
  });

  it('비밀번호 칸은 녹화하지 않는다', async () => {
    const page = await JsdomBrowser.open('/login.html');
    const events: RecordedEvent[] = [];
    createPageAgent(page.dom.window as any, (e) => events.push(e)).record(true);
    const pw = page.document.querySelector('input[type=password]') as HTMLInputElement;
    pw.value = 'secret';
    pw.dispatchEvent(new page.dom.window.Event('change', { bubbles: true }));
    expect(events).toEqual([]);
  });
});
