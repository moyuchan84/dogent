import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { lintSkill } from '../../src/core';
import { loadToken } from './bridge';
import { describeConfig, loadConfig, setConfig } from './config';
import { addSchedule, describeSchedule, listSchedules, parseSpec, removeSchedule } from './schedule';
import { Session, type SessionOptions } from './session';
import { Terminal } from './terminal';

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
  dogent schedule add <이름> --at 09:00 [--days 월,수,금] <스킬ID> [이름=값 …]   예약 실행 (매일, 또는 요일마다. 저장·상신은 하지 않는다)
  dogent schedule list|remove <이름>   예약 보기 / 지우기
  dogent token                    확장의 "클라이언트 연결"에 넣을 토큰
  dogent config [키 값]            설정 보기 / 바꾸기 (예: dogent config llm.userId sso123)

  --yes          실행 전 확인을 묻지 않는다
  --allow-write  자유 요청에서 저장·상신 버튼을 허용한다 (누르기 전에 확장의 승인 창으로 묻는다)
  --dry-run      저장·상신 직전에 멈춘다 (시험 실행)
  --wait <초>    확장이 연결되기를 기다리는 시간 (기본 60)
  --browser <이름>  브라우저가 여럿일 때 쓸 브라우저 (edge, chrome 또는 번호). 늘 쓰려면 dogent config browser edge

브라우저 쪽: Dogent 확장의 사이드 패널 → 설정 → 클라이언트 연결에서 WebSocket(또는 Native Messaging)을 켜고 토큰을 넣으세요.`;

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
  const client = new Session(term, cfg, flags);
  client.help = HELP;
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
