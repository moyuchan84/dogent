import { useState, type ReactNode } from 'react';
import { inlineText, looksLikeMarkdown, parseMarkdown, type Block, type Inline } from '../core/markdown';

// 보고 글(마크다운)을 그린다. 데스크탑 앱과 사이드 패널이 같이 쓴다.
// HTML을 넣지 않고 React 요소로만 그려서, 화면에서 읽은 글에 태그가 섞여 있어도 글자로 보인다.

function inline(nodes: Inline[]): ReactNode[] {
  return nodes.map((n, i) => {
    if (n.type === 'text') return n.text;
    if (n.type === 'code') return <code key={i}>{n.text}</code>;
    if (n.type === 'strong') return <strong key={i}>{inline(n.children)}</strong>;
    if (n.type === 'em') return <em key={i}>{inline(n.children)}</em>;
    return (
      <a key={i} href={n.href} target="_blank" rel="noreferrer noopener">
        {inline(n.children)}
      </a>
    );
  });
}

/** 표를 탭으로 나눈 글로 (엑셀에 붙여 넣으면 칸이 나뉜다) */
function tableTsv(b: Extract<Block, { type: 'table' }>): string {
  return [b.head, ...b.rows].map((r) => r.map((c) => inlineText(c).replace(/[\t\n]/g, ' ')).join('\t')).join('\n');
}

function CopyButton({ text, label = '복사' }: { text: string; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      className="md-copy"
      onClick={() => {
        void navigator.clipboard?.writeText(text).then(() => {
          setDone(true);
          setTimeout(() => setDone(false), 1500);
        });
      }}
    >
      {done ? '복사함' : label}
    </button>
  );
}

function blocks(list: Block[]): ReactNode[] {
  return list.map((b, i) => {
    switch (b.type) {
      case 'heading': {
        const H = `h${Math.min(6, b.level + 2)}` as 'h3';
        return <H key={i}>{inline(b.children)}</H>;
      }
      case 'paragraph':
        return (
          <p key={i}>
            {b.lines.map((l, k) => (
              <span key={k}>
                {k > 0 && <br />}
                {inline(l)}
              </span>
            ))}
          </p>
        );
      case 'hr':
        return <hr key={i} />;
      case 'code':
        return (
          <pre key={i}>
            <code>{b.text}</code>
          </pre>
        );
      case 'quote':
        return <blockquote key={i}>{blocks(b.children)}</blockquote>;
      case 'list': {
        const items = b.items.map((it, k) => (
          <li key={k} className={it.checked !== undefined ? 'task' : undefined}>
            {it.checked !== undefined && <input type="checkbox" checked={it.checked} readOnly disabled />}
            {inline(it.children)}
            {it.sub && blocks(it.sub)}
          </li>
        ));
        return b.ordered ? (
          <ol key={i} start={b.start}>
            {items}
          </ol>
        ) : (
          <ul key={i}>{items}</ul>
        );
      }
      case 'table':
        return (
          <div key={i} className="md-table">
            <div className="md-table-scroll">
              <table>
                <thead>
                  <tr>
                    {b.head.map((c, k) => (
                      <th key={k} style={b.align[k] ? { textAlign: b.align[k]! } : undefined}>
                        {inline(c)}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {b.rows.map((r, k) => (
                    <tr key={k}>
                      {r.map((c, j) => (
                        <td key={j} style={b.align[j] ? { textAlign: b.align[j]! } : undefined}>
                          {inline(c)}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <CopyButton text={tableTsv(b)} label="표 복사" />
          </div>
        );
    }
  });
}

/** 마크다운 보고. copy면 오른쪽 위에 원문 복사 단추를 둔다 */
export function Markdown({ text, copy = false, className = '' }: { text: string; copy?: boolean; className?: string }) {
  if (!looksLikeMarkdown(text)) {
    return (
      <div className={`md plain ${className}`}>
        <p style={{ whiteSpace: 'pre-wrap' }}>{text}</p>
      </div>
    );
  }
  return (
    <div className={`md ${className}`}>
      {copy && <CopyButton text={text} />}
      {blocks(parseMarkdown(text))}
    </div>
  );
}

/** 마크다운 모양. 색은 각 화면이 --md-* 변수로 바꿀 수 있다 */
const MARKDOWN_CSS = `
.md { position: relative; line-height: 1.6; overflow-wrap: anywhere; }
.md > :first-child { margin-top: 0; }
.md > :last-child { margin-bottom: 0; }
.md p { margin: 0.4em 0; }
.md h3, .md h4, .md h5, .md h6 { margin: 0.9em 0 0.35em; line-height: 1.35; }
.md h3 { font-size: 1.12em; }
.md h4 { font-size: 1.02em; }
.md h5, .md h6 { font-size: 0.95em; }
.md ul, .md ol { margin: 0.35em 0; padding-left: 1.4em; }
.md li { margin: 0.15em 0; }
.md li.task { list-style: none; margin-left: -1.3em; }
.md li.task input { margin: 0 0.4em 0 0; vertical-align: -1px; }
.md li > ul, .md li > ol, .md li > p { margin: 0.15em 0; }
.md strong { font-weight: 650; }
.md code { font-family: ui-monospace, Consolas, monospace; font-size: 0.9em; padding: 0.1em 0.35em; border-radius: 4px; background: var(--md-code-bg, rgba(127,127,127,0.14)); }
.md pre { margin: 0.5em 0; padding: 0.6em 0.8em; border-radius: 6px; overflow-x: auto; background: var(--md-code-bg, rgba(127,127,127,0.14)); }
.md pre code { padding: 0; background: none; }
.md blockquote { margin: 0.5em 0; padding: 0.1em 0.8em; border-left: 3px solid var(--md-line, rgba(127,127,127,0.35)); opacity: 0.85; }
.md hr { border: 0; border-top: 1px solid var(--md-line, rgba(127,127,127,0.3)); margin: 0.8em 0; }
.md a { color: var(--md-link, #2563eb); }
.md-table { margin: 0.6em 0; }
.md-table-scroll { overflow-x: auto; border: 1px solid var(--md-line, rgba(127,127,127,0.3)); border-radius: 6px; }
.md table { border-collapse: collapse; width: 100%; font-size: 0.92em; }
.md th, .md td { padding: 0.35em 0.65em; border-bottom: 1px solid var(--md-line, rgba(127,127,127,0.22)); text-align: left; white-space: nowrap; }
.md td { white-space: normal; min-width: 4em; }
.md th { font-weight: 600; background: var(--md-head-bg, rgba(127,127,127,0.1)); }
.md tbody tr:last-child td { border-bottom: 0; }
.md tbody tr:nth-child(even) td { background: var(--md-stripe, rgba(127,127,127,0.05)); }
.md-copy { font-size: 0.78em; padding: 0.15em 0.6em; border-radius: 4px; border: 1px solid var(--md-line, rgba(127,127,127,0.3)); background: transparent; color: inherit; opacity: 0.7; cursor: pointer; }
.md-copy:hover { opacity: 1; }
.md > .md-copy { float: right; margin: 0 0 0.3em 0.6em; }
.md-table > .md-copy { margin-top: 0.3em; }
`;

// 처음 불러올 때 한 번만 문서에 넣는다
if (typeof document !== 'undefined' && !document.getElementById('dogent-md-css')) {
  const style = document.createElement('style');
  style.id = 'dogent-md-css';
  style.textContent = MARKDOWN_CSS;
  document.head.append(style);
}
