import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { generateWip } from '../mock-site/data.mjs';
import { wipXlsx } from '../mock-site/server.mjs';
import {
  DatasetStore,
  addRecorded,
  draftSkill,
  lintSkill,
  parseSkill,
  readDownloadedTable,
  runSkill,
  type AuthorStep,
  type LlmPort,
} from '../src/core';
import { JsdomBrowser, memoryFiles, readWorkbook, scriptedLlm } from './helpers';

const ui = { ask: async () => '', approve: async () => false };
const num = (s: string) => Number(s.replace(/,/g, ''));
const bytes = (...parts: (string | number[])[]) =>
  new Uint8Array(parts.flatMap((p) => (typeof p === 'string' ? [...new TextEncoder().encode(p)] : p))).buffer as ArrayBuffer;

const noLlm: LlmPort = {
  async complete() {
    throw new Error('모델이 호출되면 안 됩니다');
  },
};

const downloadSkill = () => parseSkill(readFileSync(join(import.meta.dirname, '../samples/skills/wip-download/SKILL.md'), 'utf8'));

/** 조회까지 마친 화면에서 내려받기 한 단계만 하는 스킬 */
const oneStep = (button: string, domain = 'localhost:4173') =>
  parseSkill(`---
id: t
name: 시험
description: 내려받기 시험용
version: 0.1.0
owner: 시험
risk: R1
domains: [${JSON.stringify(domain)}]
---

## 단계

1. download_table로 파일을 받는다. args는 다음을 그대로 쓴다.
   \`{"ref": "${button}", "dataset": "d"}\`
   - 검사: dataset("d")
2. finish로 보고한다. args는 다음을 그대로 쓴다.
   \`{"summary": "{rows.d}행"}\`

## 예외

- 오류가 나오면 abort한다.
`);

/** 재공 조회 화면에서 라인을 고르고 조회까지 해 둔다. */
async function queried(line: string) {
  const browser = await JsdomBrowser.open('/wip.html');
  const find = async (name: string) => {
    const el = (await browser.snapshot()).items.find((i) => i.kind === 'el' && i.name === name);
    return (el as { ref: number }).ref;
  };
  await browser.select(await find('라인'), line);
  await browser.click(await find('조회'));
  await browser.waitFor('총', 3000);
  return browser;
}

describe('화면의 내려받기 버튼으로 받은 파일 읽기', () => {
  it('엑셀 다운로드로 전체 결과를 한 번에 받아 모델 없이 끝까지 수행한다', async () => {
    const files = memoryFiles();
    const browser = new JsdomBrowser();
    const result = await runSkill(downloadSkill(), { line: '7라인', hold_hours: 24 }, { llm: noLlm, browser, ui, files, direct: true });

    expect(result.status, result.message).toBe('done');
    const want = generateWip('7라인');
    expect(result.message).toContain(`총 재공 ${want.length} Lot`);
    const book = await readWorkbook(files.saved.get('재공내려받기_7라인.xlsx')!);
    expect(book['원본'].slice(1)).toEqual(want.map((r) => [r[0], r[1], r[2], num(r[3]), r[4], Number(r[5])]));
    const hold = want.filter((r) => Number(r[5]) >= 24 || r[4] === 'HOLD').map((r) => r[0]);
    expect(book['정체Lot'].slice(1).map((r) => r[0]).sort()).toEqual(hold.sort());
    // 페이지를 넘기지 않았다.
    expect(browser.document.getElementById('pageinfo')!.textContent).toBe('1 / 3 페이지');
  }, 30_000);

  it('화면이 직접 만든 CSV는 주소가 지워진 뒤에도 내용을 읽는다', async () => {
    const datasets = new DatasetStore();
    const browser = await queried('6라인');
    const result = await runSkill(oneStep('CSV 내려받기'), {}, { llm: noLlm, browser, ui, files: memoryFiles(), datasets, direct: true });

    expect(result.status, result.message).toBe('done');
    expect(datasets.get('d').columns).toEqual(['Lot ID', '제품', '공정', '수량', '상태', '정체시간']);
    expect(datasets.get('d').rows).toEqual(generateWip('6라인'));
  });

  it('저장·상신 계열 버튼은 내려받기 버튼으로 쓸 수 없다', async () => {
    const browser = await queried('6라인');
    const llm = scriptedLlm([{ tool: 'abort', args: { reason: '그만' } }]);
    const result = await runSkill(oneStep('조건 저장'), {}, { llm, browser, ui, files: memoryFiles(), direct: true });

    expect(result.status).toBe('aborted');
    expect(browser.document.getElementById('msg')!.textContent).toBe('');
  });

  it('내려받기가 시작되지 않으면 실패로 알린다', async () => {
    const browser = await queried('6라인');
    const events: string[] = [];
    const llm = scriptedLlm([{ tool: 'abort', args: { reason: '그만' } }]);
    await runSkill(oneStep('조회'), {}, {
      llm,
      browser,
      ui,
      files: memoryFiles(),
      direct: true,
      onEvent: (e) => e.type === 'action' && events.push(`${e.entry.tool}:${e.entry.ok}:${e.entry.result}`),
    });
    expect(events[0]).toMatch(/^download_table:false:.*내려받기가 시작되지 않았습니다/);
  });

  it('파일의 주소가 스킬의 허용 도메인 안인지 본다', async () => {
    let allowed!: (url: string) => boolean;
    class Probe extends JsdomBrowser {
      override async download(ref: number, timeoutMs: number, check: (url: string) => boolean) {
        allowed = check;
        return super.download(ref, timeoutMs, check);
      }
    }
    const browser = new Probe((await queried('6라인')).dom);
    await browser.snapshot();
    await runSkill(oneStep('엑셀 다운로드'), {}, { llm: noLlm, browser, ui, files: memoryFiles(), direct: true });

    expect(allowed('http://localhost:4173/api/wip.xlsx')).toBe(true);
    expect(allowed('blob:http://localhost:4173/1f0c')).toBe(true);
    expect(allowed('data:text/csv,a')).toBe(true);
    expect(allowed('http://files.example/wip.xlsx')).toBe(false);
    expect(allowed('blob:http://files.example/1f0c')).toBe(false);
  });
});

describe('녹화한 내려받기 버튼 클릭', () => {
  const record = (button: string) => {
    let steps: AuthorStep[] = [];
    steps = addRecorded(steps, { kind: 'select', name: '라인', value: '7라인', options: ['선택', '6라인', '7라인', '8라인'], dup: false });
    steps = addRecorded(steps, { kind: 'click', role: 'button', name: '조회', dup: false });
    steps[1] = { ...steps[1], expect: '총' } as AuthorStep;
    steps = addRecorded(steps, { kind: 'click', role: 'button', name: button, dup: false });
    return draftSkill(
      { id: 'wip-recorded', name: '재공 받기(녹화)', description: '녹화로 만든 재공 내려받기', owner: '생산관리' },
      { url: 'http://localhost:4173/wip.html', heading: '재공 현황 조회' },
      steps,
    );
  };

  it('초안에서 download_table 단계가 되고, 받은 파일이 엑셀로 저장된다', async () => {
    const { source, notes } = record('엑셀 다운로드');
    expect(source).toContain('download_table로 "엑셀 다운로드"');
    expect(notes.join('\n')).toContain('파일 내려받기로 보고');
    const report = lintSkill(source);
    expect(report.findings).toEqual([]);

    const files = memoryFiles();
    const result = await runSkill(report.skill!, { v1: '8라인' }, { llm: noLlm, browser: new JsdomBrowser(), ui, files, direct: true });
    expect(result.status, result.message).toBe('done');
    const book = await readWorkbook(files.saved.get('재공 받기(녹화).xlsx')!);
    expect(book['표1']).toHaveLength(generateWip('8라인').length + 1);
  });

  it('엑셀이라는 글자만 있는 버튼이나 저장·상신 버튼은 그냥 클릭으로 둔다', () => {
    expect(record('엑셀 업로드').source).not.toContain('download_table');
    expect(record('엑셀 등록').source).not.toContain('download_table');
    expect(record('CSV 내려받기').source).toContain('download_table');
    expect(record('엑셀 저장').source).toContain('download_table');
  });
});

describe('내려받은 파일의 형식 판별', () => {
  it('확장자가 아니라 내용으로 xlsx와 csv를 구분한다', async () => {
    const xlsx = await readDownloadedTable(new Uint8Array(await wipXlsx('6라인')).slice().buffer);
    expect(xlsx.rows).toHaveLength(generateWip('6라인').length);
    expect(typeof xlsx.rows[0][3]).toBe('number');

    const csv = await readDownloadedTable(bytes('﻿Lot,수량\r\nA,"1,200"\r\n'));
    expect(csv).toEqual({ columns: ['Lot', '수량'], rows: [['A', '1,200']] });
  });

  it('EUC-KR로 저장된 CSV를 읽는다', async () => {
    // "라인,수량" 의 EUC-KR 바이트
    const table = await readDownloadedTable(bytes([0xb6, 0xf3, 0xc0, 0xce], ',', [0xbc, 0xf6, 0xb7, 0xae], '\n7,10\n'));
    expect(table).toEqual({ columns: ['라인', '수량'], rows: [['7', '10']] });
  });

  it('로그인 화면 같은 웹 문서나 구형 xls는 이유를 알려주고 거부한다', async () => {
    await expect(readDownloadedTable(bytes('<!doctype html><title>로그인</title>'))).rejects.toThrow(/웹 문서/);
    await expect(readDownloadedTable(bytes([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]))).rejects.toThrow(/xls/);
  });
});

describe('품질 검사: download_table', () => {
  const skill = (button: string) => `---
id: t
name: 시험
description: 검사 규칙 시험용
version: 0.1.0
owner: 시험
risk: R1
domains: [localhost:4173]
---

## 단계

1. download_table로 받는다.
   \`{"ref": "${button}", "dataset": "d"}\`
   - 검사: dataset("d")
2. write_excel로 저장한다.
   \`{"filename": "a", "sheets": [{"name": "s", "dataset": "d"}]}\`
   - 검사: did("write_excel")
3. finish로 보고한다.
   \`{"summary": "{rows.d}행"}\`

## 예외

- 오류가 나오면 abort한다.
`;
  const rules = (button: string) => lintSkill(skill(button)).findings.map((f) => `${f.rule}@${f.step ?? 0}`);

  it('받은 파일은 뒤 단계에서 데이터셋으로 쓸 수 있다', () => {
    expect(rules('엑셀 다운로드')).toEqual([]);
    expect(lintSkill(skill('엑셀 다운로드')).direct).toEqual({ count: 3, total: 3 });
  });

  it('"엑셀 저장"은 내려받기로 보고, 그 밖의 저장·상신 계열 버튼은 오류로 잡는다', () => {
    expect(rules('엑셀 저장')).toEqual([]);
    expect(rules('Excel Save')).toEqual([]);
    expect(rules('저장')).toEqual(['E04@1']);
    expect(rules('엑셀 등록')).toEqual(['E04@1']);
    expect(rules('엑셀 저장 후 상신')).toEqual(['E04@1']);
  });
});
