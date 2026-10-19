import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { skillStats, type FilePort, type PathStore, type RunBrief, type RunEvent, type RunResult, type SkillInputs, type SkillPaths, type SkillStats } from '../../src/core';

/** 실행 기록 한 건. 사이드 패널의 기록과 같은 모양이다. */
export interface RunRecord {
  id: string;
  startedAt: string;
  skill: { id: string; version: string };
  inputs: SkillInputs;
  tabUrl: string;
  events: RunEvent[];
  result: RunResult;
}

/** ~/.dogent/runs.jsonl 에 한 줄씩 남긴다. */
export function appendRun(home: string, record: RunRecord): void {
  mkdirSync(home, { recursive: true });
  appendFileSync(join(home, 'runs.jsonl'), `${JSON.stringify(record)}\n`);
}

/** 이 PC의 실행 기록으로 낸 스킬별 성공률 (사이드 패널 "기록" 탭과 같은 계산). 읽지 못한 줄은 건너뛴다. */
export function readRunStats(home: string): Map<string, SkillStats> {
  const file = join(home, 'runs.jsonl');
  if (!existsSync(file)) return new Map();
  const runs: RunBrief[] = [];
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line) as RunRecord;
      const modelActions = r.events.filter((e) => e.type === 'action' && e.entry.by === 'model').length;
      runs.push({ skillId: r.skill.id, startedAt: r.startedAt, result: r.result, modelActions });
    } catch {
      /* 깨진 줄 */
    }
  }
  return new Map(skillStats(runs).map((s) => [s.skillId, s]));
}

/** 모델이 찾아 성공한 경로의 기억 (~/.dogent/paths.json) */
export function filePathStore(home: string): PathStore {
  const file = join(home, 'paths.json');
  const read = (): Record<string, SkillPaths> => {
    try {
      return existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as Record<string, SkillPaths>) : {};
    } catch {
      return {};
    }
  };
  return {
    async load(key) {
      return read()[key] ?? null;
    },
    async save(key, paths) {
      const all = read();
      all[key] = paths;
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, JSON.stringify(all));
    },
  };
}

/**
 * 결과 엑셀을 폴더에 저장한다. 같은 이름이 있으면 (1), (2)를 붙인다.
 * throughExcel을 주면 임시 파일을 Excel로 열어 그 이름으로 다시 저장한다 (문서 보안 규정상 Excel로 저장해야 할 때).
 */
export function folderFiles(dir: string, saved: string[], throughExcel?: (temp: string, target: string) => Promise<void>): FilePort {
  return {
    async save(filename, data) {
      mkdirSync(dir, { recursive: true });
      const dot = filename.lastIndexOf('.');
      const [base, ext] = dot > 0 ? [filename.slice(0, dot), filename.slice(dot)] : [filename, ''];
      let path = join(dir, filename);
      for (let i = 1; existsSync(path); i++) path = join(dir, `${base} (${i})${ext}`);
      if (throughExcel && ext.toLowerCase() === '.xlsx') {
        const temp = join(dir, `.dogent-${Date.now()}${ext}`);
        writeFileSync(temp, Buffer.from(data));
        try {
          await throughExcel(temp, path);
        } finally {
          rmSync(temp, { force: true });
        }
      } else writeFileSync(path, Buffer.from(data));
      saved.push(path);
    },
  };
}
