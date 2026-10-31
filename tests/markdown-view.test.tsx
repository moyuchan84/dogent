import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Markdown } from '../src/ui/Markdown';

describe('Markdown 보기', () => {
  it('표·목록·굵게를 요소로 그리고, 글 속 태그는 글자로 남긴다', () => {
    const html = renderToStaticMarkup(<Markdown text={'결론 **3건**\n\n- 하나 <b>x</b>\n\n| a | b |\n| --- | ---: |\n| 1 | 2 |'} copy />);
    expect(html).toContain('<strong>3건</strong>');
    expect(html).toContain('<ul><li>하나 &lt;b&gt;x&lt;/b&gt;</li></ul>');
    expect(html).toContain('<th>a</th><th style="text-align:right">b</th>');
    expect(html).toContain('표 복사');
  });

  it('마크다운이 아닌 글은 줄바꿈을 살린 문단 하나로', () => {
    const html = renderToStaticMarkup(<Markdown text={'첫 줄\n둘째 줄'} />);
    expect(html).toBe('<div class="md plain "><p style="white-space:pre-wrap">첫 줄\n둘째 줄</p></div>');
  });
});
