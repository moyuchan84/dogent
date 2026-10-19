import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import {
  DatasetStore,
  FREE_SKILL_ID,
  OpenAiCompatClient,
  buildFreeSkill,
  describeSystem,
  docOfSkill,
  docOfSystem,
  planRequest,
  readTable,
  resolveInputs,
  runSkill,
  sameUrl,
  startUrlForSkill,
  urlInText,
  searchSkills,
  searchSystems,
  shortlistSkills,
  skillCoversUrl,
  systemForUrl,
  type ApprovalRequest,
  type HistoryEntry,
  type RunEvent,
  type RunResult,
  type SearchHit,
  type Skill,
  type SkillInputs,
  type System,
} from '../../src/core';
import type { BrowserLink } from '../../bridge/hub.mjs';
import { openBridge, type Bridge } from './bridge';
import { composeFlow, editSkill } from './compose-skill';
import { setConfig, type ClientConfig } from './config';
import { loadSystems, type SystemEntry } from './systems';
import { Office, findOfficeExe } from './office';
import { saveRunAsSkill } from './save-skill';
import { loadSkills, type SkillEntry } from './skills';
import { appendRun, filePathStore, folderFiles, readRunStats } from './store';
import { syncTeam, teamCacheDir, teamMeta, teamStale, type TeamMeta } from './team';

/** 팀 스킬 저장소를 다시 받기까지의 시간 */
const TEAM_MAX_AGE_MS = 60 * 60_000;
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
  private systems: SystemEntry[] = [];
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
    const { skills, errors } = loadSkills(
      { personal: this.cfg.personalSkills, team: this.cfg.teamSkills, teamCache: this.cfg.teamSkillsUrl ? teamCacheDir(this.cfg.home) : undefined },
      __DOGENT_SKILLS__,
    );
    this.skills = skills;
    const sys = loadSystems(
      { personal: this.cfg.personalSkills, team: this.cfg.teamSkills, teamCache: this.cfg.teamSkillsUrl ? teamCacheDir(this.cfg.home) : undefined },
      __DOGENT_SKILLS__,
    );
    this.systems = sys.systems;
    return [...errors, ...sys.errors];
  }

  /**
   * 팀 스킬 저장소를 주소로 받아 온다. force가 아니면 마지막으로 받은 지 한 시간이 지났을 때만.
   * 닿지 않으면 받아 둔 것을 그대로 쓴다. 받았으면 몇 개를 받았는지 돌려준다.
   */
  async refreshTeam(opts: { force?: boolean; quiet?: boolean } = {}): Promise<TeamMeta | null> {
    const url = this.cfg.teamSkillsUrl;
    if (!url || (!opts.force && !teamStale(this.cfg.home, url, TEAM_MAX_AGE_MS))) return null;
    try {
      const meta = await syncTeam(this.cfg.home, url, { token: this.cfg.teamSkillsToken, timeoutMs: opts.force ? 20_000 : 6_000 });
      this.reloadSkills();
      if (!opts.quiet || meta.errors.length) this.term.print(`팀 스킬 ${meta.count}개를 받았습니다 (${url})`);
      for (const e of meta.errors) this.term.print(`  받지 않음: ${e}`);
      return meta;
    } catch (e) {
      const last = teamMeta(this.cfg.home);
      this.term.print(`팀 스킬 저장소에 닿지 못했습니다: ${(e as Error).message}${last ? `\n  ${last.at.slice(0, 16).replace('T', ' ')}에 받아 둔 ${last.count}개를 씁니다` : ''}`);
      return null;
    }
  }

  /** 지금 브라우저 탭. 확장이 붙어 있지 않으면 기다리지 않고 null (앱의 "지금 화면" 스킬에 쓴다) */
  async currentPage(): Promise<{ url: string; title: string } | null> {
    if (!this.bridge?.connected()) return null;
    try {
      await this.followActiveTab();
      const t = await this.bridge.browser.target();
      return { url: t.url, title: t.title };
    } catch {
      return null;
    }
  }

  /** 실행 중이 아니면 대상 탭을 사용자가 보고 있는 탭으로 되돌린다 (앞 요청이 새 탭을 열었어도 다음 요청은 지금 보는 탭에서 시작) */
  private async followActiveTab(): Promise<void> {
    if (this.running || !this.bridge?.connected()) return;
    await this.bridge.browser.followActive().catch(() => {});
  }

  private async currentUrl(): Promise<string | undefined> {
    return (await this.currentPage())?.url;
  }

  /** 이 PC의 실행 기록으로 낸 스킬별 성공률 */
  runStats() {
    return readRunStats(this.cfg.home);
  }

  /** 스킬 찾기 (skills search <말>). 말이 비면 지금 화면의 사이트를 다루는 스킬을 보여 준다. */
  async searchSkills(query: string): Promise<SearchHit<SkillEntry>[]> {
    this.reloadSkills();
    // 말이 없으면 지금 화면의 스킬을 보여 주는 것이라 확장이 붙기를 기다린다
    if (!query.trim()) await this.connect();
    const url = await this.currentUrl();
    const hits = searchSkills(this.skills, (e) => docOfSkill(e.skill), query, { url }).filter((h) => query.trim() || h.site);
    const stats = readRunStats(this.cfg.home);
    if (hits.length === 0) {
      this.term.print(
        query.trim()
          ? `"${query}"에 맞는 스킬이 없습니다. 말로 만들려면: skill new ${query}`
          : '지금 화면의 사이트를 다루는 스킬이 없습니다. skills search <말>로 찾거나 skill new로 만드세요',
      );
      return hits;
    }
    for (const h of hits.slice(0, 10)) {
      const s = h.item.skill;
      const st = stats.get(s.id);
      const used = st ? ` · 이 PC에서 ${st.runs}번${st.rate !== null ? `, 성공 ${Math.round(st.rate * 100)}%` : ''}${st.broken ? ' · 최근 연달아 실패' : ''}` : '';
      this.term.print(`  [${h.item.source}] ${s.id} — ${s.name} (${s.risk})${h.site ? ' · 지금 화면' : ''}${used}`);
      this.term.print(`      ${s.description}`);
    }
    if (hits.length > 10) this.term.print(`  … 외 ${hits.length - 10}개`);
    this.term.print('  자세히: skills info <ID> · 실행: run <ID> 이름=값 또는 말로 요청');
    return hits;
  }

  /** 스킬 하나의 자세한 정보 (skills info <id>) */
  skillInfo(id: string): boolean {
    this.reloadSkills();
    const e = this.skills.find((x) => x.skill.id === id);
    if (!e) {
      this.term.print(`"${id}" 스킬이 없습니다. skills search <말>로 찾아보세요`);
      return false;
    }
    const s = e.skill;
    const st = readRunStats(this.cfg.home).get(s.id);
    const lines = [
      `${s.name} (${s.id} v${s.version}) [${e.source}]`,
      `  ${s.description}`,
      `  담당 ${s.owner} · 위험 ${s.risk}${s.risk === 'R3' ? ' (저장·상신, 승인 필요)' : ''} · 사이트 ${s.domains.join(', ')}${s.schedulable ? ' · 예약 가능' : ''}`,
      ...(s.tags.length ? [`  태그 ${s.tags.join(', ')}`] : []),
      `  단계 ${s.steps.length}개${e.path ? ` · ${e.path}` : ''}`,
    ];
    if (s.inputs.length) {
      lines.push('  입력:');
      for (const i of s.inputs) {
        const notes = [i.type, ...(i.required && i.default === undefined ? ['필수'] : []), ...(i.default !== undefined ? [`기본 ${i.default}`] : [])].join(', ');
        lines.push(`    ${i.name} ${i.label ?? ''} (${notes})${i.description ? ` — ${i.description}` : ''}`);
      }
    }
    lines.push(
      st
        ? `  이 PC의 기록: ${st.runs}번 실행, 성공 ${st.ok} · 실패 ${st.fail}${st.avgSec !== null ? ` · 평균 ${Math.round(st.avgSec)}초` : ''} · 마지막 ${st.lastAt.slice(0, 16).replace('T', ' ')}${st.broken ? '\n  ! 전에는 되다가 최근 연달아 실패합니다. 화면이 바뀌었을 수 있습니다' : ''}`
        : '  이 PC의 기록: 아직 실행하지 않음',
    );
    const inputs = s.inputs.filter((i) => i.type !== 'file').map((i) => `${i.name}=${i.default ?? '…'}`).join(' ');
    lines.push(`  실행: run ${s.id}${inputs ? ` ${inputs}` : ''}`);
    this.term.print(lines.join('\n'));
    return true;
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
      this.term.print('  사이드 패널 → 설정 → 클라이언트 연결에서 방식을 고르고 저장하세요 (WebSocket이면 토큰: dogent token).');
      this.term.print('  계속 안 붙으면 터미널에서 dogent doctor 로 원인을 찾을 수 있습니다 (Native Messaging 등록은 dogent doctor --fix).');
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
  async execute(
    skill: Skill,
    values: SkillInputs,
    filePaths: Record<string, string> = {},
    opts: { dryRun?: boolean; /** 자유 요청에 붙일 시스템 설명 */ systemInfo?: string } = {},
  ): Promise<{ result: RunResult; entries: HistoryEntry[]; tabUrl: string }> {
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
    const active = isFree ? buildFreeSkill(target.url, this.flags.allowWrite, opts.systemInfo) : skill;
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
        dryRun: !isFree && skill.risk === 'R3' && (opts.dryRun ?? this.flags.dryRun),
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

  /**
   * 요청에 나온 시스템(named)과 지금 화면의 시스템을 찾아 모델에 보여 줄 설명을 만든다.
   * 시스템 사전이 비어 있으면 아무것도 하지 않는다.
   */
  private async systemsFor(text: string): Promise<{ named: System[]; systemInfo?: string }> {
    if (!this.systems.length) return { named: [] };
    const all = this.systems.map((e) => e.system);
    const named = searchSystems(all, text, 2);
    const here = systemForUrl(all, await this.currentUrl());
    const context = [...new Set([...named, ...(here ? [here] : [])])];
    return { named, systemInfo: context.length ? context.map(describeSystem).join('\n\n') : undefined };
  }

  /**
   * 주소를 새 탭에서 열고 그 탭을 대상으로 정한다. 열려 있는 탭은 건드리지 않는다.
   * 조작할 사이트 목록 밖이면 확장이 거절한다. 못 열었거나 사용자가 그만두면 false.
   */
  private async openStart(url: string, label: string): Promise<boolean> {
    const bridge = await this.connect();
    if (!this.flags.yes && !(await this.term.confirm(`새 탭에서 ${label}(${url})을 엽니다. 진행할까요?`, true))) return false;
    const r = await bridge.call('tab_open', { url });
    if (r.isError) {
      this.term.print(`${label}을(를) 열지 못했습니다: ${r.text}`);
      return false;
    }
    this.term.print(`새 탭에서 열었습니다: ${url}`);
    return true;
  }

  /**
   * 스킬을 돌릴 탭을 마련한다. 지금 탭이 스킬의 사이트면 그대로 쓰고, 아니면 시작 주소(요청에 쓴 주소 > 시스템 사전 > 스킬 본문)를 새 탭에서 연다.
   * 시작 주소를 알 수 없으면 지금 탭에서 한다 (맞지 않으면 실행이 안내한다).
   */
  private async ensureStartTab(skill: Skill, request?: string): Promise<boolean> {
    const bridge = await this.connect();
    const now = await bridge.browser.target().catch(() => null);
    const doc = docOfSkill(skill);
    const asked = request ? urlInText(request) : null;
    if (asked && skillCoversUrl(doc, asked)) return sameUrl(now?.url, asked) || (await this.openStart(asked, skill.name));
    if (now?.allowed && skillCoversUrl(doc, now.url)) return true;
    const url = startUrlForSkill(skill, this.systems.map((e) => e.system));
    return url ? this.openStart(url, skill.name) : true;
  }

  /** systems — 시스템 사전 목록 */
  listSystems(): void {
    this.reloadSkills();
    if (!this.systems.length) {
      this.term.print('시스템 사전이 비어 있습니다. 팀 저장소의 skills/systems/<id>/SYSTEM.md 또는 개인 폴더(' + this.cfg.personalSkills + '/systems)에 SYSTEM.md를 두세요 (docs/05-skill-spec.md)');
      return;
    }
    for (const e of this.systems) {
      const x = e.system;
      this.term.print(`  [${e.source}] ${x.id} — ${x.name}${x.aliases.length ? ` (${x.aliases.join(', ')})` : ''}`);
    }
    this.term.print('  자세히: systems info <ID>');
  }

  /** systems info <id> */
  systemInfo(id: string): boolean {
    this.reloadSkills();
    const e = this.systems.find((x) => x.system.id === id);
    if (!e) {
      this.term.print(`"${id}" 시스템이 없습니다. systems로 목록을 보세요`);
      return false;
    }
    const skills = this.skills.filter((k) => skillCoversUrl(docOfSkill(k.skill), e.system.url)).map((k) => k.skill.id);
    this.term.print(
      [`[${e.source}] ${describeSystem(e.system)}`, ...(e.path ? [`파일: ${e.path}`] : []), `사이트: ${e.system.domains.join(', ')}`, `이 시스템의 스킬: ${skills.length ? skills.join(', ') : '(없음)'}`].join('\n'),
    );
    return true;
  }

  /** dogent run <id> 이름=값 … */
  async runSkillById(id: string, pairs: string[]): Promise<boolean> {
    await this.followActiveTab();
    const entry = this.skills.find((e) => e.skill.id === id);
    if (!entry) {
      this.term.print(`"${id}" 스킬이 없습니다. dogent skills로 목록을 보세요`);
      return false;
    }
    const given = Object.fromEntries(pairs.map((p) => [p.slice(0, p.indexOf('=')), p.slice(p.indexOf('=') + 1)]).filter(([k]) => k));
    const filled = await this.fillInputs(entry.skill, given);
    if (!filled) return false;
    if (!(await this.ensureStartTab(entry.skill))) return false;
    const { result } = await this.execute(entry.skill, filled.values, filled.files);
    return result.status === 'done' || result.status === 'dryrun';
  }

  /** 말로 한 요청: 맞는 스킬을 고르고 입력값을 뽑는다. 없으면 지금 화면에서 자유 요청으로 한다. */
  async request(text: string): Promise<boolean> {
    this.reloadSkills();
    await this.followActiveTab();
    const { named, systemInfo } = await this.systemsFor(text);
    if (named.length) this.term.print(`시스템: ${named.map((m) => m.name).join(', ')}`);
    this.term.print('요청을 해석하는 중…');
    let plan: { skill_id: string | null; inputs: Record<string, unknown> };
    try {
      // 스킬이 많으면 말이 맞는 것과 지금 화면의 사이트를 다루는 것만 모델에 보여 준다 (프롬프트가 길어지지 않게)
      const base = shortlistSkills(this.skills, (e) => docOfSkill(e.skill), text, { url: await this.currentUrl() });
      // 요청에 나온 시스템을 다루는 스킬도 후보에 넣는다 (그 시스템 화면이 아직 열려 있지 않아도)
      const extra = this.skills.filter((e) => !base.includes(e) && named.some((m) => skillCoversUrl(docOfSkill(e.skill), m.url)));
      plan = await planRequest(text, [...base, ...extra].map((e) => e.skill), this.llm(), undefined, systemInfo);
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
      if (!(await this.ensureStartTab(entry.skill, text))) return false;
      const { result } = await this.execute(entry.skill, filled.values, filled.files);
      return result.status === 'done' || result.status === 'dryrun';
    }

    this.term.print('맞는 스킬이 없어 지금 브라우저 화면에서 자유 요청으로 합니다.');
    if (!this.flags.yes && !(await this.term.confirm('진행할까요?', true))) return false;
    // 요청에 주소나 시스템 이름이 있으면 열려 있는 탭을 두고 새 탭에서 시작한다 (조작할 사이트 목록 안일 때만 열린다)
    const asked = urlInText(text);
    if (asked) {
      const now = await (await this.connect()).browser.target().catch(() => null);
      if (!sameUrl(now?.url, asked) && !(await this.openStart(asked, asked))) return false;
    } else if (named[0]) {
      const now = await (await this.connect()).browser.target().catch(() => null);
      if (!(now && skillCoversUrl(docOfSystem(named[0]), now.url)) && !(await this.openStart(named[0].url, named[0].name))) return false;
    }
    const free = buildFreeSkill('http://localhost/', this.flags.allowWrite);
    const run = await this.execute(free, { request: text }, {}, { systemInfo });
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

  /** 말로 스킬 만들기 (skill new). 지금 브라우저 탭의 화면에서 시작한다. */
  async composeSkill(request?: string): Promise<boolean> {
    this.reloadSkills();
    const bridge = await this.connect();
    const file = await composeFlow(
      {
        ui: this.term,
        llm: this.llm(),
        personalDir: this.cfg.personalSkills,
        takenIds: new Set(this.skills.map((e) => e.skill.id)),
        owner: this.cfg.owner,
        rememberOwner: (owner) => {
          this.cfg.owner = owner;
          setConfig('owner', owner);
        },
        page: async () => {
          const target = await bridge.browser.target();
          if (!target.allowed) {
            throw new Error(`지금 브라우저 탭(${target.url})은 조작할 사이트 목록에 없습니다. 업무 화면 탭을 앞에 두거나 확장 설정 → 조작할 사이트에서 더하세요`);
          }
          return { url: target.url, title: target.title, snap: await bridge.browser.snapshot() };
        },
        test: async (skill) => {
          this.term.print('\n시험 실행합니다. 저장·상신은 직전에 멈춥니다.');
          const filled = await this.fillInputs(skill, {});
          if (!filled) return null;
          return (await this.execute(skill, filled.values, filled.files, { dryRun: true })).result;
        },
      },
      request,
    );
    this.reloadSkills();
    return file !== null;
  }

  /** 스킬을 편집기로 고친다 (skill edit <id>). */
  async editSkill(id: string): Promise<boolean> {
    this.reloadSkills();
    const entry = this.skills.find((e) => e.skill.id === id);
    if (!entry) {
      this.term.print(`"${id}" 스킬이 없습니다. dogent skills로 목록을 보세요`);
      return false;
    }
    // 기본 스킬은 파일이 없으므로 빌드에 넣은 원문을 복사해 연다
    const bundled = Object.entries(__DOGENT_SKILLS__).find(([p, src]) => p.endsWith('SKILL.md') && new RegExp(`^id:\\s*${id}\\s*$`, 'm').test(src))?.[1];
    const file = await editSkill(this.term, entry, this.cfg.personalSkills, bundled);
    this.reloadSkills();
    return file !== null;
  }

  async tabs(): Promise<void> {
    const bridge = await this.connect();
    const r = await bridge.call('tabs_list', {});
    this.term.print(r.text);
  }

  /** 대화: 요청을 한 줄씩 받는다. */
  async repl(): Promise<void> {
    this.term.print(`Dogent 클라이언트 (${__DOGENT_BUILD__.mode}). 할 일을 말해 주세요. skills, 찾기 <말>, skills info <id>, systems, skill new, skill edit <id>, sync, tabs, browsers, browser <이름>, help, exit`);
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

  /** 시스템 사전 (개인 > 팀 > 기본). 화면의 시스템 목록에 쓴다. */
  systemList(): SystemEntry[] {
    this.reloadSkills();
    return this.systems;
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
    else if (/^(skills\s+search|찾기)(\s|$)/.test(text)) await this.searchSkills(text.replace(/^(skills\s+search|찾기)\s*/, ''));
    else if (/^skills\s+info\s+\S/.test(text)) this.skillInfo(text.replace(/^skills\s+info\s+/, '').trim());
    else if (text === 'systems') this.listSystems();
    else if (/^systems\s+info\s+\S/.test(text)) this.systemInfo(text.replace(/^systems\s+info\s+/, '').trim());
    else if (text === 'sync') await this.refreshTeam({ force: true });
    else if (text === 'tabs') await this.tabs();
    else if (text === 'browsers') await this.listBrowsers();
    else if (/^browser\s+/.test(text)) await this.useBrowser(text.replace(/^browser\s+/, ''));
    else if (/^run\s+/.test(text)) {
      const [id, ...pairs] = text.replace(/^run\s+/, '').split(/\s+/);
      await this.runSkillById(id, pairs);
    } else if (/^(skill\s+new|스킬\s*만들기)(\s|$)/.test(text)) await this.composeSkill(text.replace(/^(skill\s+new|스킬\s*만들기)\s*/, ''));
    else if (/^skill\s+edit\s+\S/.test(text)) await this.editSkill(text.replace(/^skill\s+edit\s+/, '').trim());
    else if (/^excel(\s|$)/.test(text)) await this.excel(text.replace(/^excel\s*/, '').split(/\s+/).filter(Boolean));
    else await this.request(text);
  }

  async close(): Promise<void> {
    await this.office?.shutdown().catch(() => {});
    this.bridge?.close();
  }
}
