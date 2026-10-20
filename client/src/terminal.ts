import { createInterface } from 'node:readline';
import type { ApprovalRequest, RunEvent, RunResult } from '../../src/core';

/**
 * 터미널 입출력. 입력은 줄 단위로 줄을 세워 두고 물을 때 하나씩 꺼낸다.
 * 그래서 파이프로 답을 미리 넣어 두어도(시험·자동화) 순서대로 읽힌다.
 */
export class Terminal {
  private lines: string[] = [];
  private waiting: ((line: string | null) => void)[] = [];
  private closed = false;

  constructor(
    input: NodeJS.ReadableStream = process.stdin,
    private out: NodeJS.WritableStream = process.stdout,
  ) {
    const rl = createInterface({ input, terminal: false });
    rl.on('line', (line) => {
      const w = this.waiting.shift();
      if (w) w(line);
      else this.lines.push(line);
    });
    rl.on('close', () => {
      this.closed = true;
      for (const w of this.waiting.splice(0)) w(null);
    });
  }

  print(text = ''): void {
    this.out.write(`${text}\n`);
  }

  /** 한 줄을 묻는다. 입력이 끝났으면 null */
  async ask(question: string): Promise<string | null> {
    this.out.write(question);
    if (this.lines.length) {
      const line = this.lines.shift()!;
      if (!(process.stdin as { isTTY?: boolean }).isTTY) this.out.write(`${line}\n`);
      return line;
    }
    if (this.closed) {
      this.out.write('\n');
      return null;
    }
    return new Promise((resolve) => this.waiting.push(resolve));
  }

  /** 예/아니오. 빈 답은 기본값 */
  async confirm(question: string, fallback: boolean): Promise<boolean> {
    const a = (await this.ask(`${question} ${fallback ? '(Y/n)' : '(y/N)'} `))?.trim().toLowerCase() ?? '';
    if (a === '') return fallback;
    return ['y', 'yes', 'ㅇ', '예', '네', '응'].includes(a);
  }

  /** 기본값이 있는 질문. 빈 답이면 기본값 */
  async askDefault(question: string, fallback: string): Promise<string> {
    const a = (await this.ask(fallback ? `${question} [${fallback}]: ` : `${question}: `))?.trim() ?? '';
    return a === '' ? fallback : a;
  }
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);

/** 실행 중 일을 한 줄씩 보여 준다 (사이드 패널의 진행 목록과 같은 내용). */
export function describeEvent(e: RunEvent): string | null {
  switch (e.type) {
    case 'action': {
      const h = e.entry;
      const by = h.by === 'skill' ? ' (모델 호출 없음)' : h.by === 'cache' ? ' (기억한 경로)' : '';
      return `  ${h.ok ? '·' : '✗'} 단계 ${h.step} ${h.tool} ${clip(JSON.stringify(h.args), 70)}${by}\n      → ${clip(h.result.replace(/\s+/g, ' '), 110)}`;
    }
    case 'step_done':
      return `  단계 ${e.step} 확인됨`;
    case 'sub_start':
      return `  ▶ 스킬 ${e.name}(${e.skill}) 실행 ${clip(JSON.stringify(e.inputs), 70)}`;
    case 'sub_action': {
      const h = e.entry;
      return `      ${h.ok ? '·' : '✗'} [${e.skill}] 단계 ${h.step} ${h.tool} → ${clip(h.result.replace(/\s+/g, ' '), 90)}`;
    }
    case 'sub_end':
      return `  ◀ 스킬 ${e.skill} ${e.status === 'done' ? '끝남' : e.status}: ${clip(e.message.replace(/\s+/g, ' '), 110)}`;
    case 'approval':
      return `  "${e.request.button}" ${e.dryRun ? '직전에 멈춤 (시험 실행)' : e.approved ? '승인됨' : '승인하지 않음'}`;
    case 'login_wait':
      return `\n  로그인이 필요합니다: ${e.url}\n  브라우저의 그 탭에서 직접 로그인해 주세요. 로그인되면 이어서 진행합니다 (Dogent는 비밀번호를 입력하지 않습니다).\n`;
    case 'login_done':
      return '  로그인됨, 이어서 진행';
    case 'llm_retry': {
      const said = e.raw ? `\n      모델 응답: ${clip(e.raw.replace(/\s+/g, ' '), 110)}` : '';
      return `  모델 응답 형식 오류, 다시 요청: ${clip(e.reason.split('\n')[0], 120)}${said}`;
    }
    case 'blocked':
      return `  막힘: ${e.tool} — ${e.reason}`;
    default:
      return null;
  }
}

/** 승인 직전에 터미널에도 무엇을 승인하는지 보여 준다. 실제 승인은 확장의 승인 창에서 한다. */
export function describeApproval(r: ApprovalRequest): string {
  const fields = r.fields.map((f) => `    ${f.name}: ${f.value || '(비어 있음)'}`).join('\n');
  const tables = r.tables.map((t) => `    표 ${t.name}: ${t.rowCount}행`).join('\n');
  return `\n  "${r.button}" 전에 확인이 필요합니다. 브라우저에 뜬 Dogent 승인 창에서 승인하거나 취소하세요.\n${fields}${tables ? `\n${tables}` : ''}\n`;
}

const STATUS: Record<RunResult['status'], string> = {
  done: '완료',
  aborted: '중단',
  stopped: '멈춤',
  error: '오류',
  dryrun: '시험 실행 (제출 전 멈춤)',
};

export function describeResult(r: RunResult, saved: string[]): string {
  const files = saved.length ? `\n  저장한 파일: ${saved.join(', ')}` : '';
  return `\n[${STATUS[r.status]}] ${r.message}\n  동작 ${r.actions}회 · ${(r.elapsedMs / 1000).toFixed(1)}초${files}`;
}
