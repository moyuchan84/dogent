import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'vitest';
import { DatasetStore, buildFreeSkill, buildHtmlReport, lintSkill, markdownToHtml, noBrowser, runSkill, type RunEvent } from '../src/core';
import { memoryFiles, scriptedLlm } from './helpers';

const step = (tool: string, args: object = {}) => ({ tool, args });
const wip = { name: 'wip', columns: ['공정', '수량', '비고'], rows: [['DR5', '1,200', 'a'], ['ET2', 30, '<img src=x onerror=alert(1)>'], ['CMP', 450, 'b']] };

/** 보고서를 jsdom에서 열어 안의 스크립트까지 돌린다 */
function open(html: string) {
  return new JSDOM(html, { runScripts: 'dangerously' }).window;
}

describe('HTML 보고서', () => {
  it('마크다운 본문을 HTML로 바꾸고 글 속 태그는 글자로 둔다', () => {
    const html = markdownToHtml('## 요약\n\n결론 **3건** <script>x</script>\n\n- [링크](javascript:alert(1))\n- [사내](https://a.example.com)');
    expect(html).toContain('<h3>요약</h3>');
    expect(html).toContain('<strong>3건</strong> &lt;script&gt;x&lt;/script&gt;');
    expect(html).not.toContain('href="javascript');
    expect(html).toContain('<a href="https://a.example.com"');
  });

  it('표는 검색·정렬되고, 값에 든 태그와 </script>는 실행되지 않는다', () => {
    const html = buildHtmlReport({ title: '재공 <현황>', content: '결론', datasets: [{ ...wip, rows: [...wip.rows, ['X', 1, '</script><b>깨짐</b>']] }], charts: [] });
    expect(html).toContain('<title>재공 &lt;현황&gt;</title>');
    expect(html).not.toContain('</script><b>');
    const w = open(html);
    const doc = w.document;
    const cells = () => [...doc.querySelectorAll('table.data tbody tr')].map((tr) => tr.children[0].textContent);
    expect(cells()).toEqual(['DR5', 'ET2', 'CMP', 'X']);
    expect(doc.querySelector('img')).toBeNull();
    expect(doc.body.textContent).toContain('</script><b>깨짐</b>');
    // 수량 열은 숫자로 정렬한다 ("1,200"도 숫자)
    const th = doc.querySelectorAll('table.data th')[1] as HTMLElement;
    th.click();
    expect(cells()).toEqual(['X', 'ET2', 'CMP', 'DR5']);
    th.click();
    expect(cells()).toEqual(['DR5', 'CMP', 'ET2', 'X']);
    const search = doc.querySelector('input[type=search]') as HTMLInputElement;
    search.value = 'cm';
    search.dispatchEvent(new w.Event('input'));
    expect(cells()).toEqual(['CMP']);
    expect(doc.querySelector('.count')?.textContent).toBe('1 / 4행');
    expect(doc.querySelector('mark')?.textContent).toBe('CM');
  });

  it('차트를 데이터셋 값으로 그린다', () => {
    const html = buildHtmlReport({
      title: 't',
      content: '',
      datasets: [wip],
      charts: [
        { dataset: 'wip', type: 'bar', label: '공정', values: ['수량'] },
        { dataset: 'wip', type: 'line', label: '공정', values: ['수량'], title: '추이' },
      ],
    });
    const doc = open(html).document;
    const svgs = doc.querySelectorAll('#charts svg');
    expect(svgs).toHaveLength(2);
    expect(svgs[0].querySelectorAll('rect')).toHaveLength(3);
    expect(svgs[0].querySelector('rect title')?.textContent).toBe('DR5 · 수량: 1,200');
    expect(svgs[1].querySelectorAll('circle')).toHaveLength(3);
    expect(doc.querySelectorAll('#charts h2')[1].textContent).toBe('추이');
  });
});

describe('write_html 도구', () => {
  const run = (replies: object[]) => {
    const datasets = new DatasetStore();
    datasets.set(wip.name, wip.columns, wip.rows);
    const files = memoryFiles();
    const events: RunEvent[] = [];
    const done = runSkill(
      buildFreeSkill(null, false),
      { request: 'HTML로 인터랙티브하게 정리해줘' },
      { llm: scriptedLlm(replies), browser: noBrowser(), datasets, files, ui: { ask: async () => '', approve: async () => false }, onEvent: (e) => events.push(e) },
    );
    return done.then((result) => ({ result, files, events }));
  };

  it('데이터셋과 정리 글로 보고서 파일을 만든다', async () => {
    const { result, files } = await run([
      step('write_html', {
        filename: '재공 현황.html',
        title: '재공 현황',
        content: '재공 **{rows.wip}건**',
        datasets: ['wip'],
        charts: [{ dataset: 'wip', label: '공정', values: ['수량'] }],
      }),
      step('finish', { summary: '보고서를 만들었습니다' }),
    ]);
    expect(result.status, result.message).toBe('done');
    expect(result.files).toEqual(['재공 현황.html']);
    const html = new TextDecoder().decode(files.saved.get('재공 현황.html'));
    expect(html).toContain('재공 <strong>3건</strong>');
    expect(open(html).document.querySelectorAll('#charts rect')).toHaveLength(3);
  });

  it('없는 열을 차트에 쓰면 이유를 알려 주고 모델이 고친다', async () => {
    const { result, events } = await run([
      step('write_html', { filename: 'r', title: 'r', charts: [{ dataset: 'wip', label: '공정', values: ['재공'] }] }),
      step('write_html', { filename: 'r', title: 'r', charts: [{ dataset: 'wip', label: '공정', values: ['수량'] }] }),
      step('finish', { summary: '끝' }),
    ]);
    expect(result.files).toEqual(['r.html']);
    const failed = events.find((e) => e.type === 'action' && !e.entry.ok);
    expect(failed && failed.type === 'action' && failed.entry.result).toContain('"재공"이 "wip"에 없습니다');
  });

  it('스킬 검사는 보고서가 쓰는 데이터셋이 앞 단계에서 만들어졌는지 본다', () => {
    const source = `---
id: html-check
name: 보고서
description: 표를 HTML로
version: 0.1.0
owner: 나
risk: R1
domains: ["a.example.com"]
---

## 단계

1. write_html로 보고서를 만든다. args는 다음을 그대로 쓴다.
   \`{"filename":"r","title":"r","datasets":["없는것"]}\`
   - 검사: did("write_html")

## 결과

보고서 파일
`;
    expect(lintSkill(source).findings.some((f) => f.message.includes('없는것'))).toBe(true);
  });
});
