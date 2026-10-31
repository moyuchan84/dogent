/**
 * 보고에 쓰는 마크다운의 작은 부분집합: 제목, 문단, 목록(번호·글머리, 들여쓰기), 표(GFM), 인용, 코드 블록, 가로줄,
 * 그리고 글 안의 굵게·기울임·코드·링크. HTML은 해석하지 않는다 (모델이나 화면 글이 끼워 넣은 태그가 그대로 글자로 보인다).
 * 데스크탑 앱·사이드 패널은 이 구조를 React로, 터미널은 markdownToTerminal로 그린다.
 */

export type Inline =
  | { type: 'text'; text: string }
  | { type: 'strong'; children: Inline[] }
  | { type: 'em'; children: Inline[] }
  | { type: 'code'; text: string }
  | { type: 'link'; href: string; children: Inline[] };

export type Align = 'left' | 'center' | 'right' | null;

export type ListItem = { children: Inline[]; checked?: boolean; sub?: Block[] };

export type Block =
  | { type: 'heading'; level: number; children: Inline[] }
  | { type: 'paragraph'; lines: Inline[][] }
  | { type: 'list'; ordered: boolean; start: number; items: ListItem[] }
  | { type: 'table'; head: Inline[][]; align: Align[]; rows: Inline[][][] }
  | { type: 'quote'; children: Block[] }
  | { type: 'code'; lang: string; text: string }
  | { type: 'hr' };

const HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/;
const FENCE = /^\s*(`{3,}|~{3,})\s*([\w+-]*)\s*$/;
const HR = /^\s*([-*_])(\s*\1){2,}\s*$/;
const LIST = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/;
const QUOTE = /^\s*>\s?(.*)$/;
const TABLE_SEP = /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$/;

/** 표의 한 줄을 칸으로 나눈다. \| 는 칸 구분이 아니다 */
function cells(line: string): string[] {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1);
  const out: string[] = [];
  let cur = '';
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\\' && s[i + 1] === '|') {
      cur += '|';
      i++;
    } else if (s[i] === '|') {
      out.push(cur.trim());
      cur = '';
    } else cur += s[i];
  }
  out.push(cur.trim());
  return out;
}

function isTableStart(lines: string[], i: number): boolean {
  return lines[i].includes('|') && i + 1 < lines.length && TABLE_SEP.test(lines[i + 1]) && lines[i + 1].includes('-');
}

function blockStarts(lines: string[], i: number): boolean {
  const l = lines[i];
  return HEADING.test(l) || FENCE.test(l) || HR.test(l) || LIST.test(l) || QUOTE.test(l) || isTableStart(lines, i);
}

export function parseMarkdown(src: string): Block[] {
  return parseLines(src.replace(/\r\n?/g, '\n').split('\n'));
}

function parseLines(lines: string[]): Block[] {
  const blocks: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      i++;
      continue;
    }
    const fence = FENCE.exec(line);
    if (fence) {
      const body: string[] = [];
      i++;
      while (i < lines.length && !(lines[i].trim().startsWith(fence[1][0].repeat(fence[1].length)) && FENCE.test(lines[i]))) body.push(lines[i++]);
      i++;
      blocks.push({ type: 'code', lang: fence[2], text: body.join('\n') });
      continue;
    }
    const h = HEADING.exec(line);
    if (h) {
      blocks.push({ type: 'heading', level: h[1].length, children: parseInline(h[2]) });
      i++;
      continue;
    }
    if (HR.test(line)) {
      blocks.push({ type: 'hr' });
      i++;
      continue;
    }
    if (isTableStart(lines, i)) {
      const head = cells(line);
      const align: Align[] = cells(lines[i + 1]).map((c) => (c.startsWith(':') && c.endsWith(':') ? 'center' : c.endsWith(':') ? 'right' : c.startsWith(':') ? 'left' : null));
      i += 2;
      const rows: Inline[][][] = [];
      while (i < lines.length && lines[i].trim() && lines[i].includes('|')) {
        const r = cells(lines[i++]);
        rows.push(head.map((_, c) => parseInline(r[c] ?? '')));
      }
      blocks.push({ type: 'table', head: head.map(parseInline), align: head.map((_, c) => align[c] ?? null), rows });
      continue;
    }
    if (QUOTE.test(line)) {
      const body: string[] = [];
      while (i < lines.length && QUOTE.test(lines[i])) body.push(QUOTE.exec(lines[i++])![1]);
      blocks.push({ type: 'quote', children: parseLines(body) });
      continue;
    }
    const li = LIST.exec(line);
    if (li) {
      const [list, next] = parseList(lines, i);
      blocks.push(list);
      i = next;
      continue;
    }
    // 문단: 빈 줄이나 다른 블록이 나올 때까지. 줄바꿈은 살린다 (보고 글은 줄 단위로 쓴 것이 많다)
    const para: Inline[][] = [];
    while (i < lines.length && lines[i].trim() && !(para.length > 0 && blockStarts(lines, i))) para.push(parseInline(lines[i++].trim()));
    blocks.push({ type: 'paragraph', lines: para });
  }
  return blocks;
}

const indentOf = (s: string) => s.replace(/\t/g, '    ').match(/^ */)![0].length;

function parseList(lines: string[], start: number): [Block, number] {
  const first = LIST.exec(lines[start])!;
  const base = indentOf(first[1]);
  const ordered = /\d/.test(first[2]);
  const items: ListItem[] = [];
  let i = start;
  while (i < lines.length) {
    const m = LIST.exec(lines[i]);
    if (!m || indentOf(m[1]) !== base || /\d/.test(m[2]) !== ordered) break;
    let text = m[3];
    let checked: boolean | undefined;
    const task = /^\[([ xX])\]\s+(.*)$/.exec(text);
    if (task) {
      checked = task[1] !== ' ';
      text = task[2];
    }
    i++;
    // 이어지는 줄(들여쓴 글)과 하위 목록
    const sub: string[] = [];
    while (i < lines.length && lines[i].trim()) {
      const n = LIST.exec(lines[i]);
      if (n && indentOf(n[1]) <= base) break;
      if (!n && indentOf(lines[i]) <= base && blockStarts(lines, i)) break;
      if (!n && sub.length === 0 && indentOf(lines[i]) <= base) {
        text += ` ${lines[i].trim()}`;
        i++;
        continue;
      }
      sub.push(lines[i].slice(Math.min(indentOf(lines[i]), base + 2)));
      i++;
    }
    // 항목 사이 빈 줄 하나는 같은 목록으로 본다
    if (i + 1 < lines.length && !lines[i]?.trim() && LIST.exec(lines[i + 1]) && indentOf(LIST.exec(lines[i + 1])![1]) === base) i++;
    items.push({ children: parseInline(text), ...(checked !== undefined ? { checked } : {}), ...(sub.length ? { sub: parseLines(sub) } : {}) });
  }
  return [{ type: 'list', ordered, start: ordered ? Number.parseInt(first[2], 10) : 1, items }, i];
}

/** 링크는 http·https·mailto만 링크로 만든다. 그 밖(javascript: 등)은 글자로 남긴다 */
export function safeHref(href: string): string | null {
  const h = href.trim();
  return /^(https?:\/\/|mailto:)/i.test(h) ? h : null;
}

export function parseInline(src: string): Inline[] {
  const out: Inline[] = [];
  let text = '';
  const flush = () => {
    if (text) out.push({ type: 'text', text });
    text = '';
  };
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === '\\' && i + 1 < src.length && /[\\`*_[\]()#|~>-]/.test(src[i + 1])) {
      text += src[i + 1];
      i += 2;
      continue;
    }
    if (c === '`') {
      const end = src.indexOf('`', i + 1);
      if (end > i) {
        flush();
        out.push({ type: 'code', text: src.slice(i + 1, end) });
        i = end + 1;
        continue;
      }
    }
    if ((c === '*' || c === '_') && src[i + 1] === c) {
      const end = src.indexOf(c + c, i + 2);
      if (end > i + 2) {
        flush();
        out.push({ type: 'strong', children: parseInline(src.slice(i + 2, end)) });
        i = end + 2;
        continue;
      }
    }
    // 기울임: 낱말 안의 _ (예: snake_case)는 건드리지 않는다
    if ((c === '*' || (c === '_' && !/\w/.test(src[i - 1] ?? ''))) && src[i + 1] && src[i + 1] !== ' ' && src[i + 1] !== c) {
      const end = src.indexOf(c, i + 1);
      if (end > i + 1 && src[end - 1] !== ' ' && !(c === '_' && /\w/.test(src[end + 1] ?? ''))) {
        flush();
        out.push({ type: 'em', children: parseInline(src.slice(i + 1, end)) });
        i = end + 1;
        continue;
      }
    }
    if (c === '[') {
      const m = /^\[([^\]]+)\]\(([^)\s]+)\)/.exec(src.slice(i));
      const href = m && safeHref(m[2]);
      if (m && href) {
        flush();
        out.push({ type: 'link', href, children: parseInline(m[1]) });
        i += m[0].length;
        continue;
      }
    }
    if (c === 'h' && /^https?:\/\//.test(src.slice(i)) && !/\w/.test(src[i - 1] ?? '')) {
      const m = /^https?:\/\/[^\s<>()]+[^\s<>().,;:!?'"]/.exec(src.slice(i));
      if (m) {
        flush();
        out.push({ type: 'link', href: m[0], children: [{ type: 'text', text: m[0] }] });
        i += m[0].length;
        continue;
      }
    }
    text += c;
    i++;
  }
  flush();
  return out;
}

export function inlineText(nodes: Inline[]): string {
  return nodes.map((n) => (n.type === 'text' || n.type === 'code' ? n.text : inlineText(n.children))).join('');
}

/** 마크다운 문법이 들어 있는지 (없으면 평범한 글로 그려도 된다) */
export function looksLikeMarkdown(src: string): boolean {
  return /(^|\n)\s*(#{1,6}\s|[-*+]\s|\d+[.)]\s|>\s|```|\|.*\|)|\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\(https?:/.test(src);
}

// ---- 표를 마크다운으로 ----

/** 칸 안의 글을 표 한 칸에 맞게: 줄바꿈은 공백, | 는 \| */
function cellMd(v: unknown): string {
  const s = v === null || v === undefined ? '' : v instanceof Date ? v.toISOString().slice(0, 10) : String(v);
  return s.replace(/\r?\n/g, ' ').replace(/\|/g, '\\|').trim();
}

/**
 * 데이터셋을 마크다운 표로. 행이 많으면 앞의 maxRows행만 넣고 몇 행이 더 있는지 적는다.
 * 숫자 칸은 오른쪽 정렬한다.
 */
export function tableMarkdown(columns: string[], rows: unknown[][], maxRows = 20): string {
  if (columns.length === 0) return '(빈 표)';
  const shown = rows.slice(0, maxRows);
  const numeric = columns.map((_, c) => shown.length > 0 && shown.every((r) => r[c] === null || r[c] === undefined || r[c] === '' || typeof r[c] === 'number' || /^-?[\d,]+(\.\d+)?%?$/.test(String(r[c]).trim())));
  const lines = [
    `| ${columns.map(cellMd).join(' | ')} |`,
    `| ${columns.map((_, c) => (numeric[c] ? '---:' : '---')).join(' | ')} |`,
    ...shown.map((r) => `| ${columns.map((_, c) => cellMd(r[c])).join(' | ')} |`),
  ];
  if (rows.length === 0) lines.push(`| ${columns.map((_, c) => (c === 0 ? '(행 없음)' : '')).join(' | ')} |`);
  const more = rows.length > shown.length ? `\n\n전체 ${rows.length}행 중 앞의 ${shown.length}행` : '';
  return lines.join('\n') + more;
}

// ---- 터미널 ----

/** 터미널에서 차지하는 칸 수. 한글·한자·전각 문자는 두 칸 */
export function displayWidth(s: string): number {
  let w = 0;
  for (const ch of s) {
    const cp = ch.codePointAt(0)!;
    if (cp < 0x20 || (cp >= 0x300 && cp < 0x370) || cp === 0x200b) continue;
    w +=
      (cp >= 0x1100 && cp <= 0x115f) ||
      (cp >= 0x2e80 && cp <= 0xa4cf) ||
      (cp >= 0xac00 && cp <= 0xd7a3) ||
      (cp >= 0xf900 && cp <= 0xfaff) ||
      (cp >= 0xfe30 && cp <= 0xfe4f) ||
      (cp >= 0xff00 && cp <= 0xff60) ||
      (cp >= 0xffe0 && cp <= 0xffe6) ||
      (cp >= 0x1f300 && cp <= 0x1faff) ||
      (cp >= 0x20000 && cp <= 0x3fffd)
        ? 2
        : 1;
  }
  return w;
}

function pad(s: string, width: number, align: Align): string {
  const gap = Math.max(0, width - displayWidth(s));
  if (align === 'right') return ' '.repeat(gap) + s;
  if (align === 'center') return ' '.repeat(Math.floor(gap / 2)) + s + ' '.repeat(Math.ceil(gap / 2));
  return s + ' '.repeat(gap);
}

/** 넓으면 자른다 (끝에 …) */
function clip(s: string, width: number): string {
  if (displayWidth(s) <= width) return s;
  let out = '';
  for (const ch of s) {
    if (displayWidth(out + ch) > width - 1) break;
    out += ch;
  }
  return `${out}…`;
}

export type TerminalStyle = { bold: (s: string) => string; dim: (s: string) => string; code: (s: string) => string };
const PLAIN: TerminalStyle = { bold: (s) => s, dim: (s) => s, code: (s) => s };
export const ANSI: TerminalStyle = { bold: (s) => `\x1b[1m${s}\x1b[22m`, dim: (s) => `\x1b[2m${s}\x1b[22m`, code: (s) => `\x1b[36m${s}\x1b[39m` };

function inlineTerm(nodes: Inline[], st: TerminalStyle): string {
  return nodes
    .map((n) => {
      if (n.type === 'text') return n.text;
      if (n.type === 'code') return st.code(n.text);
      if (n.type === 'strong') return st.bold(inlineTerm(n.children, st));
      if (n.type === 'em') return inlineTerm(n.children, st);
      const label = inlineText(n.children);
      return label === n.href ? n.href : `${inlineTerm(n.children, st)} (${n.href})`;
    })
    .join('');
}

/**
 * 마크다운을 터미널 글로: 표는 칸을 맞춘 상자로, 제목은 굵게, 목록은 들여쓴 글머리로.
 * width는 표가 넘지 않을 너비(칸이 넓으면 자른다).
 */
export function markdownToTerminal(src: string, opts: { width?: number; style?: TerminalStyle } = {}): string {
  const st = opts.style ?? PLAIN;
  const width = opts.width ?? 100;
  const out: string[] = [];
  const render = (blocks: Block[], indent: string) => {
    for (const b of blocks) {
      if (b.type === 'heading') out.push(indent + st.bold(inlineTerm(b.children, st)));
      else if (b.type === 'paragraph') for (const l of b.lines) out.push(indent + inlineTerm(l, st));
      else if (b.type === 'hr') out.push(indent + st.dim('─'.repeat(Math.min(40, width))));
      else if (b.type === 'code') for (const l of b.text.split('\n')) out.push(`${indent}  ${st.code(l)}`);
      else if (b.type === 'quote') {
        const start = out.length;
        render(b.children, '');
        for (let k = start; k < out.length; k++) out[k] = `${indent}${st.dim('│')} ${out[k]}`;
      } else if (b.type === 'list') {
        b.items.forEach((it, k) => {
          const mark = it.checked !== undefined ? (it.checked ? '[x]' : '[ ]') : b.ordered ? `${b.start + k}.` : '•';
          out.push(`${indent}${mark} ${inlineTerm(it.children, st)}`);
          if (it.sub) render(it.sub, `${indent}${' '.repeat(displayWidth(mark) + 1)}`);
        });
      } else if (b.type === 'table') {
        const head = b.head.map((c) => inlineText(c));
        const rows = b.rows.map((r) => r.map((c) => inlineText(c)));
        let widths = head.map((h, c) => Math.max(displayWidth(h), ...rows.map((r) => displayWidth(r[c] ?? ''))));
        // 너무 넓으면 가장 넓은 칸부터 줄인다
        const total = () => widths.reduce((a, w) => a + w, 0) + widths.length * 3 + 1 + indent.length;
        while (total() > width && Math.max(...widths) > 6) {
          const k = widths.indexOf(Math.max(...widths));
          widths = widths.map((w, c) => (c === k ? w - 1 : w));
        }
        const line = (l: string, m: string, r: string) => indent + st.dim(l + widths.map((w) => '─'.repeat(w + 2)).join(m) + r);
        const row = (cells: string[], bold = false) =>
          indent + st.dim('│') + cells.map((c, k) => ` ${(bold ? st.bold : (s: string) => s)(pad(clip(c, widths[k]), widths[k], bold ? null : b.align[k]))} `).join(st.dim('│')) + st.dim('│');
        out.push(line('┌', '┬', '┐'), row(head, true), line('├', '┼', '┤'), ...rows.map((r) => row(head.map((_, c) => r[c] ?? ''))), line('└', '┴', '┘'));
      }
      if (indent === '' && b !== blocks[blocks.length - 1]) out.push('');
    }
  };
  render(parseMarkdown(src), '');
  return out.join('\n').replace(/\n{3,}/g, '\n\n');
}
