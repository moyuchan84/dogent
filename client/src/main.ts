import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { lintSkill, lintSystem } from '../../src/core';
import { runDoctor } from './doctor';
import { loadToken } from './bridge';
import { describeConfig, loadConfig, setConfig } from './config';
import { McpHub, describeHub, describeMcpConfig, loadMcpConfig, saveMcpConfig, type McpServerSpec } from './mcp-hub';
import { remoteMcpUsed } from './mcp-http';
import { stdioMcpUsed } from './mcp-stdio';
import { describeInstall, normalizeServers, parseMcpAdd } from './mcp-install';
import { addSchedule, describeSchedule, listSchedules, parseSpec, removeSchedule } from './schedule';
import { Session, type SessionOptions } from './session';
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
  dogent sync                     팀 스킬 저장소를 받는다 (teamSkillsUrl이면 주소로, teamSkills 폴더면 git pull)
  dogent tabs                     브라우저 탭 목록
  dogent browsers                 Dogent 확장이 연결된 브라우저 (크롬, 엣지 …). 대화 중에는 browser edge 로 바꿈
  dogent excel <파일|열린 문서 이름>   Excel로 열어 시트와 앞부분을 보여 준다 (문서 보안 문서 확인)
  dogent excel docs               사용자의 Excel에 열린 문서 (문서 공유망에서 연 문서 등)
  dogent excel resave <원본> <새 경로>   Excel로 다시 저장 (문서 보안이 다시 암호화하는지 확인)
  dogent mcp [list|add|remove|test|allow|ask|deny|keyword|on|off]
                                  MCP 서버 연결 (사내 시스템 도구를 에이전트가 부른다). 설정은 ~/.dogent/mcp.json
  dogent schedule add <이름> --at 09:00 [--days 월,수,금] <스킬ID> [이름=값 …]   예약 실행 (매일, 또는 요일마다. 저장·상신은 하지 않는다)
  dogent schedule list|remove <이름>   예약 보기 / 지우기
  dogent doctor [--fix] [--id <확장 ID>] [--wait <초>]
                                  확장이 안 붙을 때 원인 점검 (토큰, 포트, Native Messaging 등록, 회사 정책, 실시간 시험). --fix는 호스트를 등록한다
  dogent token                    확장의 "클라이언트 연결"에 넣을 토큰
  dogent config [키 값]            설정 보기 / 바꾸기 (예: dogent config llm.userId sso123)

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
  dogent mcp off|on <이름>                  서버 끄기 / 켜기`;

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

function parseArgs(argv: string[]): { args: string[]; flags: SessionOptions } {
  const flags: SessionOptions = { yes: false, allowWrite: false, dryRun: false, waitSec: 60 };
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
    const report = lintSkill(readFileSync(rest[0], 'utf8'));
    console.log(`품질 검사: ${report.grade} (${report.score}점)`);
    for (const f of report.findings) console.log(`  [${f.level}] ${f.rule}${f.step ? ` ${f.step}단계` : ''}: ${f.message}`);
    return report.grade === 'F' ? 1 : 0;
  }
  if (cmd === 'sync' && !cfg.teamSkillsUrl) {
    if (!cfg.teamSkills) {
      console.log('팀 스킬 저장소가 없습니다. dogent config teamSkillsUrl <index.json 주소> (git 없이), 또는 git clone한 폴더를 dogent config teamSkills <폴더> 로 알려 주세요');
      return 1;
    }
    execFileSync('git', ['-C', cfg.teamSkills, 'pull', '--ff-only'], { stdio: 'inherit' });
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
      return (await client.refreshTeam({ force: true })) ? 0 : 1;
    }
    // 스킬을 쓰는 명령이면 팀 스킬 저장소를 받아 온다 (한 시간에 한 번, 닿지 않으면 받아 둔 것)
    if (!['excel', 'browsers', 'tabs'].includes(cmd ?? '')) await client.refreshTeam({ quiet: true });
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
