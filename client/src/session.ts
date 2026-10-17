import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import {
  DatasetStore,
  FREE_SKILL_ID,
  OpenAiCompatClient,
  buildFreeSkill,
  planRequest,
  readTable,
  resolveInputs,
  runSkill,
  type ApprovalRequest,
  type HistoryEntry,
  type RunEvent,
  type RunResult,
  type Skill,
  type SkillInputs,
} from '../../src/core';
import type { BrowserLink } from '../../bridge/hub.mjs';
import { openBridge, type Bridge } from './bridge';
import type { ClientConfig } from './config';
import { Office, findOfficeExe } from './office';
import { saveRunAsSkill } from './save-skill';
import { loadSkills, type SkillEntry } from './skills';
import { appendRun, filePathStore, folderFiles } from './store';
import { describeApproval, describeEvent, describeResult } from './terminal';

/**
 * Dogent 클라이언트의 한 세션: 확장과 잇고, 요청을 해석하고, 스킬을 실행한다.
 * 터미널(main.ts)과 데스크탑 화면(desktop/)이 같은 세션을 쓴다. 화면마다 다른 것은 Ui뿐이다.
 */
export interface Ui {
  print(text: string): void;
  /** 한 줄을 묻는다. 그만두면 null */
  ask(question: string): Promise<string | null>;
  confirm(question: string, fallback: boolean): Promise<boolean>;
  askDefault(question: string, fallback: string): Promise<string>;
  /** 아래는 화면이 구조로 그리고 싶을 때만. 없으면 글로 print한다. */
  started?(skill: string, page: string): void;
  runEvent?(e: RunEvent): void;
  approval?(request: ApprovalRequest): void;
  result?(result: RunResult, saved: string[]): void;
  connected?(browsers: BrowserLink[], via: string | null): void;
}

export interface SessionOptions {
  yes: boolean;
  allowWrite: boolean;
  dryRun: boolean;
  waitSec: number;
  /** 이번에 쓸 브라우저 (이름 일부나 번호) */
  browser?: string;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 로그인을 기다리는 최대 시간 (사이드 패널과 같다) */
const LOGIN_WAIT_MS = 5 * 60_000;

export class Session {
  private bridge: Bridge | null = null;
  private office: Office | null = null;
  /** 이번 실행에서 쓸 브라우저를 정했는지 */
  private chosen = false;
  private skills: SkillEntry[] = [];
  /** 대화 중 help에 보여 줄 글 */
  help = '';
  private abort: AbortController | null = null;

  constructor(
    private term: Ui,
    private cfg: ClientConfig,
    private flags: SessionOptions,
  ) {
    this.reloadSkills();
  }

  reloadSkills(): string[] {
    const { skills, errors } = loadSkills({ personal: this.cfg.personalSkills, team: this.cfg.teamSkills }, __DOGENT_SKILLS__);
    this.skills = skills;
    return errors;
  }

  /** Ctrl+C: 실행 중이면 멈추고, 아니면 끝낸다. */
  interrupt(): boolean {
    if (!this.abort) return false;
    this.abort.abort();
    return true;
  }

  private llm() {
    return new OpenAiCompatClient(this.cfg.llm);
  }

  /** 오피스 도구를 처음 쓸 때 띄운다. */
  async officeTool(): Promise<Office> {
    if (this.office) return this.office;
    const exe = findOfficeExe(this.cfg.officeExe);
    if (!exe) throw new Error('오피스 도구(dogent-office.exe)가 없습니다. pnpm office:build로 만들거나 dogent config officeExe <경로>로 알려 주세요');
    this.office = await Office.start(exe);
    return this.office;
  }

  /**
   * 파일 입력의 엑셀을 읽는다. 먼저 파일을 직접 읽고, 안 되면(문서 보안이 걸린 파일 등) 사용자의 Excel로 연다.
   */
  private async readInputFile(path: string): Promise<{ columns: string[]; rows: (string | number)[][] }> {
    try {
      const data = readFileSync(path);
      return await readTable(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer, basename(path));
    } catch (direct) {
      if (!/\.(xlsx|xlsm|xls|csv)$/i.test(path) || !findOfficeExe(this.cfg.officeExe)) throw direct;
      this.term.print(`  ${basename(path)}: 파일을 직접 읽지 못해(${(direct as Error).message}) Excel로 엽니다. 문서 보안이 걸린 파일일 수 있습니다`);
      return (await this.officeTool()).readTable(path);
    }
  }

  /** dogent excel …: 오피스 도구 확인용 */
  async excel(args: string[]): Promise<boolean> {
    const office = await this.officeTool();
    const [sub, ...rest] = args;
    if (sub === 'docs') {
      // 문서 공유망(EDM)의 읽기·편집으로 연 문서처럼 사용자의 Excel에 열린 문서
      const r = await office.userWorkbooks();
      if (r.length === 0) this.term.print('사용자의 Excel에 열린 문서가 없습니다');
      for (const b of r) this.term.print(`  ${b.name}${b.read_only ? ' (읽기 전용)' : ''}\n    ${b.full_name}`);
      return true;
    }
    if (sub === 'resave') {
      if (rest.length < 2) {
        this.term.print('dogent excel resave <원본> <저장할 경로>');
        return false;
      }
      const saved = await office.resave(rest[0], rest[1]);
      this.term.print(`Excel로 다시 저장했습니다: ${saved}\n문서 보안(NASCA)이 이 파일을 다시 암호화했는지 탐색기에서 확인하세요 (아이콘, 속성, 다른 PC에서 열어 보기)`);
      return true;
    }
    const path = sub;
    if (!path) {
      this.term.print('dogent excel <파일> | dogent excel docs | dogent excel resave <원본> <저장할 경로>');
      return false;
    }
    const { workbook, sheets } = await office.open(path);
    try {
      for (const s of sheets) this.term.print(`  시트 ${s.name}: ${s.range} (${s.rows}행 × ${s.columns}열)`);
      const t = await office.read(workbook, { maxRows: 5 });
      this.term.print(`\n${t.sheet} 앞부분 (전체 ${t.total_rows}행)`);
      this.term.print(`  ${t.columns.join(' | ')}`);
      for (const r of t.rows) this.term.print(`  ${r.join(' | ')}`);
    } finally {
      await office.close(workbook).catch(() => {});
    }
    return true;
  }

  /** 확장과 이어지기를 기다린다. */
  async connect(): Promise<Bridge> {
    if (this.bridge?.connected() && this.chosen) return this.bridge;
    this.bridge ??= await openBridge({ port: this.cfg.bridgePort });
    const bridge = this.bridge;
    // 확장은 보통 1초 안에 붙는다. 그보다 오래 걸릴 때만 무엇을 할지 알려 준다.
    if (!(await bridge.waitForExtension(2000))) {
      this.term.print('브라우저의 Dogent 확장이 연결되기를 기다립니다…');
      this.term.print('  사이드 패널 → 설정 → 클라이언트 연결을 켜고 토큰을 넣으세요 (토큰: dogent token).');
      if (!(await bridge.waitForExtension(this.flags.waitSec * 1000))) {
        throw new Error(`${this.flags.waitSec}초 안에 확장이 연결되지 않았습니다. 확장의 클라이언트 연결 설정과 토큰을 확인하세요`);
      }
    }
    const want = this.flags.browser ?? this.cfg.browser;
    if (!this.chosen) {
      if (want) {
        // 원하는 브라우저가 붙기를 잠시 기다렸다가 고른다. 없으면 연결된 브라우저 목록과 함께 알린다.
        const end = Date.now() + Math.min(this.flags.waitSec, 20) * 1000;
        while (!bridge.browsers().some((b) => b.browser.toLowerCase().includes(want.toLowerCase())) && Date.now() < end) await sleep(200);
        bridge.select(want);
      } else {
        // 지금 붙어 있는 브라우저를 쓴다. 실행 중에 다른 브라우저가 붙어도 바뀌지 않게 정해 둔다.
        const first = bridge.browsers().find((b) => b.selected);
        if (first) bridge.select(String(first.id));
      }
      this.chosen = true;
    }
    const all = bridge.browsers();
    const now = all.find((b) => b.selected);
    const hint = all.length > 1 && !want ? `\n  연결된 브라우저 ${all.length}개 (${all.map((b) => b.browser).join(', ')}). 바꾸려면 --browser edge, 계속 쓰려면 dogent config browser edge` : '';
    this.term.print(`확장 연결됨 (${bridge.connected()}) · ${now?.browser ?? '브라우저'}${hint}`);
    this.term.connected?.(all, bridge.connected());
    return bridge;
  }

  /** 연결된 브라우저 목록 */
  async listBrowsers(): Promise<void> {
    const bridge = await this.connect();
    // 클라이언트가 없을 때 확장은 5초마다 다시 붙어 보므로, 모든 브라우저가 붙을 만큼 기다렸다가 보여 준다.
    await sleep(6000);
    this.term.print(`연결된 브라우저 ${bridge.browsers().length}개`);
    for (const b of bridge.browsers()) this.term.print(`  [${b.id}]${b.selected ? ' (사용 중)' : ''} ${b.browser} — ${b.via}`);
  }

  /** 쓸 브라우저를 바꾼다 (번호나 이름 일부) */
  async useBrowser(which: string): Promise<void> {
    const bridge = await this.connect();
    const b = bridge.select(which);
    this.term.print(`[${b.id}] ${b.browser}을(를) 씁니다`);
  }

  listSkills(): void {
    const errors = this.reloadSkills();
    for (const e of this.skills) {
      const inputs = e.skill.inputs.map((i) => `${i.name}${i.required ? '*' : ''}`).join(', ');
      this.term.print(`  [${e.source}] ${e.skill.id} — ${e.skill.name} (${e.skill.risk})${inputs ? `  입력: ${inputs}` : ''}`);
    }
    for (const err of errors) this.term.print(`  읽지 못함: ${err}`);
  }

  /** 스킬의 입력값을 채운다. 비어 있는 필수 입력은 묻는다. */
  private async fillInputs(skill: Skill, given: Record<string, string>): Promise<{ values: SkillInputs; files: Record<string, string> } | null> {
    const form = { ...given };
    for (const i of skill.inputs) {
      if (form[i.name] !== undefined && form[i.name] !== '') continue;
      if (!i.required || i.default !== undefined) continue;
      const hint = [i.description, i.type === 'enum' && i.values ? `보기: ${i.values.join(', ')}` : '', i.type === 'file' ? '엑셀 파일 경로' : '']
        .filter(Boolean)
        .join(' · ');
      const a = await this.term.ask(`  ${i.label ?? i.name}${hint ? ` (${hint})` : ''}: `);
      if (a === null) return null;
      form[i.name] = a.trim();
    }
    const files: Record<string, string> = {};
    for (const i of skill.inputs) if (i.type === 'file' && form[i.name]) files[i.name] = form[i.name];
    const { values, errors } = resolveInputs(
      skill,
      Object.fromEntries(Object.entries(form).map(([k, v]) => [k, skill.inputs.find((i) => i.name === k)?.type === 'file' ? basename(v) : v])),
    );
    if (errors.length) {
      this.term.print(`입력값을 확인하세요: ${errors.join(' / ')}`);
      return null;
    }
    return { values, files };
  }

  /** 스킬 하나를 실행한다. 사이드 패널의 실행과 같은 규칙(승인, 로그인 대기, 경로 기억, 기록)을 따른다. */
  async execute(skill: Skill, values: SkillInputs, filePaths: Record<string, string> = {}): Promise<{ result: RunResult; entries: HistoryEntry[]; tabUrl: string }> {
    const bridge = await this.connect();
    const isFree = skill.id === FREE_SKILL_ID;
    const datasets = new DatasetStore();
    for (const spec of skill.inputs) {
      const path = filePaths[spec.name];
      if (spec.type !== 'file' || !spec.dataset || !path) continue;
      const table = await this.readInputFile(path);
      datasets.set(spec.dataset, table.columns, table.rows);
    }
    const target = await bridge.browser.target();
    if (!target.allowed) {
      throw new Error(`지금 브라우저 탭(${target.url})은 조작할 사이트 목록에 없습니다. 업무 화면 탭을 앞에 두거나 확장 설정 → 조작할 사이트에서 더하세요`);
    }
    const active = isFree ? buildFreeSkill(target.url, this.flags.allowWrite) : skill;
    const scale = Math.max(1, this.cfg.llm.timeoutScale || 1);
    const scaled = { ...active, limits: { ...active.limits, timeout_sec: active.limits.timeout_sec * scale } };
    const events: RunEvent[] = [];
    const saved: string[] = [];
    const startedAt = new Date().toISOString();
    this.abort = new AbortController();
    if (this.term.started) this.term.started(skill.name, target.title || target.url);
    else this.term.print(`\n${skill.name} 실행 — ${target.title || target.url}`);
    let result: RunResult;
    try {
      result = await runSkill(scaled, values, {
        llm: this.llm(),
        browser: bridge.browser,
        datasets,
        signal: this.abort.signal,
        dryRun: !isFree && skill.risk === 'R3' && this.flags.dryRun,
        direct: this.cfg.llm.skillDirect,
        paths: this.cfg.llm.pathCache && !isFree ? filePathStore(this.cfg.home) : undefined,
        files: folderFiles(
          this.cfg.outputDir,
          saved,
          this.cfg.saveThroughExcel ? async (temp, target) => void (await (await this.officeTool()).resave(temp, target)) : undefined,
        ),
        ui: {
          ask: async (q) => (await this.term.ask(`\n  질문: ${q}\n  답: `)) ?? '',
          // 승인은 확장의 승인 창에서 받는다. 어떤 클라이언트가 붙어도 확장이 지키는 통제다 (docs/09 D6).
          approve: async (request) => {
            if (this.term.approval) this.term.approval(request);
            else this.term.print(describeApproval(request));
            return bridge.browser.approve(request);
          },
        },
        loginWaitMs: LOGIN_WAIT_MS,
        onEvent: (e) => {
          events.push(e);
          if (this.term.runEvent) return this.term.runEvent(e);
          const line = describeEvent(e);
          if (line) this.term.print(line);
        },
      });
    } catch (e) {
      result = { status: 'error', message: (e as Error).message, lastStep: 0, actions: 0, files: [], datasets: [], outputs: {}, elapsedMs: 0 };
    } finally {
      this.abort = null;
    }
    if (this.term.result) this.term.result(result, saved);
    else this.term.print(describeResult(result, saved));
    appendRun(this.cfg.home, { id: crypto.randomUUID(), startedAt, skill: { id: skill.id, version: skill.version }, inputs: values, tabUrl: target.url, events, result });
    return { result, entries: events.flatMap((e) => (e.type === 'action' ? [e.entry] : [])), tabUrl: target.url };
  }

  /** dogent run <id> 이름=값 … */
  async runSkillById(id: string, pairs: string[]): Promise<boolean> {
    const entry = this.skills.find((e) => e.skill.id === id);
    if (!entry) {
      this.term.print(`"${id}" 스킬이 없습니다. dogent skills로 목록을 보세요`);
      return false;
    }
    const given = Object.fromEntries(pairs.map((p) => [p.slice(0, p.indexOf('=')), p.slice(p.indexOf('=') + 1)]).filter(([k]) => k));
    const filled = await this.fillInputs(entry.skill, given);
    if (!filled) return false;
    const { result } = await this.execute(entry.skill, filled.values, filled.files);
    return result.status === 'done' || result.status === 'dryrun';
  }

  /** 말로 한 요청: 맞는 스킬을 고르고 입력값을 뽑는다. 없으면 지금 화면에서 자유 요청으로 한다. */
  async request(text: string): Promise<boolean> {
    this.reloadSkills();
    this.term.print('요청을 해석하는 중…');
    let plan: { skill_id: string | null; inputs: Record<string, unknown> };
    try {
      plan = await planRequest(text, this.skills.map((e) => e.skill), this.llm());
    } catch (e) {
      this.term.print(`요청을 해석하지 못했습니다: ${(e as Error).message}`);
      return false;
    }
    const entry = plan.skill_id ? this.skills.find((e) => e.skill.id === plan.skill_id) : undefined;
    if (entry) {
      const given = Object.fromEntries(Object.entries(plan.inputs).map(([k, v]) => [k, String(v)]));
      this.term.print(`스킬: ${entry.skill.name} [${entry.source}]`);
      for (const [k, v] of Object.entries(given)) this.term.print(`  ${entry.skill.inputs.find((i) => i.name === k)?.label ?? k}: ${v}`);
      const filled = await this.fillInputs(entry.skill, given);
      if (!filled) return false;
      if (!this.flags.yes && !(await this.term.confirm('실행할까요?', true))) return false;
      const { result } = await this.execute(entry.skill, filled.values, filled.files);
      return result.status === 'done' || result.status === 'dryrun';
    }

    this.term.print('맞는 스킬이 없어 지금 브라우저 화면에서 자유 요청으로 합니다.');
    if (!this.flags.yes && !(await this.term.confirm('진행할까요?', true))) return false;
    const free = buildFreeSkill('http://localhost/', this.flags.allowWrite);
    const run = await this.execute(free, { request: text });
    if (run.result.status !== 'done') return false;
    // 잘 된 자유 요청은 개인 스킬로 저장할 수 있다.
    if (await this.term.confirm('\n이 실행을 스킬로 저장할까요? 다음부터 같은 요청을 스킬로 빠르게 합니다.', false)) {
      const file = await saveRunAsSkill(this.term, { request: text, tabUrl: run.tabUrl, entries: run.entries }, this.cfg.personalSkills, new Set(this.skills.map((e) => e.skill.id)));
      if (file) {
        this.reloadSkills();
        this.term.print(`개인 스킬로 저장했습니다: ${file}`);
      }
    }
    return true;
  }

  async tabs(): Promise<void> {
    const bridge = await this.connect();
    const r = await bridge.call('tabs_list', {});
    this.term.print(r.text);
  }

  /** 대화: 요청을 한 줄씩 받는다. */
  async repl(): Promise<void> {
    this.term.print(`Dogent 클라이언트 (${__DOGENT_BUILD__.mode}). 할 일을 말해 주세요. skills, tabs, browsers, browser <이름>, help, exit`);
    for (;;) {
      const line = await this.term.ask('\n무엇을 할까요? > ');
      if (line === null) return;
      const text = line.trim();
      if (!text) continue;
      if (text === 'exit' || text === 'quit' || text === '끝') return;
      try {
        await this.handle(text);
      } catch (e) {
        this.term.print(`오류: ${(e as Error).message}`);
      }
    }
  }

  /** 지금 쓸 수 있는 스킬 (개인 > 팀 > 기본). 화면의 스킬 목록에 쓴다. */
  skillList(): SkillEntry[] {
    this.reloadSkills();
    return this.skills;
  }

  /** 연결된 브라우저 목록 (기다리지 않음). 화면의 브라우저 고르기에 쓴다. */
  browsersNow(): BrowserLink[] {
    return this.bridge?.browsers() ?? [];
  }

  /** 브리지를 띄워 두어 확장이 미리 붙게 한다. 화면을 열 때 부른다. */
  async listen(): Promise<void> {
    this.bridge ??= await openBridge({ port: this.cfg.bridgePort });
  }

  /** 실행 중인지 */
  get running(): boolean {
    return this.abort !== null;
  }

  /** 한 줄 입력을 처리한다 (대화 모드와 화면의 입력 칸). 명령이 아니면 요청으로 본다. */
  async handle(text: string): Promise<void> {
    if (text === 'help') this.term.print(this.help);
    else if (text === 'skills') this.listSkills();
    else if (text === 'tabs') await this.tabs();
    else if (text === 'browsers') await this.listBrowsers();
    else if (/^browser\s+/.test(text)) await this.useBrowser(text.replace(/^browser\s+/, ''));
    else if (/^run\s+/.test(text)) {
      const [id, ...pairs] = text.replace(/^run\s+/, '').split(/\s+/);
      await this.runSkillById(id, pairs);
    } else if (/^excel(\s|$)/.test(text)) await this.excel(text.replace(/^excel\s*/, '').split(/\s+/).filter(Boolean));
    else await this.request(text);
  }

  async close(): Promise<void> {
    await this.office?.shutdown().catch(() => {});
    this.bridge?.close();
  }
}
