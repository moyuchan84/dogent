import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { SCRIPT_OUTPUT_MAX, type ScriptLang, type ScriptPort, type ScriptRequest, type ScriptRun } from '../../src/core';

/**
 * 스킬 스크립트를 이 PC에서 실행한다 (run_script, src/core/script.ts).
 *
 *   ~/.dogent/scripts/<해시>.mjs|.py    실행할 내용 (스킬 폴더의 파일을 그대로 옮긴 것)
 *   ~/.dogent/scripts/approved.json      사용자가 승인한 내용의 해시
 *
 * - Node는 이 프로그램의 Node(데스크탑 앱은 Electron의 Node)를 권한 모드로 띄운다. 스크립트 파일 하나만 읽을 수 있고,
 *   파일 쓰기·다른 파일 읽기·다른 프로그램 실행·워커는 막힌다. 네트워크는 막지 못한다.
 * - Python은 설치된 python(또는 py -3)을 -I(격리 모드)로 띄운다. 권한을 막을 방법이 없어 PC 권한 그대로 돈다.
 * - 빈 임시 폴더에서 실행하고 끝나면 지운다. 시간이 지나거나 중지하면 끊는다.
 */
export function localScripts(home: string): ScriptPort {
  const dir = join(home, 'scripts');
  const approvedFile = join(dir, 'approved.json');
  const readApproved = (): Record<string, { skill: string; file: string; at: string }> => {
    try {
      return existsSync(approvedFile) ? JSON.parse(readFileSync(approvedFile, 'utf8')) : {};
    } catch {
      return {};
    }
  };
  return {
    async approved(hash) {
      return hash in readApproved();
    },
    async remember(hash, info) {
      mkdirSync(dir, { recursive: true });
      writeFileSync(approvedFile, JSON.stringify({ ...readApproved(), [hash]: { ...info, at: new Date().toISOString() } }, null, 2));
    },
    sandbox(lang) {
      return lang === 'node' ? 'Node 권한 모드 (파일 읽기·쓰기와 다른 프로그램 실행이 막힘. 네트워크는 막지 못함)' : 'Python (막는 장치 없이 이 PC의 권한 그대로 실행됨)';
    },
    run: (req) => runScript(dir, req),
  };
}

let pythonCmd: string[] | null | undefined;
/** 설치된 Python을 찾는다. 없으면 null */
export function findPython(): string[] | null {
  if (pythonCmd !== undefined) return pythonCmd;
  const tries = process.platform === 'win32' ? [['py', '-3'], ['python'], ['python3']] : [['python3'], ['python']];
  for (const t of tries) {
    const r = spawnSync(t[0], [...t.slice(1), '--version'], { encoding: 'utf8', windowsHide: true, timeout: 5000 });
    // 윈도의 "앱 실행 별칭"(python.exe가 스토어를 여는 것)은 버전을 찍지 않는다
    if (r.status === 0 && /Python 3/.test(`${r.stdout}${r.stderr}`)) return (pythonCmd = t);
  }
  return (pythonCmd = null);
}

function command(lang: ScriptLang, file: string): { cmd: string; args: string[]; env: Record<string, string> } {
  if (lang === 'node') {
    // 데스크탑 앱은 Electron이라, Node로 돌게 한다
    const env: Record<string, string> = process.versions.electron ? { ELECTRON_RUN_AS_NODE: '1' } : {};
    return { cmd: process.execPath, args: ['--permission', `--allow-fs-read=${file}`, file], env };
  }
  const py = findPython();
  if (!py) throw new Error('이 PC에 Python 3이 없습니다. Python을 설치하거나 Node 스크립트(.mjs)로 바꾸세요');
  return { cmd: py[0], args: [...py.slice(1), '-I', '-X', 'utf8', file], env: { PYTHONIOENCODING: 'utf-8' } };
}

function runScript(dir: string, req: ScriptRequest): Promise<ScriptRun> {
  mkdirSync(dir, { recursive: true });
  const ext = req.lang === 'python' ? '.py' : '.mjs';
  const file = join(dir, `${req.skill}-${req.name}${ext}`);
  writeFileSync(file, req.code);
  const { cmd, args, env } = command(req.lang, file);
  const work = mkdtempSync(join(dir, 'run-'));
  return new Promise<ScriptRun>((resolve, reject) => {
    // 이 프로그램의 환경 변수 중 열쇠·토큰은 넘기지 않는다
    const base = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/(KEY|TOKEN|SECRET|PASSWORD)/i.test(k))) as Record<string, string>;
    const child = spawn(cmd, args, { cwd: work, env: { ...base, ...env }, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let tooBig = false;
    const stop = () => child.kill();
    const timer = setTimeout(() => {
      timedOut = true;
      stop();
    }, req.timeoutMs);
    req.signal?.addEventListener('abort', stop, { once: true });
    child.stdout.setEncoding('utf8').on('data', (c: string) => {
      stdout += c;
      if (stdout.length > SCRIPT_OUTPUT_MAX && !tooBig) {
        tooBig = true;
        stop();
      }
    });
    child.stderr.setEncoding('utf8').on('data', (c: string) => {
      if (stderr.length < 100_000) stderr += c;
    });
    const done = () => {
      clearTimeout(timer);
      req.signal?.removeEventListener('abort', stop);
      rmSync(work, { recursive: true, force: true });
    };
    child.on('error', (e) => {
      done();
      reject(new Error(`스크립트를 실행하지 못했습니다: ${e.message}`));
    });
    child.on('close', (code) => {
      done();
      if (req.signal?.aborted) return reject(new Error('중지됨'));
      if (tooBig) return resolve({ stdout, stderr: `${stderr}\n출력이 너무 커서 멈췄습니다`, code: code ?? 1 });
      resolve({ stdout, stderr, code: timedOut ? null : code, timedOut });
    });
    // 입력을 다 읽기 전에 끝나는 스크립트도 있다
    child.stdin.on('error', () => {});
    child.stdin.end(req.input);
  });
}
