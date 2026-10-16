import { readDownloadedTable } from './excel';
import { renderInspection, type SiteInspection } from './inspect';
import { extractPages } from './pages';
import { SUBMIT_PATTERN, findElement } from './policy';
import { siteAllowed } from './sites';
import { renderSnapshot } from './snapshot';
import type { ApprovalRequest, BrowserPort, ConfirmPolicy, PageSnapshot, TableData } from './types';

/**
 * 외부 클라이언트(MCP)가 부르는 브라우저 도구의 실행부. 도구 목록은 bridge/tools.mjs에 있다.
 *
 * 스킬 실행 루프와 같은 통제를 여기서 직접 지킨다 (docs/09 D6). 어떤 클라이언트가 붙어도
 * - 조작할 사이트 목록 밖으로 이동하거나 내려받지 않는다.
 * - 저장·상신 계열 버튼은 사람의 승인을 받아야 누른다.
 * - 로그인 화면은 알리기만 하고, 비밀번호 칸은 화면 읽기에 나오지 않아 넣을 수 없다.
 */

/** 확장이 채워 주는 브라우저 쪽 기능. 탭 관리와 승인 창은 확장마다 다르므로 밖에서 받는다. */
export interface ToolHost {
  tabs(): Promise<{ id: number; url: string; title: string }[]>;
  /** 새 탭을 열고 그 번호를 돌려준다. */
  open(url: string): Promise<number>;
  /** 탭을 앞으로 가져온다. */
  focus(tabId: number): Promise<void>;
  /** 탭을 다루는 BrowserPort. 같은 탭에는 같은 것을 돌려줘야 ref가 유지된다. */
  port(tabId: number): BrowserPort & { inspect?(): Promise<SiteInspection> };
  /** 지금 조작할 수 있는 사이트 규칙 */
  sites(): Promise<string[]>;
  /** 저장·상신 직전에 사람에게 묻는다. */
  approve(request: ApprovalRequest, tabId: number): Promise<boolean>;
  /** 처음 대상으로 삼을 탭 (보통 지금 보고 있는 탭) */
  activeTab(): Promise<number | null>;
}

const LOGIN_POLL_MS = 1500;
const FIELD_ROLES = new Set(['textbox', 'combobox', 'checkbox', 'radio']);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Args = Record<string, unknown>;

const num = (args: Args, key: string, fallback?: number): number => {
  const v = args[key];
  if (v === undefined || v === null || v === '') {
    if (fallback === undefined) throw new Error(`${key}가 필요합니다`);
    return fallback;
  }
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`${key}는 숫자여야 합니다`);
  return n;
};
const str = (args: Args, key: string): string => {
  const v = args[key];
  if (typeof v !== 'string' || v === '') throw new Error(`${key}가 필요합니다`);
  return v;
};

function tableJson(t: { columns: string[]; rows: unknown[][] }, maxRows: number, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ columns: t.columns, total_rows: t.rows.length, ...extra, rows: t.rows.slice(0, maxRows) }, null, 1);
}

export class BrowserTools {
  private current: number | null = null;
  private snaps = new Map<number, PageSnapshot>();

  constructor(private host: ToolHost) {}

  private async target(tabId?: unknown): Promise<number> {
    if (tabId !== undefined && tabId !== null && tabId !== '') {
      this.current = Number(tabId);
      return this.current;
    }
    if (this.current !== null && (await this.host.tabs()).some((t) => t.id === this.current)) return this.current;
    const active = await this.host.activeTab();
    if (active === null) throw new Error('대상 탭이 없습니다. tabs_list로 탭을 고르거나 tab_open으로 여세요');
    this.current = active;
    return active;
  }

  private async allowed(url: string): Promise<void> {
    const sites = await this.host.sites();
    if (!siteAllowed(url, sites)) {
      throw new Error(`${url} 은(는) 조작할 사이트 목록에 없습니다. 브라우저의 Dogent 설정 → 조작할 사이트에서 더해야 합니다`);
    }
  }

  private lastSnap(tab: number): PageSnapshot {
    const snap = this.snaps.get(tab);
    if (!snap) throw new Error('먼저 snapshot으로 화면을 읽으세요');
    return snap;
  }

  /** 도구 하나를 실행하고 클라이언트에게 돌려줄 글을 만든다. 실패는 던진다. */
  async call(name: string, args: Args = {}): Promise<string> {
    switch (name) {
      case 'tabs_list': {
        const [tabs, sites] = await Promise.all([this.host.tabs(), this.host.sites()]);
        const current = this.current ?? (await this.host.activeTab());
        if (tabs.length === 0) return '열린 탭이 없습니다';
        return tabs
          .map((t) => `[${t.id}]${t.id === current ? ' (대상)' : ''} ${t.title || '(제목 없음)'} — ${t.url} · ${siteAllowed(t.url, sites) ? '조작 가능' : '조작할 사이트 목록 밖'}`)
          .join('\n');
      }
      case 'tab_open': {
        const url = str(args, 'url');
        await this.allowed(url);
        this.current = await this.host.open(url);
        return `새 탭 [${this.current}]에서 열었습니다: ${url}. snapshot으로 화면을 읽으세요`;
      }
      case 'tab_select': {
        const id = num(args, 'tab_id');
        if (!(await this.host.tabs()).some((t) => t.id === id)) throw new Error(`탭 [${id}]이 없습니다`);
        this.current = id;
        await this.host.focus(id);
        return `탭 [${id}]을 대상으로 정했습니다`;
      }
      case 'snapshot': {
        const tab = await this.target(args.tab_id);
        const snap = await this.host.port(tab).snapshot();
        this.snaps.set(tab, snap);
        const head = snap.hasPassword
          ? '[login_required] 로그인 화면입니다. 비밀번호는 입력할 수 없습니다. 사용자에게 이 탭에서 직접 로그인해 달라고 알리고 wait_for_login을 부르세요.\n'
          : '';
        const dialogs = snap.dialogs?.length ? `\n(뜬 창: ${snap.dialogs.map((d) => `${d.kind} "${d.message}"`).join(' / ')})` : '';
        return `${head}[tab ${tab}] ${renderSnapshot(snap)}${dialogs}`;
      }
      case 'navigate': {
        const url = str(args, 'url');
        await this.allowed(url);
        const tab = await this.target();
        this.snaps.delete(tab);
        return (await this.host.port(tab).navigate(url)).message;
      }
      case 'click': {
        const tab = await this.target();
        const snap = this.lastSnap(tab);
        const ref = num(args, 'ref');
        const el = findElement(snap, ref);
        if (!el) throw new Error(`[${ref}] 요소가 마지막 화면에 없습니다. snapshot을 다시 읽으세요`);
        const port = this.host.port(tab);
        let confirm: ConfirmPolicy | undefined = args.accept_dialog === true ? { accept: true, unless: SUBMIT_PATTERN.source } : undefined;
        if (SUBMIT_PATTERN.test(el.name)) {
          const request: ApprovalRequest = {
            skill: '외부 클라이언트의 요청',
            button: el.name,
            url: snap.url,
            fields: snap.items.flatMap((i) => (i.kind === 'el' && FIELD_ROLES.has(i.role) ? [{ name: i.name, value: i.value ?? '' }] : [])),
            tables: [],
          };
          if (!(await this.host.approve(request, tab))) throw new Error(`사용자가 "${el.name}"을(를) 승인하지 않았습니다. 누르지 않았습니다`);
          confirm = { accept: true };
        }
        this.snaps.delete(tab);
        const r = await port.click(ref, confirm);
        const dialogs = r.dialogs?.length ? ` (뜬 창: ${r.dialogs.map((d) => `${d.kind} "${d.message}" → ${d.accepted ? '확인' : '취소'}`).join(' / ')})` : '';
        if (!r.ok) throw new Error(r.message + dialogs);
        return r.message + dialogs;
      }
      case 'type':
      case 'select': {
        const tab = await this.target();
        this.lastSnap(tab);
        const port = this.host.port(tab);
        const r = name === 'type' ? await port.type(num(args, 'ref'), String(args.text ?? '')) : await port.select(num(args, 'ref'), str(args, 'value'));
        if (!r.ok) throw new Error(r.message);
        return r.message;
      }
      case 'wait_for': {
        const tab = await this.target();
        const text = str(args, 'text');
        const sec = Math.min(60, num(args, 'timeout_sec', 10));
        if (!(await this.host.port(tab).waitFor(text, sec * 1000))) throw new Error(`${sec}초 안에 "${text}"이(가) 나타나지 않았습니다`);
        return `"${text}"이(가) 나타났습니다`;
      }
      case 'extract_table': {
        const tab = await this.target();
        const snap = this.lastSnap(tab);
        const nextRef = args.next_ref === undefined || args.next_ref === null ? undefined : num(args, 'next_ref');
        const all: TableData = { columns: [], rows: [] };
        const pages = await extractPages(this.host.port(tab), snap, num(args, 'ref'), nextRef, (t, first) => {
          if (first) all.columns = t.columns;
          all.rows.push(...t.rows);
        });
        this.snaps.delete(tab);
        return tableJson(all, num(args, 'max_rows', 200), { pages });
      }
      case 'download_table': {
        const tab = await this.target();
        this.lastSnap(tab);
        const port = this.host.port(tab);
        if (!port.download) throw new Error('이 환경에서는 내려받기를 쓸 수 없습니다');
        const sites = await this.host.sites();
        const file = await port.download(num(args, 'ref'), num(args, 'timeout_sec', 30) * 1000, (url) =>
          url.startsWith('data:') || siteAllowed(url.replace(/^blob:/, ''), sites),
        );
        const table = await readDownloadedTable(file.data);
        return tableJson(table, num(args, 'max_rows', 200), { file: file.filename });
      }
      case 'fill_table': {
        const tab = await this.target();
        const snap = this.lastSnap(tab);
        const ref = num(args, 'ref');
        const columns = args.columns;
        const rows = args.rows;
        if (!Array.isArray(columns) || !Array.isArray(rows) || rows.some((r) => !Array.isArray(r))) {
          throw new Error('columns는 글자 배열, rows는 행 배열이어야 합니다');
        }
        const table = findElement(snap, ref);
        if (!table || table.role !== 'table') throw new Error(`[${ref}]은(는) 표가 아닙니다`);
        const cells = rows.map((r) => (r as unknown[]).map((c) => String(c ?? '')));
        const port = this.host.port(tab);
        const addRef = args.add_ref === undefined || args.add_ref === null ? undefined : num(args, 'add_ref');
        const r = await port.fillTable(ref, columns.map(String), cells, addRef);
        if (!r.ok) throw new Error(r.message);
        // 넣은 값을 화면에서 다시 읽어 대조한다. 그리드가 값을 거르거나 바꿨으면 알린다.
        const after = await port.snapshot();
        this.snaps.set(tab, after);
        const again = after.items.find((i) => i.kind === 'el' && i.role === 'table' && i.name === table.name);
        if (!again || again.kind !== 'el') return `${r.message}. 대조: 표를 다시 찾지 못했습니다`;
        const screen = await port.extractTable(again.ref);
        const idx = columns.map((c) => screen.columns.indexOf(String(c)));
        const filled = screen.rows.filter((row) => idx.some((i) => i >= 0 && row[i] !== ''));
        const diffs: string[] = [];
        cells.forEach((row, ri) =>
          row.forEach((want, ci) => {
            const got = idx[ci] < 0 ? undefined : filled[ri]?.[idx[ci]];
            if (got !== want.trim() && diffs.length < 5) diffs.push(`${ri + 1}행 "${columns[ci]}": 화면 "${got ?? ''}", 넣은 값 "${want}"`);
          }),
        );
        return diffs.length ? `${r.message}. 대조 불일치: ${diffs.join(' / ')}` : `${r.message}. 화면 값이 넣은 값과 일치합니다`;
      }
      case 'read_text': {
        const tab = await this.target();
        const port = this.host.port(tab);
        if (!port.readText) throw new Error('이 환경에서는 화면 글을 읽을 수 없습니다');
        const ref = args.ref === undefined || args.ref === null ? undefined : num(args, 'ref');
        if (ref !== undefined) this.lastSnap(tab);
        const text = await port.readText(ref);
        const max = num(args, 'max_chars', 20000);
        return text.length > max ? `${text.slice(0, max)}\n(이하 ${text.length - max}자 생략)` : text || '(보이는 글이 없습니다)';
      }
      case 'inspect': {
        const tab = await this.target();
        const port = this.host.port(tab);
        if (!port.inspect) throw new Error('이 환경에서는 화면 점검을 쓸 수 없습니다');
        return renderInspection(await port.inspect(), { hide: false });
      }
      case 'wait_for_login': {
        const tab = await this.target();
        const port = this.host.port(tab);
        const limit = Math.min(900, num(args, 'timeout_sec', 300)) * 1000;
        const started = Date.now();
        await this.host.focus(tab);
        await port.setActive?.(false).catch(() => {});
        for (;;) {
          const snap = await port.snapshot();
          if (!snap.hasPassword) {
            this.snaps.set(tab, snap);
            return `로그인이 끝났습니다 (${Math.round((Date.now() - started) / 1000)}초). 지금 화면: ${snap.title} — ${snap.url}. snapshot으로 다시 읽고 이어 가세요`;
          }
          if (Date.now() - started >= limit) throw new Error(`${Math.round(limit / 1000)}초 안에 로그인하지 않았습니다`);
          await sleep(LOGIN_POLL_MS);
        }
      }
      default:
        throw new Error(`모르는 도구: ${name}`);
    }
  }
}
