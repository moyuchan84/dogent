import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer, connect } from 'node:net';
import { homedir, tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from 'ws';
import { REGISTRY_KEYS, findInstalledExtensions, registerNativeHost } from '../../bridge/register.mjs';
import { DEFAULT_PORT, NATIVE_HOST_NAME, pipePath } from '../../bridge/protocol.mjs';
import { openBridge } from './bridge';

/**
 * dogent doctor — 확장이 클라이언트에 붙지 않을 때 원인을 찾는다.
 *
 * 클라이언트와 확장은 두 길로 이어진다.
 *   WebSocket         확장이 ws://127.0.0.1:<포트>로 붙는다. 토큰이 맞아야 한다.
 *   Native Messaging  브라우저가 호스트(~/.dogent/native-host.cmd)를 띄우고, 호스트가 클라이언트의 파이프에 붙는다.
 *                     호스트가 레지스트리에 등록되어 있어야 하고, 회사 정책이 막으면 안 된다.
 * 터미널 클라이언트는 호스트를 등록하지 않는다 (등록은 데스크탑 앱이 하거나 doctor --fix가 한다).
 *
 * 아래 판정 함수들은 레지스트리와 파일을 직접 읽지 않아 시험할 수 있다.
 */
export type Level = 'ok' | 'warn' | 'error' | 'info';
export interface Finding {
  level: Level;
  text: string;
  /** 어떻게 하면 되는지 */
  hint?: string;
}

const MARK: Record<Level, string> = { ok: '[통과]', warn: '[주의]', error: '[오류]', info: '[참고]' };

export function printFinding(f: Finding, print: (line: string) => void): void {
  print(`  ${MARK[f.level]} ${f.text}`);
  if (f.hint) for (const line of f.hint.split('\n')) print(`         ${line}`);
}

// ---- 레지스트리 ----

const REG = join(process.env.SystemRoot ?? 'C:/Windows', 'System32', 'reg.exe');

/** `reg query` 출력의 값들을 이름 → 데이터로 읽는다. 기본값의 이름은 (기본값)/(Default)로 나온다. */
export function parseRegValues(output: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const line of output.split(/\r?\n/)) {
    const m = /^\s{2,}(.+?)\s{2,}(REG_[A-Z_]+)(?:\s{2,}(.*))?\s*$/.exec(line);
    if (m) values[m[1]] = (m[3] ?? '').trim();
  }
  return values;
}

/** 키의 값들. 키가 없으면 null */
export function queryReg(key: string): Record<string, string> | null {
  try {
    return parseRegValues(execFileSync(REG, ['query', key], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }));
  } catch {
    return null;
  }
}

/** 키의 기본값(이름 없는 값). 없으면 null */
export function queryRegDefault(key: string): string | null {
  try {
    const values = parseRegValues(execFileSync(REG, ['query', key, '/ve'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }));
    const v = Object.values(values)[0];
    return v === undefined ? null : v;
  } catch {
    return null;
  }
}

export interface PolicyValues {
  /** NativeMessagingUserLevelHosts. 0이면 사용자 수준(HKCU) 등록을 쓰지 못한다 */
  userLevelHosts?: number;
  blocklist: string[];
  allowlist: string[];
}

/** 크롬·엣지 정책(HKLM, HKCU)에서 Native Messaging 관련 값을 읽는다 */
export function readPolicy(vendor: 'Google\\Chrome' | 'Microsoft\\Edge', read: (key: string) => Record<string, string> | null = queryReg): PolicyValues {
  const out: PolicyValues = { blocklist: [], allowlist: [] };
  for (const hive of ['HKLM', 'HKCU']) {
    const base = `${hive}\\Software\\Policies\\${vendor}`;
    const top = read(base);
    const level = top?.NativeMessagingUserLevelHosts;
    if (level !== undefined) out.userLevelHosts = Number(level);
    out.blocklist.push(...Object.values(read(`${base}\\NativeMessagingBlocklist`) ?? {}));
    out.allowlist.push(...Object.values(read(`${base}\\NativeMessagingAllowlist`) ?? {}));
  }
  return out;
}

/** 정책이 Dogent 호스트를 막는지 */
export function judgePolicy(name: string, p: PolicyValues, host = NATIVE_HOST_NAME): Finding[] {
  const out: Finding[] = [];
  const blocked = (p.blocklist.includes('*') || p.blocklist.includes(host)) && !p.allowlist.includes(host);
  if (blocked) {
    out.push({
      level: 'error',
      text: `${name} 정책이 Native Messaging 호스트를 막고 있습니다 (NativeMessagingBlocklist${p.blocklist.includes('*') ? ' = *' : ''}, 허용 목록에 ${host} 없음)`,
      hint: `보안 부서에 NativeMessagingAllowlist에 ${host}를 더해 달라고 요청하거나, 확장의 연결 방식을 WebSocket으로 바꾸세요 (토큰: dogent token).`,
    });
  }
  if (p.userLevelHosts === 0) {
    out.push({
      level: 'error',
      text: `${name} 정책이 사용자 수준 Native Messaging 등록을 막고 있습니다 (NativeMessagingUserLevelHosts = 0)`,
      hint: 'Dogent는 현재 사용자(HKCU)에 호스트를 등록하므로 이 정책에서는 쓰이지 않습니다. 확장의 연결 방식을 WebSocket으로 바꾸세요 (토큰: dogent token). Native Messaging이 꼭 필요하면 관리자가 컴퓨터 수준(HKLM)에 등록해야 합니다.',
    });
  }
  if (!out.length) out.push({ level: 'ok', text: `${name} 정책이 Native Messaging을 막지 않습니다` });
  return out;
}

// ---- 호스트 등록 ----

/** 호스트 매니페스트가 가리키는 것을 점검한다. installed는 프로필에서 찾은 Dogent 확장 ID */
export function judgeManifest(manifest: unknown, installed: string[], exists: (path: string) => boolean): Finding[] {
  const m = manifest as { name?: string; path?: string; allowed_origins?: string[] } | null;
  const out: Finding[] = [];
  if (!m || typeof m !== 'object') return [{ level: 'error', text: '호스트 매니페스트(com.dogent.bridge.json)를 읽을 수 없습니다', hint: 'dogent doctor --fix 로 다시 등록하세요' }];
  if (m.name !== NATIVE_HOST_NAME) out.push({ level: 'error', text: `매니페스트의 name이 ${NATIVE_HOST_NAME}이(가) 아닙니다 (${m.name ?? '없음'})` });
  if (!m.path || !exists(m.path)) out.push({ level: 'error', text: `매니페스트가 가리키는 실행 파일이 없습니다: ${m.path ?? '(없음)'}`, hint: 'dogent doctor --fix 로 다시 등록하세요' });
  const allowed = (m.allowed_origins ?? []).map((o) => o.replace(/^chrome-extension:\/\/|\/$/g, ''));
  if (!allowed.length) out.push({ level: 'error', text: '허용한 확장 ID가 없습니다' });
  for (const id of installed) {
    if (!allowed.includes(id)) {
      out.push({
        level: 'error',
        text: `프로필에서 찾은 Dogent 확장(${id})이 허용 목록에 없습니다. 허용된 ID: ${allowed.join(', ') || '없음'}`,
        hint: '확장을 다른 폴더에서 다시 로드하면 확장 ID가 바뀝니다. dogent doctor --fix 가 지금 확장 ID를 더해 등록합니다.',
      });
    }
  }
  return out;
}

/** native-host.cmd에서 호스트를 돌릴 실행 파일과 스크립트 경로를 꺼낸다 */
export function parseLauncher(source: string): { runtime: string; script: string } | null {
  const line = source.split(/\r?\n/).find((l) => /^"[^"]+"\s+"[^"]+"/.test(l.trim()));
  const m = line ? /^"([^"]+)"\s+"([^"]+)"/.exec(line.trim()) : null;
  return m ? { runtime: m[1], script: m[2] } : null;
}

// ---- 포트와 파이프 ----

export type PortState = { free: true } | { free: false; pid?: number; process?: string; dogent: boolean };

function canListen(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = createServer();
    s.once('error', () => resolve(false));
    s.listen(port, '127.0.0.1', () => s.close(() => resolve(true)));
  });
}

/** 그 포트에서 듣는 프로세스 (Windows). 못 찾으면 빈 값 */
function listener(port: number): { pid?: number; process?: string } {
  try {
    const out = execFileSync('netstat', ['-ano', '-p', 'TCP'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    const line = out.split(/\r?\n/).find((l) => new RegExp(`:${port}\\s+\\S+\\s+LISTENING\\s+\\d+`).test(l));
    const pid = line ? Number(/(\d+)\s*$/.exec(line.trim())?.[1]) : NaN;
    if (!pid) return {};
    const task = execFileSync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    return { pid, process: /^"([^"]+)"/.exec(task.trim())?.[1] };
  } catch {
    return {};
  }
}

/** 포트에 붙어 Dogent 브리지의 인사(challenge)를 받는지 */
function isDogentHub(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v: boolean) => {
      if (done) return;
      done = true;
      try {
        ws.terminate();
      } catch {
        /* 이미 닫힘 */
      }
      resolve(v);
    };
    const ws = new WebSocket(`ws://127.0.0.1:${port}`, { headers: { origin: 'chrome-extension://doctor' } });
    ws.on('message', (d) => finish(String(d).includes('"challenge"')));
    ws.on('error', () => finish(false));
    ws.on('close', () => finish(false));
    setTimeout(() => finish(false), 2000);
  });
}

export async function portState(port: number): Promise<PortState> {
  if (await canListen(port)) return { free: true };
  return { free: false, ...listener(port), dogent: await isDogentHub(port) };
}

/** 브리지의 파이프(Native Messaging 호스트가 붙는 곳)가 열려 있는지 = Dogent가 실행 중인지 */
export function pipeOpen(path = process.env.DOGENT_BRIDGE_PIPE ?? pipePath(userInfo().username)): Promise<boolean> {
  return new Promise((resolve) => {
    const s = connect(path);
    const timer = setTimeout(() => (s.destroy(), resolve(false)), 1500);
    s.on('connect', () => (clearTimeout(timer), s.destroy(), resolve(true)));
    s.on('error', () => (clearTimeout(timer), resolve(false)));
  });
}

/** 호스트를 브라우저가 띄우듯 띄워 첫 메시지(4바이트 길이 + JSON)가 오는지 본다 */
export function probeHost(launcher: string, ms = 5000): Promise<{ ok: boolean; message?: unknown; error?: string }> {
  return new Promise((resolve) => {
    const child = spawn('cmd.exe', ['/c', launcher], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    let buf = Buffer.alloc(0);
    let stderr = '';
    const end = (r: { ok: boolean; message?: unknown; error?: string }) => {
      clearTimeout(timer);
      child.kill();
      resolve(r);
    };
    const timer = setTimeout(() => end({ ok: false, error: `${ms / 1000}초 안에 응답이 없습니다${stderr ? `: ${stderr.trim().slice(0, 200)}` : ''}` }), ms);
    child.stdout.on('data', (d: Buffer) => {
      buf = Buffer.concat([buf, d]);
      if (buf.length >= 4 && buf.length >= 4 + buf.readUInt32LE(0)) {
        try {
          end({ ok: true, message: JSON.parse(buf.subarray(4, 4 + buf.readUInt32LE(0)).toString('utf8')) });
        } catch {
          end({ ok: false, error: '호스트가 JSON이 아닌 응답을 보냈습니다' });
        }
      }
    });
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', (e) => end({ ok: false, error: e.message }));
    child.on('exit', (code) => end({ ok: false, error: `호스트가 바로 끝났습니다 (코드 ${code})${stderr ? `: ${stderr.trim().slice(0, 200)}` : ''}` }));
  });
}

// ---- 점검 ----

const dogentDir = () => join(homedir(), '.dogent');

export interface DoctorOptions {
  port?: number;
  /** 실시간 시험에서 기다릴 초. 0이면 시험하지 않는다 */
  waitSec: number;
  /** 호스트 등록을 새로 한다 */
  fix: boolean;
  /** 허용에 더할 확장 ID */
  ids: string[];
  print: (line: string) => void;
  version: string;
}

/** 클라이언트에 넣어 둔 호스트 파일(__DOGENT_HOST__)로 호스트를 등록한다 */
export function fixRegistration(ids: string[], print: (line: string) => void): boolean {
  const found = findInstalledExtensions();
  const all = [...new Set([...found.map((f) => f.id), ...ids])];
  if (!all.length) {
    print('  [오류] 허용할 Dogent 확장을 찾지 못했습니다.');
    print('         chrome://extensions(엣지는 edge://extensions)에서 개발자 모드를 켜고 Dogent의 ID(영문 32자)를 확인해 다음처럼 실행하세요:');
    print('         dogent doctor --fix --id <확장 ID>');
    return false;
  }
  const dir = mkdtempSync(join(tmpdir(), 'dogent-host-'));
  mkdirSync(dir, { recursive: true });
  for (const [name, source] of Object.entries(__DOGENT_HOST__)) writeFileSync(join(dir, name), source);
  try {
    const r = registerNativeHost({ ids: all, runtime: process.execPath, hostDir: dir, log: (l) => print(`  ${l}`) });
    print(`  [통과] 호스트를 등록했습니다 (허용 확장 ${r.ids.length}개, 실행 ${process.execPath})`);
    print('         브라우저의 Dogent 사이드 패널 → 설정 → 클라이언트 연결 → 방식 Native Messaging → "연결 설정 저장"을 한 번 누르면 바로 다시 붙습니다.');
    print('         (누르지 않아도 1분 안에 스스로 다시 시도합니다)');
    return true;
  } catch (e) {
    print(`  [오류] 등록하지 못했습니다: ${(e as Error).message}`);
    return false;
  }
}

/** 점검을 돌려 찾은 것을 모두 돌려준다. 오류가 있으면 false */
export async function runDoctor(opts: DoctorOptions): Promise<boolean> {
  const { print } = opts;
  const port = opts.port ?? Number(process.env.DOGENT_BRIDGE_PORT ?? DEFAULT_PORT);
  const findings: Finding[] = [];
  const add = (...f: Finding[]) => {
    for (const x of f) {
      findings.push(x);
      printFinding(x, print);
    }
  };
  const section = (title: string) => print(`\n${title}`);

  print(`Dogent 연결 점검 (클라이언트 ${opts.version}, Node ${process.version}, ${process.platform})`);

  if (opts.fix) {
    section('호스트 등록');
    if (process.platform !== 'win32') print('  [오류] 지금은 Windows만 지원합니다');
    else if (!fixRegistration(opts.ids, print)) findings.push({ level: 'error', text: '등록하지 못했습니다' });
  }

  // 1. 토큰
  section('1. 토큰 (WebSocket 연결에 필요)');
  const tokenFile = join(dogentDir(), 'bridge-token');
  if (existsSync(tokenFile)) {
    const t = readFileSync(tokenFile, 'utf8').trim();
    add({ level: 'ok', text: `토큰 파일이 있습니다 (${tokenFile}, ${t.slice(0, 4)}…, ${t.length}자)`, hint: 'WebSocket 방식이면 확장 설정에 dogent token 의 값을 그대로 넣으세요. Native Messaging 방식은 토큰이 자동으로 전달됩니다.' });
  } else {
    add({ level: 'info', text: `토큰 파일이 아직 없습니다 (${tokenFile})`, hint: '클라이언트를 한 번 실행하면 만들어집니다. dogent token 으로도 만들 수 있습니다.' });
  }

  // 2. 포트와 파이프
  section(`2. 이 PC의 포트 ${port}와 파이프`);
  const ps = await portState(port);
  const piped = await pipeOpen();
  if (ps.free) {
    add({ level: 'ok', text: `포트 ${port}이(가) 비어 있습니다` });
  } else if (ps.dogent) {
    add({
      level: 'warn',
      text: `포트 ${port}을(를) 이미 Dogent 브리지가 쓰고 있습니다${ps.process ? ` (${ps.process}, PID ${ps.pid})` : ''}`,
      hint: '데스크탑 앱, 다른 터미널의 dogent, Claude Code 중 하나가 이미 떠 있습니다. 확장은 그쪽에 붙습니다. 하나만 남기고 닫으세요. 이 점검의 실시간 시험은 건너뜁니다.',
    });
  } else {
    add({
      level: 'error',
      text: `포트 ${port}을(를) 다른 프로그램이 쓰고 있습니다${ps.process ? ` (${ps.process}, PID ${ps.pid})` : ''}`,
      hint: '그 프로그램을 닫거나 dogent config bridgePort <다른 번호> 로 포트를 바꾸고, 확장 설정의 포트도 같게 하세요.',
    });
  }
  if (piped && ps.free) add({ level: 'warn', text: '파이프는 열려 있는데 포트는 비어 있습니다. Dogent가 떠 있는 중일 수 있습니다' });
  else if (piped) add({ level: 'info', text: 'Native Messaging 파이프가 열려 있습니다 (Dogent가 실행 중)' });

  // 3. 확장
  section('3. 브라우저에 설치된 Dogent 확장');
  const installed = process.platform === 'win32' ? findInstalledExtensions() : [];
  if (installed.length) {
    for (const f of installed) add({ level: 'ok', text: `${f.browser} 프로필 "${f.profile}"에 Dogent 확장이 있습니다 (ID ${f.id})` });
  } else {
    add({
      level: 'warn',
      text: '크롬·엣지 프로필에서 Dogent 확장을 찾지 못했습니다',
      hint: '압축해제로 로드한 확장만 찾을 수 있습니다. 확장 관리 화면에서 Dogent가 켜져 있는지, 브라우저를 한 번 이상 껐다 켰는지 보세요. 설치돼 있다면 dogent doctor --fix --id <확장 ID> 로 직접 알려 줄 수 있습니다.',
    });
  }
  const installedIds = installed.map((f) => f.id);

  // 4. Native Messaging
  let nmRegistered = process.platform !== 'win32';
  if (process.platform === 'win32') {
    section('4. Native Messaging 호스트 등록');
    let registered = false;
    for (const [name, key] of Object.entries(REGISTRY_KEYS)) {
      if (name === 'chromium') continue;
      const path = queryRegDefault(`${key}\\${NATIVE_HOST_NAME}`);
      if (path === null) {
        add({ level: name === 'chrome' || name === 'edge' ? 'info' : 'info', text: `${name}: 등록되어 있지 않습니다 (HKCU)` });
        continue;
      }
      registered = true;
      add({ level: 'ok', text: `${name}: 등록되어 있습니다 → ${path}` });
      if (!existsSync(path)) {
        add({ level: 'error', text: `${name}: 매니페스트 파일이 없습니다: ${path}`, hint: 'dogent doctor --fix 로 다시 등록하세요' });
        continue;
      }
      try {
        add(...judgeManifest(JSON.parse(readFileSync(path, 'utf8')), installedIds, existsSync));
      } catch {
        add({ level: 'error', text: `${name}: 매니페스트가 올바른 JSON이 아닙니다`, hint: 'dogent doctor --fix 로 다시 등록하세요' });
      }
    }
    nmRegistered = registered;
    if (!registered) {
      add({
        level: 'warn',
        text: '크롬·엣지 어디에도 호스트가 등록되어 있지 않습니다. 확장을 Native Messaging 방식으로 쓸 때만 문제입니다 (WebSocket 방식은 등록이 필요 없습니다)',
        hint: '터미널 dogent는 호스트를 등록하지 않습니다 (데스크탑 앱이 처음 실행할 때 합니다).\n지금 등록하려면: dogent doctor --fix\nWebSocket으로 쓰려면 확장 설정의 방식을 WebSocket으로 바꾸고 dogent token 의 값을 넣으세요.',
      });
    }

    // 호스트가 실제로 뜨는지
    const launcher = join(dogentDir(), 'native-host.cmd');
    if (existsSync(launcher)) {
      const parsed = parseLauncher(readFileSync(launcher, 'utf8'));
      if (!parsed) {
        add({ level: 'error', text: 'native-host.cmd의 내용을 읽을 수 없습니다', hint: 'dogent doctor --fix 로 다시 등록하세요' });
      } else {
        if (!existsSync(parsed.runtime)) add({ level: 'error', text: `호스트를 돌릴 프로그램이 없습니다: ${parsed.runtime}`, hint: '앱이나 Node를 옮기거나 지웠습니다. dogent doctor --fix 로 다시 등록하세요.' });
        if (!existsSync(parsed.script)) add({ level: 'error', text: `호스트 스크립트가 없습니다: ${parsed.script}`, hint: 'dogent doctor --fix 로 다시 등록하세요' });
        else add({ level: 'info', text: `호스트: ${parsed.runtime} ${parsed.script}` });
      }
      const probe = await probeHost(launcher);
      if (probe.ok) {
        add({ level: 'ok', text: `호스트가 브라우저처럼 띄우면 응답합니다 (${JSON.stringify(probe.message).slice(0, 120)})` });
      } else {
        add({ level: 'error', text: `호스트를 띄워 보니 응답하지 않습니다: ${probe.error}`, hint: '위의 실행 파일·스크립트 경로를 확인하고 dogent doctor --fix 를 다시 실행하세요.' });
      }
    }

    // 정책
    section('5. 회사 정책 (크롬·엣지)');
    add(...judgePolicy('크롬', readPolicy('Google\\Chrome')));
    add(...judgePolicy('엣지', readPolicy('Microsoft\\Edge')));
  }

  // 6. 실시간 시험
  section('6. 실시간 시험 (확장이 이 브리지에 붙는지)');
  if (opts.waitSec <= 0) {
    add({ level: 'info', text: '건너뜁니다 (--wait 0)' });
  } else if (!ps.free) {
    add({ level: 'info', text: `포트 ${port}을(를) 이미 쓰고 있어 건너뜁니다. 위의 항목을 해결한 뒤 다시 실행하세요` });
  } else if (piped) {
    add({ level: 'info', text: '다른 Dogent가 실행 중이라 건너뜁니다' });
  } else {
    const log: string[] = [];
    try {
      const bridge = await openBridge({ port, log: (l) => log.push(l) });
      print(`  브라우저의 확장이 붙기를 ${opts.waitSec}초 기다립니다… (브라우저를 열어 두세요. 확장이 다시 붙는 데 최대 1분 걸릴 수 있습니다)`);
      const ok = await bridge.waitForExtension(opts.waitSec * 1000);
      if (ok) {
        const b = bridge.browsers();
        add({ level: 'ok', text: `확장이 붙었습니다: ${b.map((x) => `${x.browser} (${x.via})`).join(', ')}` });
      } else {
        const reasons = log.filter((l) => /토큰|끊|확인을 마치지/.test(l));
        const reached = log.filter((l) => /Native Messaging|WebSocket/.test(l));
        if (reasons.length) {
          add({ level: 'error', text: '확장이 닿았지만 연결이 거절됐습니다', hint: `${[...new Set(reasons)].join('\n')}\nWebSocket 방식이면 확장 설정의 토큰을 dogent token 의 값으로 다시 넣고 저장하세요.` });
        } else if (reached.length) {
          add({ level: 'warn', text: '확장 쪽 길이 열렸지만 확인 절차를 마치지 못했습니다', hint: [...new Set(reached)].join('\n') });
        } else {
          const blocking = findings.some((f) => f.level === 'error');
          add({
            level: 'error',
            text: `${opts.waitSec}초 동안 확장이 이 브리지에 닿지 않았습니다`,
            hint: [
              blocking ? '위의 [오류] 항목을 먼저 해결하세요.' : '위 점검에서 막힌 곳이 없다면 확장 쪽 설정을 확인하세요.',
              nmRegistered ? '' : '확장을 Native Messaging 방식으로 두었다면, 호스트가 등록되어 있지 않은 것(4번 항목)이 원인일 가능성이 가장 큽니다: dogent doctor --fix',
              '브라우저의 Dogent 사이드 패널 → 설정 → 클라이언트 연결에서 방식과 상태 문구를 보세요:',
              ' · "Native Messaging 호스트가 설치되지 않았습니다" → dogent doctor --fix',
              ' · "ws://127.0.0.1:... 에 닿지 않습니다" → 포트(2번 항목)와 방식이 WebSocket인지',
              ' · 연결 방식을 바꾸거나 등록한 뒤에는 "연결 설정 저장"을 다시 눌러야 바로 다시 붙습니다',
            ]
              .filter(Boolean)
              .join('\n'),
          });
        }
      }
      bridge.close();
    } catch (e) {
      add({ level: 'error', text: `시험용 브리지를 열지 못했습니다: ${(e as Error).message}` });
    }
  }

  const errors = findings.filter((f) => f.level === 'error').length;
  const warns = findings.filter((f) => f.level === 'warn').length;
  print(`\n결과: ${errors ? `오류 ${errors}개` : '오류 없음'}${warns ? `, 주의 ${warns}개` : ''}`);
  if (errors && !opts.fix && findings.some((f) => /--fix/.test(f.hint ?? ''))) print('호스트 등록 문제는 dogent doctor --fix 로 고칠 수 있습니다.');
  return errors === 0;
}
