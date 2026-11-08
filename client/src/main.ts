import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { lintSkill, lintSystem } from '../../src/core';
import { runDoctor } from './doctor';
import { loadToken } from './bridge';
import { describeConfig, loadConfig, setConfig } from './config';
import { McpHub, describeHub, describeMcpConfig, loadMcpConfig, saveMcpConfig, type McpServerSpec } from './mcp-hub';
import { remoteMcpUsed } from './mcp-http';
import { stdioMcpUsed } from './mcp-stdio';
import { fetchCatalog, missingEnv, specOf } from './mcp-catalog';
import { describeCatalogServer } from '../../src/core';
import { describeInstall, normalizeServers, parseMcpAdd } from './mcp-install';
import { addSchedule, describeSchedule, listSchedules, parseSpec, removeSchedule } from './schedule';
import { Session, type SessionOptions } from './session';
import { readScripts } from './skills';
import { AgentPeer, PRESETS, describeAgents, findExecutable, loadAgents, saveAgents, type AgentSpec } from './agents';
import { addInstruction, personalInstructionsFile } from './conversation';
import { Collector, DogentMcp, serveHttp, serveStdio, sessionRunner } from './mcp-serve';
import { Terminal } from './terminal';

const HELP = `Dogent 클라이언트 ${__DOGENT_BUILD__.version} (${__DOGENT_BUILD__.mode})

  dogent                          대화로 일을 시킨다 (끝내려면 exit)
  dogent "<요청>"                  요청 하나를 처리하고 끝낸다. 맞는 스킬이 있으면 스킬로, 없으면 지금 화면에서 자유 요청으로
  dogent run <스킬ID> 이름=값 …    스킬을 정한 입력값으로 실행한다. 파일 입력은 이름=파일경로
  dogent skills                   쓸 수 있는 스킬 (개인 > 팀 > 기본)
  dogent skills search [<말>]     스킬 찾기 (예: dogent skills search 홀드 해제). 말이 없으면 지금 브라우저 화면의 사이트용 스킬
  dogent skills info <스킬ID>     입력, 위험도, 담당, 이 PC에서의 성공률
  dogent systems [info <ID>]      사내 시스템 사전 (이름·별칭·주소·화면·용어). 요청에 시스템 이름이 나오면 모델에 함께 보여 준다
  dogent skill new ["<업무 설명>"]   말로 스킬 만들기: 지금 브라우저 화면을 보고 초안 → 말로 고치기 → 시험 → 저장
  dogent skill edit <스킬ID>       스킬 파일을 편집기로 열고, 닫으면 품질 검사 (편집기: DOGENT_EDITOR, 기본 notepad)
  dogent check <SKILL.md|SYSTEM.md>  스킬 또는 시스템 문서 품질 검사
  dogent sync                     팀 스킬 저장소(teamSkillsUrl 주소, teamSkills 폴더는 git pull)와 공용 시스템 사전(systemsUrl)을 받는다
  dogent tabs                     브라우저 탭 목록
  dogent browsers                 Dogent 확장이 연결된 브라우저 (크롬, 엣지 …). 대화 중에는 browser edge 로 바꿈
  dogent excel <파일|열린 문서 이름>   Excel로 열어 시트와 앞부분을 보여 준다 (문서 보안 문서 확인)
  dogent excel docs               사용자의 Excel에 열린 문서 (문서 공유망에서 연 문서 등)
  dogent excel resave <원본> <새 경로>   Excel로 다시 저장 (문서 보안이 다시 암호화하는지 확인)
  dogent agents [list|add|remove|test|on|off|allow|ask|deny]
                                  사내 코딩 에이전트(Claude Code, opencode+GLM) 연결. 자유 요청이 PC의 파일·코드 일을 맡긴다
  dogent ask <에이전트> "<할 일>"     에이전트에 바로 맡긴다 (예: dogent ask claude "Downloads의 재공.xlsx를 라인별로 요약")
  dogent serve [--http <포트>]       Dogent를 MCP 서버로 띄운다. Claude Code·opencode가 사내 웹 업무를 Dogent에 맡긴다
                                  (claude mcp add dogent -- node <경로>\dogent.mjs serve). 앱이 켜져 있으면 앱의 주소를 쓴다
  (대화 중) /스킬ID [말]             스킬을 바로 부른다. 예: /wip-check 7라인.  계획: <요청>  할 일을 먼저 보이고 확인받은 뒤 실행
  (대화 중) hooks [remove N|test]    훅(도구 쓰기 전후·요청·끝날 때 명령 실행, ~/.dogent/hooks.json). 말로도 된다: "엑셀에 쓰기 전에 기록 남기는 훅 만들어줘"
  dogent memory [add "<지침>"|edit]  늘 지킬 지침 (~/.dogent/DOGENT.md). 모든 요청에서 모델이 함께 본다
  dogent mcp [list|add|remove|test|allow|ask|deny|keyword|on|off]
                                  MCP 서버 연결 (사내 시스템 도구를 에이전트가 부른다). 설정은 ~/.dogent/mcp.json
  dogent schedule add <이름> --at 09:00 [--days 월,수,금] <스킬ID> [이름=값 …]   예약 실행 (매일, 또는 요일마다. 저장·상신은 하지 않는다)
  dogent schedule list|remove <이름>   예약 보기 / 지우기
  dogent doctor [--fix] [--id <확장 ID>] [--wait <초>]
                                  확장이 안 붙을 때 원인 점검 (토큰, 포트, Native Messaging 등록, 회사 정책, 실시간 시험). --fix는 호스트를 등록한다
  dogent token                    확장의 "클라이언트 연결"에 넣을 토큰
  dogent config [키 값]            설정 보기 / 바꾸기 (예: dogent config llm.userId sso123)

  --continue, -c 마지막 대화를 이어 간다 (앞선 요청과 결과를 모델이 함께 본다)
  --yes          실행 전 확인을 묻지 않는다
  --allow-write  자유 요청에서 저장·상신 버튼을 허용한다 (누르기 전에 확장의 승인 창으로 묻는다)
  --dry-run      저장·상신 직전에 멈춘다 (시험 실행)
  --wait <초>    확장이 연결되기를 기다리는 시간 (기본 60)
  --browser <이름>  브라우저가 여럿일 때 쓸 브라우저 (edge, chrome 또는 번호). 늘 쓰려면 dogent config browser edge

브라우저 쪽: Dogent 확장의 사이드 패널 → 설정 → 클라이언트 연결에서 WebSocket(또는 Native Messaging)을 켜고 토큰을 넣으세요.`;

const MCP_USAGE = `사용법:
  dogent mcp list                          연결한 MCP 서버
  dogent mcp add <이름> <주소>               원격 서버 더하기 (claude mcp add와 같은 모양)
      예: dogent mcp add github-mcp http://서버/mcp --transport http --scope user
          dogent mcp add --header "Authorization: Bearer \${GH_TOKEN}" github-mcp http://서버/mcp
  dogent mcp add <이름> -- <명령> [인자 …]   이 PC에서 도는 서버 더하기 (예: dogent mcp add mes -e KEY=값 -- npx -y @회사/mes-mcp)
  dogent mcp add-json <이름> '<JSON>'        서버 설정 JSON 하나를 더하기 (예: '{"type":"http","url":"http://서버/mcp"}')
  dogent mcp import <파일|주소>              mcpServers/servers/mcp JSON을 통째로 가져오기 (Claude Code, Cursor, VS Code, opencode 형식)
      (더하기 전에 실행될 명령과 보낼 주소를 보여 주고 확인을 받습니다. 건너뛰려면 --yes, 연결 시험을 빼려면 --no-test)
  dogent mcp remove <이름>                  서버 빼기
  dogent mcp test [<이름>]                  서버를 띄워 도구 목록 보기 (안 뜨는 이유도 보여 줌)
  dogent mcp allow|ask|deny <서버> <도구|*>  도구 권한: 바로 부름 / 부르기 전에 묻기 / 금지
  dogent mcp keyword <서버> <말 …>           요청에 이 말이 나오면 브라우저 없이 이 서버로 처리
  dogent mcp off|on <이름>                  서버 끄기 / 켜기
  dogent mcp browse                         사내 MCP 카탈로그 (팀 저장소 mcp/catalog.json, 주소: dogent config mcpCatalogUrl)
  dogent mcp install <카탈로그ID> [--yes]    카탈로그의 서버를 내 설정에 더하고 연결 시험`;

/** 더할 서버를 보여 주고 확인을 받는다. 터미널이 아니면(자동 실행) --yes 없이는 더하지 않는다. */
async function confirmInstall(entries: Record<string, McpServerSpec>, existing: Record<string, McpServerSpec>, yes: boolean): Promise<boolean> {
  for (const [name, spec] of Object.entries(entries)) {
    for (const l of describeInstall(name, spec)) console.log(l);
    if (existing[name]) console.log(`  (이미 있는 "${name}"을(를) 바꿉니다)`);
  }
  if (yes) return true;
  if (!process.stdin.isTTY) {
    console.log('확인할 수 없는 환경입니다. 내용을 확인했다면 --yes 를 붙여 다시 실행하세요');
    return false;
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await rl.question('더할까요? (y/N) ')).trim().toLowerCase();
    return ['y', 'yes', 'ㅇ', '예', '네'].includes(answer);
  } finally {
    rl.close();
  }
}

/** 더한 서버를 띄워 도구 목록을 보여 준다. 실패해도 더한 것은 남긴다. */
async function testInstalled(names: string[], cfg: { servers: Record<string, McpServerSpec> }): Promise<number> {
  const hub = await McpHub.open({ servers: Object.fromEntries(names.map((n) => [n, { ...cfg.servers[n], disabled: false }])) }, (l) => console.log(`  ${l}`));
  try {
    console.log('연결 시험:');
    for (const l of describeHub(hub)) console.log(`  ${l}`);
    return hub.failed.length ? 1 : 0;
  } finally {
    await hub.close();
  }
}

async function readJsonSource(source: string): Promise<unknown> {
  if (/^https?:\/\//i.test(source)) {
    const res = await fetch(source, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) throw new Error(`${source}: HTTP ${res.status}`);
    return JSON.parse(await res.text());
  }
  return JSON.parse(readFileSync(source, 'utf8'));
}

async function runMcpCommand(rest: string[]): Promise<number> {
  const [sub, ...a] = rest;
  const cfg = loadMcpConfig();
  const need = (name: string | undefined) => {
    if (!name || !cfg.servers[name]) throw new Error(`서버 "${name ?? ''}"이(가) 없습니다 (dogent mcp list)`);
    return cfg.servers[name];
  };
  if (!sub || sub === 'list') {
    for (const l of describeMcpConfig(cfg)) console.log(l);
    return 0;
  }
  if (sub === 'add' || sub === 'add-json' || sub === 'import') {
    let entries: Record<string, McpServerSpec>;
    let yes = false;
    let noTest = false;
    if (sub === 'add') {
      const parsed = parseMcpAdd(a);
      entries = { [parsed.name]: parsed.spec };
      ({ yes, noTest } = parsed);
      if (parsed.scope && parsed.scope !== 'user') console.log(`(--scope ${parsed.scope}: Dogent는 PC마다 설정이 하나라 사용자 설정에 더합니다)`);
    } else {
      yes = a.includes('--yes');
      noTest = a.includes('--no-test');
      const args = a.filter((x) => x !== '--yes' && x !== '--no-test');
      if (sub === 'add-json') {
        if (!args[0] || !args[1]) throw new Error("사용법: dogent mcp add-json <이름> '<JSON>'");
        entries = normalizeServers(JSON.parse(args.slice(1).join(' ')) as unknown, args[0]);
      } else {
        if (!args[0]) throw new Error('사용법: dogent mcp import <파일 경로 또는 주소>');
        entries = normalizeServers(await readJsonSource(args[0]), args[1]);
      }
    }
    if (!(await confirmInstall(entries, cfg.servers, yes))) {
      console.log('더하지 않았습니다');
      return 1;
    }
    Object.assign(cfg.servers, entries);
    console.log(`${saveMcpConfig(cfg)}에 저장했습니다`);
    return noTest ? 0 : await testInstalled(Object.keys(entries), cfg);
  }
  if (sub === 'browse' || sub === 'install') {
    const c = loadConfig();
    if (!c.mcpCatalogUrl) throw new Error('카탈로그 주소가 없습니다. dogent config mcpCatalogUrl <…/mcp/catalog.json 주소> (팀 스킬 주소가 있으면 그 옆 mcp/catalog.json을 씁니다)');
    const { servers, errors } = await fetchCatalog(c.mcpCatalogUrl, { token: c.mcpCatalogToken });
    for (const e of errors) console.log(`(건너뜀) ${e}`);
    if (sub === 'browse') {
      if (!servers.length) console.log('카탈로그가 비어 있습니다');
      for (const s of servers) console.log(describeCatalogServer(s, !!cfg.servers[s.id]));
      if (servers.length) console.log('\n더하려면: dogent mcp install <ID>');
      return 0;
    }
    const want = servers.find((s) => s.id === a[0]);
    if (!want) throw new Error(`카탈로그에 "${a[0] ?? ''}"이(가) 없습니다 (dogent mcp browse)`);
    console.log(`${want.name} — ${want.description}\n담당: ${want.owner}${want.writes ? ' · 바꾸는(쓰기) 도구가 있습니다' : ''}${want.notes ? `\n${want.notes}` : ''}`);
    const lack = missingEnv(want);
    if (lack.length) console.log(`(이 PC에 환경 변수 ${lack.join(', ')}이(가) 없습니다. 설치 뒤 설정해야 연결됩니다)`);
    const entries = { [want.id]: specOf(want) };
    const yes = a.includes('--yes');
    if (!(await confirmInstall(entries, cfg.servers, yes))) {
      console.log('더하지 않았습니다');
      return 1;
    }
    Object.assign(cfg.servers, entries);
    console.log(`${saveMcpConfig(cfg)}에 저장했습니다`);
    return a.includes('--no-test') || lack.length ? 0 : await testInstalled([want.id], cfg);
  }
  if (sub === 'remove') {
    need(a[0]);
    delete cfg.servers[a[0]];
    console.log(`${saveMcpConfig(cfg)}에서 뺐습니다`);
    return 0;
  }
  if (sub === 'on' || sub === 'off') {
    need(a[0]).disabled = sub === 'off';
    saveMcpConfig(cfg);
    console.log(sub === 'off' ? '껐습니다' : '켰습니다');
    return 0;
  }
  if (sub === 'allow' || sub === 'ask' || sub === 'deny') {
    if (!a[1]) throw new Error(MCP_USAGE);
    const spec = need(a[0]);
    (spec.permissions ??= {})[a[1]] = sub;
    saveMcpConfig(cfg);
    console.log(`${a[0]}의 ${a[1]}: ${sub}`);
    return 0;
  }
  if (sub === 'keyword') {
    const spec = need(a[0]);
    spec.keywords = a.slice(1);
    saveMcpConfig(cfg);
    console.log(`키워드: ${spec.keywords.join(', ') || '(없음)'}`);
    return 0;
  }
  if (sub === 'test') {
    const picked = { servers: Object.fromEntries(Object.entries(cfg.servers).filter(([n]) => !a[0] || n === a[0])) };
    if (a[0]) need(a[0]);
    const hub = await McpHub.open({ servers: Object.fromEntries(Object.entries(picked.servers).map(([n, s]) => [n, { ...s, disabled: false }])) }, (l) => console.log(`  ${l}`));
    try {
      for (const l of describeHub(hub)) console.log(l);
      return hub.failed.length ? 1 : 0;
    } finally {
      await hub.close();
    }
  }
  throw new Error(MCP_USAGE);
}

const AGENTS_USAGE = `사용법:
  dogent agents                              연결한 에이전트
  dogent agents add claude [--command <claude.exe 경로>] [--args "<인자 …>"] [--workdir <폴더>]
  dogent agents add opencode [--command <경로>] [--args "-m <제공자>/<모델>"] [--workdir <폴더>]
  dogent agents add <이름> --command <실행 파일> [--args "…"]   그 밖의 CLI 에이전트 (할 일을 stdin으로 받고 답을 stdout으로 내는 것)
  dogent agents test [<이름>]                 짧은 일을 맡겨 답이 오는지 본다
  dogent agents remove|on|off <이름>
  dogent agents allow|ask|deny <이름>          부를 때 묻지 않음 / 묻기(기본) / 금지`;

/** --이름 값 꼴의 옵션을 뽑는다 */
function takeOpt(a: string[], name: string): string | undefined {
  const i = a.indexOf(`--${name}`);
  if (i < 0) return undefined;
  const v = a[i + 1];
  a.splice(i, 2);
  return v;
}

async function runAgentsCommand(rest: string[], workdir: string): Promise<number> {
  const [sub, ...a] = rest;
  const cfg = loadAgents();
  const need = (name: string | undefined) => {
    if (!name || !cfg.agents[name]) throw new Error(`에이전트 "${name ?? ''}"이(가) 없습니다 (dogent agents)`);
    return cfg.agents[name];
  };
  if (!sub || sub === 'list') {
    for (const l of describeAgents(cfg, workdir)) console.log(l);
    return 0;
  }
  if (sub === 'add') {
    const name = a.shift();
    if (!name) throw new Error(AGENTS_USAGE);
    const command = takeOpt(a, 'command');
    const args = takeOpt(a, 'args');
    const dir = takeOpt(a, 'workdir');
    const kind: AgentSpec['kind'] = name === 'claude' || name === 'opencode' ? name : 'command';
    if (kind === 'command' && !command) throw new Error(`${name}: 미리 정한 에이전트(claude, opencode)가 아니면 --command <실행 파일>이 필요합니다`);
    const spec: AgentSpec = {
      kind,
      ...(command ? { command } : {}),
      ...(args ? { args: args.split(/\s+/).filter(Boolean) } : {}),
      ...(dir ? { workdir: dir } : {}),
      permission: cfg.agents[name]?.permission ?? 'ask',
    };
    const exe = findExecutable(command ?? (kind === 'command' ? '' : kind));
    console.log(`${name}: ${kind === 'command' ? command : PRESETS[kind].description}`);
    console.log(`  실행 파일: ${exe ?? '(이 PC에서 찾지 못함. 설치한 뒤 --command <경로>로 알려 주세요)'}`);
    console.log(`  할 일은 stdin으로 넘기고, 일할 폴더는 ${dir ?? workdir} 입니다. 부를 때마다 무엇을 맡기는지 보여 주고 묻습니다 (dogent agents allow ${name} 로 끔)`);
    cfg.agents[name] = spec;
    console.log(`${saveAgents(cfg)}에 저장했습니다`);
    return exe ? 0 : 1;
  }
  if (sub === 'remove') {
    need(a[0]);
    delete cfg.agents[a[0]];
    console.log(`${saveAgents(cfg)}에서 뺐습니다`);
    return 0;
  }
  if (sub === 'on' || sub === 'off') {
    need(a[0]).disabled = sub === 'off';
    saveAgents(cfg);
    console.log(sub === 'off' ? '껐습니다' : '켰습니다');
    return 0;
  }
  if (sub === 'allow' || sub === 'ask' || sub === 'deny') {
    need(a[0]).permission = sub;
    saveAgents(cfg);
    console.log(`${a[0]}: ${sub}`);
    return 0;
  }
  if (sub === 'test') {
    const names = a[0] ? [a[0]] : Object.keys(cfg.agents);
    if (!names.length) throw new Error('연결한 에이전트가 없습니다 (dogent agents add claude)');
    let failed = 0;
    for (const n of names) {
      const peer = new AgentPeer(n, { ...need(n), timeoutSec: 180 }, workdir, (l) => console.log(`  ${l}`));
      const r = await peer.ask('연결 시험입니다. 파일을 만들거나 고치지 말고 "연결됨" 한 단어만 답하세요.');
      console.log(`${n}: ${r.ok ? '연결됨' : '실패'} — ${r.text.split('\n')[0].slice(0, 200)}`);
      if (!r.ok) failed++;
    }
    return failed ? 1 : 0;
  }
  throw new Error(AGENTS_USAGE);
}

function parseArgs(argv: string[]): { args: string[]; flags: SessionOptions } {
  const flags: SessionOptions = { yes: false, allowWrite: false, dryRun: false, waitSec: 60, launchBrowser: true };
  const args: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--yes' || a === '-y') flags.yes = true;
    else if (a === '--allow-write') flags.allowWrite = true;
    else if (a === '--dry-run') flags.dryRun = true;
    else if (a === '--wait') flags.waitSec = Number(argv[++i]) || 60;
    else if (a === '--browser') flags.browser = argv[++i];
    else if (a === '--continue' || a === '-c') flags.conversation = 'continue';
    else args.push(a);
  }
  return { args, flags };
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
  if (cmd === 'doctor') {
    const ok = await runDoctor({
      waitSec: process.argv.includes('--wait') ? flags.waitSec : 15,
      fix: rest.includes('--fix'),
      ids: rest.flatMap((a, i) => (a === '--id' && rest[i + 1] ? [rest[i + 1]] : [])),
      print: (l) => console.log(l),
      version: __DOGENT_BUILD__.version,
    });
    return ok ? 0 : 1;
  }
  if (cmd === 'schedule') {
    const [sub, ...more] = rest;
    try {
    if (sub === 'add') console.log(`등록했습니다: ${addSchedule(parseSpec(more))}`);
    else if (sub === 'remove' && more[0]) (removeSchedule(more[0]), console.log('지웠습니다'));
    else if (sub === 'list') for (const n of listSchedules()) console.log(describeSchedule(n));
    else throw new Error('사용법: dogent schedule add|list|remove');
    return 0;
    } catch (e) {
      console.error(`오류: ${(e as Error).message}`);
      return 1;
    }
  }
  if (cmd === 'agents' || cmd === 'ask') {
    try {
      const workdir = loadConfig().outputDir;
      if (cmd === 'agents') return await runAgentsCommand(rest, workdir);
      const [name, ...task] = rest;
      const cfgA = loadAgents();
      const spec = name ? cfgA.agents[name] : undefined;
      if (!spec) throw new Error(`사용법: dogent ask <에이전트> "<할 일>"  (연결한 에이전트: ${Object.keys(cfgA.agents).join(', ') || '없음 — dogent agents add claude'})`);
      const r = await new AgentPeer(name, spec, workdir, (l) => console.error(l)).ask(task.join(' '));
      console.log(r.text);
      return r.ok ? 0 : 1;
    } catch (e) {
      console.error(`오류: ${(e as Error).message}`);
      return 1;
    }
  }
  if (cmd === 'memory') {
    const home = loadConfig().home;
    const file = personalInstructionsFile(home);
    if (rest[0] === 'add' && rest[1]) {
      console.log(`${addInstruction(home, rest.slice(1).join(' '))}에 더했습니다`);
      return 0;
    }
    if (rest[0] === 'edit') {
      if (!existsSync(file)) addInstruction(home, '(여기에 늘 지킬 것을 한 줄씩 적습니다)');
      spawnSync(process.env.DOGENT_EDITOR ?? (process.platform === 'win32' ? 'notepad' : 'vi'), [file], { stdio: 'inherit' });
      return 0;
    }
    console.log(existsSync(file) ? readFileSync(file, 'utf8') : `지침이 없습니다. dogent memory add "<늘 지킬 것>" 으로 더합니다 (${file})`);
    return 0;
  }
  if (cmd === 'mcp') {
    try {
      // -y, -e 같은 옵션이 서버에 넘길 인자일 수 있어 전역 옵션 해석을 거치지 않은 인자를 쓴다
      // (전역 옵션 --wait, --browser, --allow-write, --dry-run만 뺀다)
      const raw = process.argv.slice(2);
      const mine: string[] = [];
      for (let i = raw.indexOf('mcp') + 1; i < raw.length; i++) {
        if (raw[i] === '--wait' || raw[i] === '--browser') i++;
        else if (raw[i] !== '--allow-write' && raw[i] !== '--dry-run') mine.push(raw[i]);
      }
      return await runMcpCommand(mine);
    } catch (e) {
      console.error(`오류: ${(e as Error).message}`);
      return 1;
    }
  }
  const cfg = loadConfig();
  if (cmd === 'config') {
    if (rest.length >= 2) console.log(`${setConfig(rest[0], rest.slice(1).join(' '))}에 저장했습니다`);
    else console.log(describeConfig(loadConfig()));
    return 0;
  }
  if (cmd === 'check' && /SYSTEM\.md$/i.test(rest[0] ?? '')) {
    const r = lintSystem(readFileSync(rest[0], 'utf8'));
    console.log(r.errors.length ? '시스템 문서 검사: 오류' : '시스템 문서 검사: 통과');
    for (const m of r.errors) console.log(`  [error] ${m}`);
    for (const m of r.warnings) console.log(`  [warn] ${m}`);
    return r.errors.length ? 1 : 0;
  }
  if (cmd === 'check') {
    const policyFile = join(dirname(rest[0]), 'policy.yaml');
    const report = lintSkill(readFileSync(rest[0], 'utf8'), existsSync(policyFile) ? readFileSync(policyFile, 'utf8') : undefined, readScripts(dirname(rest[0])));
    console.log(`품질 검사: ${report.grade} (${report.score}점)`);
    for (const f of report.findings) console.log(`  [${f.level}] ${f.rule}${f.step ? ` ${f.step}단계` : ''}: ${f.message}`);
    return report.grade === 'F' ? 1 : 0;
  }
  if (cmd === 'sync' && !cfg.teamSkillsUrl && !cfg.systemsUrl && !cfg.hubUrl) {
    if (!cfg.teamSkills) {
      console.log('팀 스킬 저장소가 없습니다. dogent config teamSkillsUrl <index.json 주소> (git 없이), 또는 git clone한 폴더를 dogent config teamSkills <폴더> 로 알려 주세요');
      return 1;
    }
    execFileSync('git', ['-C', cfg.teamSkills, 'pull', '--ff-only'], { stdio: 'inherit' });
    return 0;
  }

  if (cmd === 'serve') {
    // 사람이 없는 곳에서 돌므로 실행 확인은 건너뛴다. 저장·상신 승인은 그대로 확장의 승인 창에서 사람이 한다
    flags.yes = true;
    flags.conversation ??= 'recent';
    const collector = new Collector();
    const session = new Session(collector, cfg, flags);
    const mcp = new DogentMcp(sessionRunner(() => session, flags, collector));
    const port = Number(takeOpt(rest, 'http') ?? 0);
    try {
      await session.listen();
    } catch (e) {
      console.error(`${(e as Error).message}\nDogent 앱이 켜져 있으면 dogent serve 대신 앱의 MCP 주소를 쓰세요: dogent config mcpServePort 39218 → 앱을 다시 켜고 http://127.0.0.1:39218/mcp`);
      return 1;
    }
    await session.refreshAll({ quiet: true }).catch(() => false);
    if (port) {
      await serveHttp(mcp, { port, token: loadToken(), log: (l) => console.error(l) });
      await new Promise(() => {});
    }
    await serveStdio(mcp);
    await session.close();
    return 0;
  }

  const term = new Terminal();
  const client = new Session(term, cfg, flags);
  client.help = HELP;
  process.on('SIGINT', () => {
    if (client.interrupt()) term.print('\n멈추는 중… (한 번 더 누르면 끝냅니다)');
    else {
      void client.close().finally(() => process.exit(130));
    }
  });
  try {
    if (cmd === 'sync') {
      if (cfg.teamSkills) execFileSync('git', ['-C', cfg.teamSkills, 'pull', '--ff-only'], { stdio: 'inherit' });
      return (await client.refreshAll({ force: true })) ? 0 : 1;
    }
    // 스킬을 쓰는 명령이면 팀 스킬 저장소를 받아 온다 (한 시간에 한 번, 닿지 않으면 받아 둔 것)
    if (!['excel', 'browsers', 'tabs'].includes(cmd ?? '')) await client.refreshAll({ quiet: true });
    if (cmd === 'systems') {
      if (rest[0] === 'info' && rest[1]) return client.systemInfo(rest[1]) ? 0 : 1;
      client.listSystems();
      return 0;
    }
    if (cmd === 'skills' && rest[0] === 'search') return (await client.searchSkills(rest.slice(1).join(' '))).length ? 0 : 1;
    if (cmd === 'skills' && rest[0] === 'info' && rest[1]) return client.skillInfo(rest[1]) ? 0 : 1;
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
    if (cmd === 'skill' && rest[0] === 'new') return (await client.composeSkill(rest.slice(1).join(' '))) ? 0 : 1;
    if (cmd === 'skill' && rest[0] === 'edit' && rest[1]) return (await client.editSkill(rest[1])) ? 0 : 1;
    if (cmd === 'skill') {
      term.print('사용법: dogent skill new ["<업무 설명>"] | dogent skill edit <스킬ID>');
      return 1;
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
// 원격 MCP 서버와 통신하거나 stdio 서버를 띄운 뒤 process.exit()를 부르면 윈도우에서 간헐적으로 libuv가 죽고(UV_HANDLE_CLOSING)
// 종료 코드가 127이 된다. 그런 실행은 남은 연결이 스스로 닫히며 끝나게 두고, 무엇이 붙잡고 있으면 5초 뒤에 끝낸다.
if (remoteMcpUsed() || stdioMcpUsed()) setTimeout(() => process.exit(), 5000).unref();
else process.exit();
