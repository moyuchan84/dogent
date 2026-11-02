import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { RunResult } from '../../src/core';

/**
 * 대화 맥락. Claude처럼 "그거 엑셀로도 만들어 줘", "방금 조회한 것 중 7라인만" 같은 이어지는 요청을 알아듣게
 * 앞선 요청 몇 개와 그 결과를 짧게 모델에 보여 준다 (docs/17 G1).
 *
 * - 대화 모드와 앱에서는 세션이 끝날 때까지 이어진다. "새 대화"(new)로 비운다.
 * - 한 번 실행(dogent "<요청>")은 새 대화로 시작한다. --continue면 마지막 대화를 이어 간다.
 * - 파일(~/.dogent/conversation.json)에는 요청·결과 요약·파일 이름만 남긴다. 표의 값은 남기지 않는다.
 */
export interface Turn {
  at: string;
  request: string;
  /** 쓴 스킬 이름 (자유 요청이면 "자유 요청") */
  skill: string;
  status: RunResult['status'];
  /** 결과 요약 (finish의 summary, 실패 이유) */
  summary: string;
  /** 저장한 결과 파일 */
  files: string[];
  /** 만든 데이터셋 (이름, 행 수, 컬럼) */
  datasets: { name: string; rows: number; columns: string[] }[];
}

/** 모델에 보여 줄 최근 차례 수 */
const SHOW_TURNS = 5;
/** 파일에 남길 차례 수 */
const KEEP_TURNS = 20;
/** 한 차례 요약의 최대 글자 수 */
const SUMMARY_MAX = 400;
/** 이 시간이 지나면 --continue 없이 이어 가지 않는다 (앱을 켜 둔 채 다음 날 다른 일을 시킬 때) */
export const STALE_MS = 6 * 60 * 60_000;

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);

export class Conversation {
  turns: Turn[] = [];

  constructor(private file?: string) {}

  /** 저장해 둔 마지막 대화를 읽는다 (--continue). 없으면 빈 대화 */
  static resume(file: string): Conversation {
    const c = new Conversation(file);
    try {
      if (existsSync(file)) {
        const raw = JSON.parse(readFileSync(file, 'utf8')) as { turns?: Turn[] };
        c.turns = Array.isArray(raw.turns) ? raw.turns.slice(-KEEP_TURNS) : [];
      }
    } catch {
      c.turns = [];
    }
    return c;
  }

  get empty(): boolean {
    return this.turns.length === 0;
  }

  /** 마지막 차례가 오래되었는지 */
  stale(now = Date.now()): boolean {
    const last = this.turns.at(-1);
    return !!last && now - Date.parse(last.at) > STALE_MS;
  }

  add(turn: Omit<Turn, 'at'> & { at?: string }): void {
    this.turns.push({ ...turn, at: turn.at ?? new Date().toISOString(), summary: clip(turn.summary.replace(/\s+/g, ' ').trim(), SUMMARY_MAX) });
    if (this.turns.length > KEEP_TURNS) this.turns = this.turns.slice(-KEEP_TURNS);
    this.save();
  }

  clear(): void {
    this.turns = [];
    this.save();
  }

  private save(): void {
    if (!this.file) return;
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      writeFileSync(this.file, JSON.stringify({ turns: this.turns }, null, 1));
    } catch {
      // 기록을 못 남겨도 요청은 계속한다
    }
  }

  /** 모델에 보여 줄 글. 대화가 비었으면 undefined */
  context(): string | undefined {
    const recent = this.turns.slice(-SHOW_TURNS);
    if (!recent.length) return undefined;
    const lines = recent.map((t, i) => {
      const n = this.turns.length - recent.length + i + 1;
      const status = t.status === 'done' ? '완료' : t.status === 'dryrun' ? '시험 실행' : t.status === 'stopped' ? '중지' : '실패';
      const out = [
        `${n}. 요청: ${t.request}`,
        `   처리: ${t.skill} · ${status}${t.summary ? ` — ${t.summary}` : ''}`,
        ...(t.files.length ? [`   파일: ${t.files.map((f) => f.split(/[\\/]/).pop()).join(', ')}`] : []),
        ...(t.datasets.length ? [`   데이터셋: ${t.datasets.map((d) => `${d.name}(${d.rows}행, 컬럼 ${d.columns.slice(0, 8).join('·')}${d.columns.length > 8 ? '…' : ''})`).join(', ')}`] : []),
      ];
      return out.join('\n');
    });
    return lines.join('\n');
  }
}

export const conversationFile = (home: string) => join(home, 'conversation.json');

/**
 * 지침 파일 (Claude Code의 CLAUDE.md에 해당). 늘 지킬 것, 부서·라인 같은 기본값, 말버릇을 적어 두면
 * 모든 요청에서 모델이 함께 본다 (docs/17 G2).
 *
 *   개인: ~/.dogent/DOGENT.md          (dogent memory add "<한 줄>", dogent memory edit)
 *   팀:   팀 스킬 폴더(teamSkills)의 DOGENT.md (팀 저장소에서 리뷰를 거쳐 고친다)
 */
export interface Instructions {
  personal?: string;
  team?: string;
}

/** 지침 하나의 최대 글자 수 (작은 모델의 프롬프트가 길어지지 않게) */
export const INSTRUCTIONS_MAX = 3000;

export const personalInstructionsFile = (home: string) => join(home, 'DOGENT.md');

export function loadInstructions(home: string, teamFolder?: string): Instructions {
  const read = (file: string) => {
    try {
      if (!existsSync(file)) return undefined;
      // 맨 위의 제목 줄(# …)은 사람이 보는 것이라 모델에는 보이지 않는다
      const text = readFileSync(file, 'utf8').replace(/^﻿/, '').replace(/^#\s[^\n]*\n/, '').trim();
      return text ? clip(text, INSTRUCTIONS_MAX) : undefined;
    } catch {
      return undefined;
    }
  };
  return { personal: read(personalInstructionsFile(home)), team: teamFolder ? read(join(teamFolder, 'DOGENT.md')) : undefined };
}

/** 모델에 보여 줄 지침 글. 없으면 undefined */
export function describeInstructions(i: Instructions): string | undefined {
  const parts = [...(i.team ? [`### 팀 지침\n${i.team}`] : []), ...(i.personal ? [`### 내 지침\n${i.personal}`] : [])];
  return parts.length ? parts.join('\n\n') : undefined;
}

/** 개인 지침에 한 줄을 더한다 ("기억해: …"). 더한 파일을 돌려준다 */
export function addInstruction(home: string, line: string): string {
  const file = personalInstructionsFile(home);
  mkdirSync(home, { recursive: true });
  const before = existsSync(file) ? readFileSync(file, 'utf8').replace(/\s+$/, '') : '# 내 지침 (Dogent가 모든 요청에서 함께 봅니다)\n';
  writeFileSync(file, `${before}\n- ${line.replace(/\s+/g, ' ').trim()}\n`);
  return file;
}

/**
 * 모델에 함께 보여 줄 참고 글을 하나로 합친다: 지침, 앞선 대화, 시스템 설명.
 * planner·자유 요청의 systemInfo 자리에 들어간다 (그 자리는 "참고"로만 쓰라고 모델에 일러 둔 곳이다).
 */
export function contextNote(parts: { instructions?: string; conversation?: string; systems?: string }): string | undefined {
  const out = [
    ...(parts.instructions ? [`## 지침 (늘 지킨다)\n${parts.instructions}`] : []),
    ...(parts.conversation ? [`## 앞선 대화 (이번 요청의 "그거", "방금 것"은 여기를 가리킨다)\n${parts.conversation}`] : []),
    ...(parts.systems ? [parts.systems] : []),
  ];
  return out.length ? out.join('\n\n') : undefined;
}
