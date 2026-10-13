import type { ActResult, FrameSnapshot, RecordedEvent, SnapshotItem, TableData } from '../core/types';

/**
 * 페이지 안에서 도는 부분. 화면을 요소 목록으로 읽고, ref로 지정된 요소를 조작한다.
 * 프레임마다 하나씩 만들어지며 DOM API만 쓴다 (chrome.* 의존 없음).
 */
export interface PageAgent {
  snapshot(): FrameSnapshot;
  click(ref: number): ActResult;
  type(ref: number, text: string): ActResult;
  select(ref: number, value: string): ActResult;
  extractTable(ref: number): TableData;
  /**
   * 입력 칸이 있는 표의 빈 행에 값을 채운다. columns는 표의 머리글 이름, rows는 그 순서의 값.
   * 행이 모자라면 addRef(행 추가 버튼)를 눌러 늘린다.
   */
  fillTable(ref: number, columns: string[], rows: string[][], addRef?: number): ActResult;
  hasText(text: string): boolean;
  settle(quietMs?: number, maxMs?: number): Promise<void>;
  /** 곧 조작할 요소를 화면에 표시한다. 요소가 사라졌으면 false. */
  point(ref: number, label: string): boolean;
  /** 에이전트가 이 화면을 조작 중임을 테두리로 표시하거나 지운다. */
  setActive(on: boolean): void;
  /** 사람이 하는 클릭·입력·선택을 녹화해 onRecord로 알린다. 여러 번 켜도 한 번만 걸린다. */
  record(on: boolean): void;
}

const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'HEAD', 'SVG', 'IFRAME', 'FRAME']);
const INTERACTIVE_ROLES = new Set([
  'button',
  'link',
  'tab',
  'menuitem',
  'checkbox',
  'radio',
  'combobox',
  'textbox',
  'option',
  'switch',
]);
const TABLE_ROLES = new Set(['grid', 'table', 'treegrid']);
const MAX_ELEMENTS = 300;
const MAX_TEXTS = 150;
const MAX_OPTIONS = 40;

const norm = (s: string | null | undefined) => (s ?? '').replace(/\s+/g, ' ').trim();
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);

export function createPageAgent(
  win: Window & typeof globalThis,
  onRecord: (event: RecordedEvent) => void = () => {},
): PageAgent {
  const doc = win.document;
  let refs = new Map<number, Element>();

  function visible(el: Element): boolean {
    if (el.hasAttribute('hidden') || el.getAttribute('aria-hidden') === 'true') return false;
    const cs = win.getComputedStyle(el);
    return cs.display !== 'none' && cs.visibility !== 'hidden';
  }

  function labelOf(el: Element): string {
    const aria = norm(el.getAttribute('aria-label'));
    if (aria) return aria;
    const labelledBy = el.getAttribute('aria-labelledby');
    if (labelledBy) {
      const text = norm(
        labelledBy
          .split(/\s+/)
          .map((id) => doc.getElementById(id)?.textContent ?? '')
          .join(' '),
      );
      if (text) return text;
    }
    // label이 입력 요소를 감싸고 있으면 그 요소의 글자(옵션 목록 등)는 이름에서 뺀다.
    const labelText = (label: Element) => {
      const clone = label.cloneNode(true) as Element;
      clone.querySelectorAll('input,select,textarea,button').forEach((c) => c.remove());
      return norm(clone.textContent);
    };
    const id = el.getAttribute('id');
    if (id) {
      const forLabel = [...doc.querySelectorAll('label')].find((l) => l.getAttribute('for') === id);
      if (forLabel) return labelText(forLabel);
    }
    const wrapping = el.closest('label');
    if (wrapping) return labelText(wrapping);
    return '';
  }

  function nameOf(el: Element, fallbackToText: boolean): string {
    return (
      labelOf(el) ||
      norm(el.getAttribute('placeholder')) ||
      (fallbackToText ? norm(el.textContent) : '') ||
      norm(el.getAttribute('title')) ||
      norm(el.getAttribute('value')) ||
      norm(el.getAttribute('name')) ||
      ''
    );
  }

  /** 표의 머리글 행과 본문 행을 찾는다. <table>과 role=grid 양쪽을 지원한다. */
  function tableParts(el: Element): { header: string[]; rows: Element[]; cellsOf: (r: Element) => Element[] } {
    if (el.tagName === 'TABLE') {
      const all = [...el.querySelectorAll('tr')].filter((r) => r.closest('table') === el);
      const headerRow =
        all.filter((r) => r.parentElement?.tagName === 'THEAD').pop() ??
        all.find((r) => r.querySelector('th') && !r.querySelector('td'));
      const cellsOf = (r: Element) => [...r.children].filter((c) => c.tagName === 'TD' || c.tagName === 'TH');
      const rows = all.filter(
        (r) => r !== headerRow && r.parentElement?.tagName !== 'THEAD' && r.parentElement?.tagName !== 'TFOOT',
      );
      return { header: headerRow ? cellsOf(headerRow).map((c) => norm(c.textContent)) : [], rows, cellsOf };
    }
    const all = [...el.querySelectorAll('[role=row]')];
    const headerRow = all.find((r) => r.querySelector('[role=columnheader]'));
    const cellsOf = (r: Element) => [...r.querySelectorAll('[role=gridcell],[role=cell],[role=columnheader]')];
    return {
      header: headerRow ? cellsOf(headerRow).map((c) => norm(c.textContent)) : [],
      rows: all.filter((r) => r !== headerRow),
      cellsOf,
    };
  }

  function describe(el: Element): Omit<Extract<SnapshotItem, { kind: 'el' }>, 'kind' | 'ref'> | null {
    const tag = el.tagName;
    const role = el.getAttribute('role') ?? '';
    const disabled = el.hasAttribute('disabled') || el.getAttribute('aria-disabled') === 'true' || undefined;

    if (tag === 'TABLE' || TABLE_ROLES.has(role)) {
      const { header, rows } = tableParts(el);
      if (tag === 'TABLE' && header.length === 0 && rows.length === 0) return null;
      const name =
        norm(el.querySelector('caption')?.textContent) || labelOf(el) || norm(el.getAttribute('id')) || '표';
      return {
        role: 'table',
        name,
        detail: `rows=${rows.length} cols=[${header.map((h) => clip(h, 30)).join(', ')}]`,
      };
    }
    if (tag === 'SELECT') {
      const sel = el as HTMLSelectElement;
      const options = [...sel.options].map((o) => norm(o.textContent));
      const shown = options.slice(0, MAX_OPTIONS).join(', ');
      return {
        role: 'combobox',
        name: nameOf(el, false),
        value: norm(sel.selectedOptions[0]?.textContent),
        detail: `options=[${shown}${options.length > MAX_OPTIONS ? ', …' : ''}]`,
        disabled,
      };
    }
    if (tag === 'TEXTAREA') {
      return { role: 'textbox', name: nameOf(el, false), value: (el as HTMLTextAreaElement).value, disabled };
    }
    if (tag === 'INPUT') {
      const input = el as HTMLInputElement;
      const type = (input.getAttribute('type') ?? 'text').toLowerCase();
      if (type === 'hidden' || type === 'password') return null;
      if (type === 'button' || type === 'submit' || type === 'reset' || type === 'image') {
        return { role: 'button', name: nameOf(el, false), disabled };
      }
      if (type === 'checkbox' || type === 'radio') {
        return { role: type, name: nameOf(el, false), value: input.checked ? '선택됨' : '선택 안 됨', disabled };
      }
      return { role: 'textbox', name: nameOf(el, false), value: input.value, disabled };
    }
    if (tag === 'BUTTON') return { role: 'button', name: clip(nameOf(el, true), 80), disabled };
    if (tag === 'A' && el.hasAttribute('href')) return { role: 'link', name: clip(nameOf(el, true), 80) };
    if (INTERACTIVE_ROLES.has(role)) return { role, name: clip(nameOf(el, true), 80), disabled };
    if (el.hasAttribute('onclick') || el.getAttribute('contenteditable') === 'true') {
      return { role: el.hasAttribute('onclick') ? 'button' : 'textbox', name: clip(nameOf(el, true), 80) };
    }
    return null;
  }

  function snapshot(): FrameSnapshot {
    refs = new Map();
    const items: SnapshotItem[] = [];
    let nextRef = 1;
    let elements = 0;
    let texts = 0;
    let truncated = false;
    let hasPassword = false;

    function walk(el: Element): void {
      if (SKIP_TAGS.has(el.tagName.toUpperCase()) || !visible(el)) return;
      if (el.tagName === 'INPUT' && (el.getAttribute('type') ?? '').toLowerCase() === 'password') {
        hasPassword = true;
        return;
      }
      const desc = describe(el);
      if (desc) {
        if (elements >= MAX_ELEMENTS) {
          truncated = true;
          return;
        }
        elements++;
        refs.set(nextRef, el);
        items.push({ kind: 'el', ref: nextRef++, ...desc });
        return;
      }
      if (/^H[1-4]$/.test(el.tagName)) {
        const text = norm(el.textContent);
        if (text) items.push({ kind: 'heading', text: clip(text, 120) });
        return;
      }
      // 입력란에 연결된 label은 요소 이름으로 이미 쓰였으므로 본문 텍스트에서는 뺀다.
      if (el.tagName === 'LABEL' && (el.hasAttribute('for') || el.querySelector('input,select,textarea'))) {
        for (const child of el.children) walk(child);
        return;
      }
      for (const node of el.childNodes) {
        if (node.nodeType === 1) walk(node as Element);
        else if (node.nodeType === 3) {
          const text = norm(node.textContent);
          if (!text) continue;
          if (texts >= MAX_TEXTS) truncated = true;
          else {
            texts++;
            items.push({ kind: 'text', text: clip(text, 150) });
          }
        }
      }
    }

    if (doc.body) walk(doc.body);
    return { url: win.location.href, title: doc.title, hasPassword, truncated, items };
  }

  function resolve(ref: number): Element {
    const el = refs.get(ref);
    if (!el || !el.isConnected) throw new Error(`ref ${ref} 요소가 화면에서 사라졌습니다`);
    return el;
  }

  function fire(el: Element, type: string): void {
    el.dispatchEvent(new win.Event(type, { bubbles: true }));
  }

  function act(fn: () => string): ActResult {
    try {
      return { ok: true, message: fn() };
    } catch (e) {
      return { ok: false, message: (e as Error).message };
    }
  }

  // ---- 입력 가능한 표 ----
  type Control = HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;

  /** 칸 안의 입력 요소. 숨김·체크박스·버튼류는 값 입력 대상이 아니다. */
  function controlOf(cell: Element): Control | null {
    for (const el of cell.querySelectorAll('input,select,textarea')) {
      const type = (el.getAttribute('type') ?? 'text').toLowerCase();
      if (el.tagName !== 'INPUT' || !['hidden', 'checkbox', 'radio', 'button', 'submit', 'reset', 'image'].includes(type)) {
        return el as Control;
      }
    }
    return null;
  }

  /** 칸의 현재 값. 입력 요소가 있으면 그 값을, 없으면 보이는 글자를 읽는다. */
  function cellValue(cell: Element): string {
    const control = controlOf(cell);
    if (!control) return norm(cell.textContent);
    if (control.tagName !== 'SELECT') return control.value;
    const sel = control as HTMLSelectElement;
    return sel.value === '' ? '' : norm(sel.selectedOptions[0]?.textContent);
  }

  const optionFor = (sel: HTMLSelectElement, value: string) => {
    const want = norm(value);
    return [...sel.options].find((o) => norm(o.textContent) === want || o.value === want);
  };

  /** 값을 쓰기 전에 그 칸에 들어갈 수 있는 값인지 본다. */
  function checkControl(control: Control, value: string, where: string): void {
    if (control.tagName === 'SELECT') {
      const sel = control as HTMLSelectElement;
      if (!optionFor(sel, value)) {
        const options = [...sel.options].map((o) => norm(o.textContent)).join(', ');
        throw new Error(`${where}: "${value}"은(는) 선택할 수 없는 값입니다. 가능한 값: ${options}`);
      }
    } else if ((control.getAttribute('type') ?? '').toLowerCase() === 'number') {
      if (value.trim() === '' || !Number.isFinite(Number(value))) {
        throw new Error(`${where}: "${value}"은(는) 숫자가 아닙니다`);
      }
    }
  }

  function setControl(control: Control, value: string, where: string): void {
    if (control.tagName === 'SELECT') {
      const sel = control as HTMLSelectElement;
      checkControl(control, value, where);
      sel.value = optionFor(sel, value)!.value;
    } else {
      // React 등은 value 속성 설정을 가로채므로 원래 setter를 직접 호출한다.
      const proto = control.tagName === 'INPUT' ? win.HTMLInputElement.prototype : win.HTMLTextAreaElement.prototype;
      Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(control, value);
      if (control.value !== value) throw new Error(`${where}: "${value}"을(를) 이 칸에 넣을 수 없습니다 (형식이 맞지 않음)`);
    }
    fire(control, 'input');
    fire(control, 'change');
  }

  // ---- 화면 표시 ----
  // 사용자가 에이전트의 동작을 눈으로 따라갈 수 있게, 조작할 요소에 테두리와 포인터를 그린다.
  // 닫힌 shadow root 안에 두어 페이지의 글자·스타일과 섞이지 않고, 스냅샷과 hasText에도 잡히지 않는다.
  const ACCENT = '#1a56c4';
  let overlay: { host: HTMLElement; frame: HTMLElement; box: HTMLElement; tag: HTMLElement } | null = null;

  function ensureOverlay() {
    if (overlay?.host.isConnected) return overlay;
    const make = (css: string, text = '') => {
      const el = doc.createElement('div');
      el.style.cssText = css;
      el.textContent = text;
      return el;
    };
    const host = make('position:fixed;inset:0;pointer-events:none;z-index:2147483647;');
    host.setAttribute('data-dogent-overlay', '');
    host.setAttribute('aria-hidden', 'true');
    const root = host.attachShadow({ mode: 'closed' });
    const font = 'font:600 12px/1.4 "Malgun Gothic",system-ui,sans-serif;color:#fff;';
    const frame = make(`display:none;position:fixed;inset:0;border:3px solid ${ACCENT};box-shadow:inset 0 0 18px ${ACCENT}66;`);
    frame.appendChild(
      make(`position:absolute;right:10px;bottom:10px;padding:4px 10px;border-radius:999px;background:${ACCENT};${font}`, 'Dogent가 조작 중'),
    );
    const box = make(
      `display:none;position:fixed;border:2px solid ${ACCENT};border-radius:6px;background:${ACCENT}1f;` +
        `box-shadow:0 0 0 4px ${ACCENT}33;transition:left .18s,top .18s,width .18s,height .18s;`,
    );
    const tag = make(`position:absolute;left:-2px;bottom:100%;margin-bottom:4px;padding:2px 8px;border-radius:4px;white-space:nowrap;background:${ACCENT};${font}`);
    // 마우스 포인터 모양. 요소 가운데를 가리킨다.
    const cursor = doc.createElementNS('http://www.w3.org/2000/svg', 'svg');
    cursor.setAttribute('viewBox', '0 0 24 24');
    cursor.style.cssText = 'position:absolute;left:50%;top:50%;width:22px;height:22px;filter:drop-shadow(0 1px 2px #0006);';
    const arrow = doc.createElementNS('http://www.w3.org/2000/svg', 'path');
    arrow.setAttribute('d', 'M3 2l7 18 2.5-7.5L20 10z');
    arrow.setAttribute('fill', ACCENT);
    arrow.setAttribute('stroke', '#fff');
    arrow.setAttribute('stroke-width', '1.5');
    cursor.appendChild(arrow);
    box.append(tag, cursor);
    root.append(frame, box);
    doc.documentElement.appendChild(host);
    overlay = { host, frame, box, tag };
    return overlay;
  }

  // ---- 조작 녹화 ----
  // 스킬 초안을 만들 때 쓴다. 요소는 스냅샷과 같은 이름으로 적어, 녹화한 그대로 실행할 수 있게 한다.
  let recording = false;
  let listening = false;
  const CLICK_ROLES = new Set(['button', 'link', 'tab', 'menuitem', 'checkbox', 'radio', 'switch']);

  /** 같은 이름의 요소가 화면에 몇 개인지. role을 주면 그 종류만 센다. */
  function sameName(name: string, role?: string): number {
    return snapshot().items.filter((i) => i.kind === 'el' && i.name === name && (!role || i.role === role)).length;
  }

  function onClick(e: Event): void {
    if (!recording) return;
    for (let el = e.target as Element | null; el; el = el.parentElement) {
      const desc = describe(el);
      if (!desc) continue;
      if (CLICK_ROLES.has(desc.role)) {
        onRecord({ kind: 'click', role: desc.role, name: desc.name, dup: sameName(desc.name) > 1 });
      }
      return;
    }
  }

  function onChange(e: Event): void {
    if (!recording) return;
    const el = e.target as Element | null;
    const desc = el && describe(el);
    // 비밀번호 칸은 describe가 null을 돌려주므로 녹화되지 않는다.
    if (!el || !desc) return;
    if (desc.role === 'combobox' && el.tagName === 'SELECT') {
      const sel = el as HTMLSelectElement;
      onRecord({
        kind: 'select',
        name: desc.name,
        value: norm(sel.selectedOptions[0]?.textContent),
        options: [...sel.options].slice(0, MAX_OPTIONS).map((o) => norm(o.textContent)),
        dup: sameName(desc.name, 'combobox') > 1,
      });
    } else if (desc.role === 'textbox') {
      onRecord({
        kind: 'type',
        name: desc.name,
        value: (el as HTMLInputElement).value ?? norm(el.textContent),
        multiline: el.tagName === 'TEXTAREA',
        numeric: (el.getAttribute('type') ?? '').toLowerCase() === 'number',
        dup: sameName(desc.name, 'textbox') > 1,
      });
    }
  }

  return {
    snapshot,

    record(on) {
      recording = on;
      if (!on || listening) return;
      listening = true;
      // 페이지의 처리기가 화면을 바꾸기 전에 읽어야 하므로 캡처 단계에서 듣는다.
      doc.addEventListener('click', onClick, true);
      doc.addEventListener('change', onChange, true);
    },

    point(ref, label) {
      const el = refs.get(ref);
      if (!el || !el.isConnected) return false;
      (el as HTMLElement).scrollIntoView?.({ block: 'center' });
      const r = el.getBoundingClientRect();
      const { box, tag } = ensureOverlay();
      const pad = 4;
      box.style.left = `${r.left - pad}px`;
      box.style.top = `${r.top - pad}px`;
      box.style.width = `${r.width + pad * 2}px`;
      box.style.height = `${r.height + pad * 2}px`;
      box.style.display = 'block';
      tag.textContent = label;
      return true;
    },

    setActive(on) {
      if (!on && !overlay) return;
      const o = ensureOverlay();
      o.frame.style.display = on ? 'block' : 'none';
      if (!on) o.box.style.display = 'none';
    },

    click: (ref) =>
      act(() => {
        const el = resolve(ref) as HTMLElement;
        el.scrollIntoView?.({ block: 'center' });
        el.click();
        return '클릭함';
      }),

    type: (ref, text) =>
      act(() => {
        const el = resolve(ref) as HTMLInputElement | HTMLTextAreaElement;
        if (el.tagName !== 'INPUT' && el.tagName !== 'TEXTAREA') {
          if (el.getAttribute('contenteditable') !== 'true') throw new Error('입력할 수 있는 요소가 아닙니다');
          (el as HTMLElement).focus();
          el.textContent = text;
          fire(el, 'input');
          return '입력함';
        }
        // React 등은 value 속성 설정을 가로채므로 원래 setter를 직접 호출한다.
        const proto =
          el.tagName === 'INPUT' ? win.HTMLInputElement.prototype : win.HTMLTextAreaElement.prototype;
        el.focus();
        Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(el, text);
        fire(el, 'input');
        fire(el, 'change');
        return '입력함';
      }),

    select: (ref, value) =>
      act(() => {
        const el = resolve(ref) as HTMLSelectElement;
        if (el.tagName !== 'SELECT') throw new Error('선택 상자가 아닙니다');
        const want = norm(value);
        const options = [...el.options];
        const hit =
          options.find((o) => norm(o.textContent) === want) ??
          options.find((o) => o.value === want) ??
          options.find((o) => norm(o.textContent).includes(want));
        if (!hit) {
          throw new Error(
            `옵션 "${value}"이 없습니다. 가능한 값: ${options.map((o) => norm(o.textContent)).join(', ')}`,
          );
        }
        if (el.value === hit.value) throw new Error(`이미 "${norm(hit.textContent)}"이(가) 선택되어 있습니다`);
        el.value = hit.value;
        fire(el, 'input');
        fire(el, 'change');
        return `"${norm(hit.textContent)}" 선택함`;
      }),

    fillTable: (ref, columns, rows, addRef) =>
      act(() => {
        const table = resolve(ref);
        let parts = tableParts(table);
        const colIdx = columns.map((c) => {
          const i = parts.header.indexOf(c);
          if (i < 0) throw new Error(`표에 "${c}" 컬럼이 없습니다. 표의 컬럼: ${parts.header.join(', ')}`);
          return i;
        });
        const editable = () => parts.rows.filter((r) => parts.cellsOf(r).some((c) => controlOf(c)));
        const used = editable().filter((r) => parts.cellsOf(r).some((c) => (controlOf(c)?.value ?? '') !== ''));
        if (used.length > 0) {
          throw new Error(`표에 이미 입력된 값이 있습니다 (${used.length}행). 비어 있는 표에만 입력합니다`);
        }
        while (editable().length < rows.length) {
          if (addRef === undefined) {
            throw new Error(`입력할 행은 ${rows.length}개인데 표의 빈 행은 ${editable().length}개입니다. add_ref에 행 추가 버튼을 지정하세요`);
          }
          const before = editable().length;
          (resolve(addRef) as HTMLElement).click();
          parts = tableParts(table);
          if (editable().length <= before) throw new Error('행 추가 버튼을 눌러도 행이 늘지 않습니다');
        }
        const targets = editable();
        // 먼저 전부 검사하고, 문제가 없을 때만 쓴다. 일부만 들어간 표를 남기지 않기 위해서다.
        const plan = rows.flatMap((row, r) => {
          const cells = parts.cellsOf(targets[r]);
          return columns.map((col, c) => {
            const where = `${r + 1}행 "${col}"`;
            const control = cells[colIdx[c]] && controlOf(cells[colIdx[c]]);
            if (!control) throw new Error(`${where} 칸은 입력할 수 없는 칸입니다`);
            const value = row[c] ?? '';
            checkControl(control, value, where);
            return { control, value, where };
          });
        });
        for (const p of plan) setControl(p.control, p.value, p.where);
        return `${rows.length}행 × ${columns.length}열 입력함`;
      }),

    extractTable(ref) {
      const { header, rows, cellsOf } = tableParts(resolve(ref));
      const data = rows.map((r) => cellsOf(r).map(cellValue));
      const width = Math.max(header.length, ...data.map((r) => r.length), 0);
      const columns = Array.from({ length: width }, (_, i) => header[i] || `컬럼${i + 1}`);
      return { columns, rows: data.map((r) => Array.from({ length: width }, (_, i) => r[i] ?? '')) };
    },

    hasText(text) {
      if (!doc.body) return false;
      // 스크립트나 스타일 안에 적힌 글자는 화면에 보이는 것이 아니므로 뺀다.
      const body = doc.body.cloneNode(true) as Element;
      body.querySelectorAll('script,style,noscript,template').forEach((el) => el.remove());
      return norm(body.textContent).includes(norm(text));
    },

    /**
     * DOM 변경이 quietMs 동안 없고 aria-busy 표시가 사라질 때까지 기다린다. 최대 maxMs.
     */
    settle(quietMs = 300, maxMs = 8000) {
      return new Promise<void>((done) => {
        let quiet: ReturnType<typeof setTimeout>;
        const finish = () => {
          observer.disconnect();
          clearTimeout(quiet);
          clearTimeout(limit);
          done();
        };
        const onQuiet = () => {
          if (doc.querySelector('[aria-busy="true"]')) quiet = setTimeout(onQuiet, quietMs);
          else finish();
        };
        const observer = new win.MutationObserver(() => {
          clearTimeout(quiet);
          quiet = setTimeout(onQuiet, quietMs);
        });
        observer.observe(doc.documentElement, { childList: true, subtree: true, attributes: true, characterData: true });
        const limit = setTimeout(finish, maxMs);
        quiet = setTimeout(onQuiet, quietMs);
      });
    },
  };
}
