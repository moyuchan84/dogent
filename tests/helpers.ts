import ExcelJS from 'exceljs';
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { COLUMNS, generateWip } from '../mock-site/data.mjs';
import { mergeFrames, parseSkill, type BrowserPort, type FilePort, type LlmPort } from '../src/core';
import { createPageAgent, type PageAgent } from '../src/page/agent';
import { mockComplete } from '../tools/mock-llm.mjs';

const ROOT = join(import.meta.dirname, '..');
const ORIGIN = 'http://localhost:4173';

const read = (path: string) => readFileSync(join(ROOT, path), 'utf8');

export const wipSkill = () => parseSkill(read('skills/wip-check/SKILL.md'));
export const fwSkill = () =>
  parseSkill(read('skills/firewall-request/SKILL.md'), read('skills/firewall-request/policy.yaml'));

export const adjustSkill = () => parseSkill(read('skills/wip-adjust/SKILL.md'));

/** 모의 조정 화면이 저장한 내용. 한 번의 저장이 행 배열 하나다. */
export const adjustLog: string[][][] = [];

/** 모의 신청 화면이 접수한 방화벽 신청. 테스트마다 비우고 쓴다. */
export const fwLog: Record<string, string>[] = [];

/** 모의 사이트의 HTML을 jsdom에 올리고 스크립트까지 실행한다. /api/wip 는 같은 데이터 생성기로 대신한다. */
async function load(pathname: string): Promise<JSDOM> {
  const file = join(ROOT, 'mock-site/public', pathname);
  return JSDOM.fromFile(file, {
    url: ORIGIN + pathname,
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    beforeParse(window) {
      (window as any).fetch = async (input: string, init?: { method?: string; body?: string }) => {
        const url = new URL(input, ORIGIN);
        if (url.pathname === '/api/adjust') {
          const rows = JSON.parse(init?.body ?? '[]');
          adjustLog.push(rows);
          return { json: async () => ({ count: rows.length }) };
        }
        if (url.pathname === '/api/fw') {
          const entry = { id: `FW-${String(fwLog.length + 1).padStart(6, '0')}`, ...JSON.parse(init?.body ?? '{}') };
          fwLog.push(entry);
          return { json: async () => ({ id: entry.id }) };
        }
        const rows = generateWip(url.searchParams.get('line') ?? '', url.searchParams.get('step') ?? '');
        return { json: async () => ({ columns: COLUMNS, rows }) };
      };
    },
  });
}

/** jsdom 페이지 하나를 탭처럼 다루는 BrowserPort. 실제 확장의 ChromeBrowser와 같은 페이지 에이전트를 쓴다. */
export class JsdomBrowser implements BrowserPort {
  dom: JSDOM;
  private agent: PageAgent;
  private refs = new Map<number, { frame: number; localRef: number }>();

  constructor(dom?: JSDOM) {
    this.dom = dom ?? new JSDOM('<title>새 탭</title>', { url: 'https://start.example/' });
    this.agent = createPageAgent(this.dom.window as any);
  }

  static async open(pathname: string) {
    return new JsdomBrowser(await load(pathname));
  }

  get document() {
    return this.dom.window.document;
  }

  async snapshot() {
    const merged = mergeFrames([{ frame: 0, snap: this.agent.snapshot() }]);
    this.refs = merged.refs;
    return merged.snapshot;
  }

  async navigate(url: string) {
    this.dom = await load(new URL(url).pathname);
    this.agent = createPageAgent(this.dom.window as any);
    return { ok: true, message: `이동함: ${url}` };
  }

  private local(ref: number) {
    const t = this.refs.get(ref);
    if (!t) throw new Error(`ref ${ref} 없음`);
    return t.localRef;
  }

  async click(ref: number) {
    const r = this.agent.click(this.local(ref));
    await this.agent.settle(50, 3000);
    return r;
  }

  async type(ref: number, text: string) {
    return this.agent.type(this.local(ref), text);
  }

  async select(ref: number, value: string) {
    return this.agent.select(this.local(ref), value);
  }

  async fillTable(ref: number, columns: string[], rows: string[][], addRef?: number) {
    const r = this.agent.fillTable(this.local(ref), columns, rows, addRef === undefined ? undefined : this.local(addRef));
    await this.agent.settle(50, 3000);
    return r;
  }

  async waitFor(text: string, timeoutMs: number) {
    const deadline = Date.now() + timeoutMs;
    while (!this.agent.hasText(text)) {
      if (Date.now() >= deadline) return false;
      await new Promise((r) => setTimeout(r, 50));
    }
    return true;
  }

  async extractTable(ref: number) {
    return this.agent.extractTable(this.local(ref));
  }
}

export const mockLlm: LlmPort = { complete: async (messages) => mockComplete(messages) };

export function scriptedLlm(replies: (string | object)[]): LlmPort & { calls: number } {
  const llm = {
    calls: 0,
    async complete() {
      const reply = replies[Math.min(llm.calls++, replies.length - 1)];
      return typeof reply === 'string' ? reply : JSON.stringify(reply);
    },
  };
  return llm;
}

export function memoryFiles(): FilePort & { saved: Map<string, ArrayBuffer> } {
  const saved = new Map<string, ArrayBuffer>();
  return { saved, save: async (name, data) => void saved.set(name, data) };
}

export async function readWorkbook(data: ArrayBuffer): Promise<Record<string, unknown[][]>> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(data);
  const out: Record<string, unknown[][]> = {};
  wb.eachSheet((ws) => {
    const rows: unknown[][] = [];
    ws.eachRow((row) => rows.push((row.values as unknown[]).slice(1)));
    out[ws.name] = rows;
  });
  return out;
}
