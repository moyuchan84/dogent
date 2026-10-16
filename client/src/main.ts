import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import {
  DatasetStore,
  FREE_SKILL_ID,
  OpenAiCompatClient,
  buildFreeSkill,
  lintSkill,
  planRequest,
  readTable,
  resolveInputs,
  runSkill,
  type HistoryEntry,
  type RunEvent,
  type RunResult,
  type Skill,
  type SkillInputs,
} from '../../src/core';
import { openBridge, loadToken, type Bridge } from './bridge';
import { describeConfig, loadConfig, setConfig, type ClientConfig } from './config';
import { Office, findOfficeExe } from './office';
import { saveRunAsSkill } from './save-skill';
import { loadSkills, type SkillEntry } from './skills';
import { appendRun, filePathStore, folderFiles } from './store';
import { Terminal, describeApproval, describeEvent, describeResult } from './terminal';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 로그인을 기다리는 최대 시간 (사이드 패널과 같다) */
const LOGIN_WAIT_MS = 5 * 60_000;

const HELP = `Dogent 클라이언트 ${__DOGENT_BUILD__.version} (${__DOGENT_BUILD__.mode})

  dogent                          대화로 일을 시킨다 (끝내려면 exit)
  dogent "<요청>"                  요청 하나를 처리하고 끝낸다. 맞는 스킬이 있으면 스킬로, 없으면 지금 화면에서 자유 요청으로
  dogent run <스킬ID> 이름=값 …    스킬을 정한 입력값으로 실행한다. 파일 입력은 이름=파일경로
  dogent skills                   쓸 수 있는 스킬 (개인 > 팀 > 기본)
  dogent check <SKILL.md>         스킬 품질 검사
  dogent sync                     팀 스킬 저장소를 git pull로 받는다
  dogent tabs                     브라우저 탭 목록
  dogent browsers                 Dogent 확장이 연결된 브라우저 (크롬, 엣지 …). 대화 중에는 browser edge 로 바꿈
  dogent excel <파일>             Excel로 열어 시트와 앞부분을 보여 준다 (문서 보안 문서 확인)
  dogent excel docs               사용자의 Excel에 열린 문서 (문서 공유망에서 연 문서 등)
  dogent excel resave <원본> <새 경로>   Excel로 다시 저장 (문서 보안이 다시 암호화하는지 확인)
  dogent token                    확장의 "클라이언트 연결"에 넣을 토큰
  dogent config [키 값]            설정 보기 / 바꾸기 (예: dogent config llm.userId sso123)

  --yes          실행 전 확인을 묻지 않는다
  --allow-write  자유 요청에서 저장·상신 버튼을 허용한다 (누르기 전에 확장의 승인 창으로 묻는다)
  --dry-run      저장·상신 직전에 멈춘다 (시험 실행)
  --wait <초>    확장이 연결되기를 기다리는 시간 (기본 60)
  --browser <이름>  브라우저가 여럿일 때 쓸 브라우저 (edge, chrome 또는 번호). 늘 쓰려면 dogent config browser edge

브라우저 쪽: Dogent 확장의 사이드 패널 → 설정 → 클라이언트 연결에서 WebSocket(또는 Native Messaging)을 켜고 토큰을 넣으세요.`;

interface Flags {
  yes: boolean;
  allowWrite: boolean;
  dryRun: boolean;
  waitSec: number;
  /** 이번에 쓸 브라우저 (이름 일부나 번호) */
  browser?: string;
}

function parseArgs(argv: string[]): { args: string[]; flags: Flags } {
  const flags: Flags = { yes: false, allowWrite: false, dryRun: false, waitSec: 60 };
  const args: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--yes' || a === '-y') flags.yes = true;
    else if (a === '--allow-write') flags.allowWrite = true;
    else if (a === '--dry-run') flags.dryRun = true;
    else if (a === '--wait') flags.waitSec = Number(argv[++i]) || 60;
    else if (a === '--browser') flags.browser = argv[++i];
    else args.push(a);
  }
  return { args, flags };
}

class Client {
  private bridge: Bridge | null = null;
  private office: Office | null = null;
  /** 이번 실행에서 쓸 브라우저를 정했는지 */
  private chosen = false;
  private skills: SkillEntry[] = [];
  private abort: AbortController | null = null;

  constructor(
    private term: Terminal,
    private cfg: ClientConfig,
    private flags: Flags,
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
    this.term.print(`\n${skill.name} 실행 — ${target.title || target.url}`);
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
            this.term.print(describeApproval(request));
            return bridge.browser.approve(request);
          },
        },
        loginWaitMs: LOGIN_WAIT_MS,
        onEvent: (e) => {
          events.push(e);
          const line = describeEvent(e);
          if (line) this.term.print(line);
        },
      });
    } catch (e) {
      result = { status: 'error', message: (e as Error).message, lastStep: 0, actions: 0, files: [], datasets: [], outputs: {}, elapsedMs: 0 };
    } finally {
      this.abort = null;
    }
    this.term.print(describeResult(result, saved));
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
        if (text === 'help') this.term.print(HELP);
        else if (text === 'skills') this.listSkills();
        else if (text === 'tabs') await this.tabs();
        else if (text === 'browsers') await this.listBrowsers();
        else if (/^browser\s+/.test(text)) await this.useBrowser(text.replace(/^browser\s+/, ''));
        else await this.request(text);
      } catch (e) {
        this.term.print(`오류: ${(e as Error).message}`);
      }
    }
  }

  async close(): Promise<void> {
    await this.office?.shutdown().catch(() => {});
    this.bridge?.close();
  }
}

async function main(): Promise<number> {
  const { args, flags } = parseArgs(process.argv.slice(2));
  const [cmd, ...rest] = args;
  if (cmd === 'help' || cmd === '--help' || cmd === '-h') {
    console.log(HELP);
    return 0;
  }
  if (cmd === 'token') {
    console.log(loadToken());
    return 0;
  }
  const cfg = loadConfig();
  if (cmd === 'config') {
    if (rest.length >= 2) console.log(`${setConfig(rest[0], rest.slice(1).join(' '))}에 저장했습니다`);
    else console.log(describeConfig(loadConfig()));
    return 0;
  }
  if (cmd === 'check') {
    const report = lintSkill(readFileSync(rest[0], 'utf8'));
    console.log(`품질 검사: ${report.grade} (${report.score}점)`);
    for (const f of report.findings) console.log(`  [${f.level}] ${f.rule}${f.step ? ` ${f.step}단계` : ''}: ${f.message}`);
    return report.grade === 'F' ? 1 : 0;
  }
  if (cmd === 'sync') {
    if (!cfg.teamSkills) {
      console.log('팀 스킬 폴더가 없습니다. 사내 GitHub의 dogent-skills를 git clone한 뒤 dogent config teamSkills <폴더> 로 알려 주세요');
      return 1;
    }
    execFileSync('git', ['-C', cfg.teamSkills, 'pull', '--ff-only'], { stdio: 'inherit' });
    return 0;
  }

  const term = new Terminal();
  const client = new Client(term, cfg, flags);
  process.on('SIGINT', () => {
    if (client.interrupt()) term.print('\n멈추는 중… (한 번 더 누르면 끝냅니다)');
    else {
      void client.close().finally(() => process.exit(130));
    }
  });
  try {
    if (cmd === 'skills') {
      client.listSkills();
      return 0;
    }
    if (cmd === 'excel') return (await client.excel(rest)) ? 0 : 1;
    if (cmd === 'browsers') {
      await client.listBrowsers();
      return 0;
    }
    if (cmd === 'tabs') {
      await client.tabs();
      return 0;
    }
    if (cmd === 'run') return (await client.runSkillById(rest[0] ?? '', rest.slice(1))) ? 0 : 1;
    if (cmd) return (await client.request(args.join(' '))) ? 0 : 1;
    await client.repl();
    return 0;
  } catch (e) {
    term.print(`오류: ${(e as Error).message}`);
    return 1;
  } finally {
    await client.close();
  }
}

process.exitCode = await main();
process.exit();
