// 공용 시스템 사전 저장소를 읽는다. 검사기(system-check)와 시스템 MCP 서버(systems-mcp)가 같이 쓴다.
//
//   <저장소>/systems/<id>/SYSTEM.md      (또는 <저장소>/skills/systems/…, 폴더 자체가 systems/ 여도 된다)
//
// 검사 규칙은 Dogent와 같은 것(src/core/systems.ts의 lintSystem, lintSystemSet)을 쓴다.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, join, relative } from 'node:path';
import { lintSystem, lintSystemSet, type System } from '../src/core/systems';

export interface Problem {
  /** 저장소 기준 경로 (예: systems/gsams/SYSTEM.md) */
  file: string;
  level: 'error' | 'warn';
  message: string;
}

export interface Registry {
  root: string;
  /** 오류 없이 읽힌 시스템 */
  systems: { file: string; system: System }[];
  problems: Problem[];
  /** 내용으로 만든 판 번호. 파일이 바뀌면 바뀐다 */
  version: string;
  loadedAt: string;
}

/** 시스템 폴더를 찾는다 */
export function systemsDir(root: string): string {
  for (const d of [join(root, 'systems'), join(root, 'skills', 'systems')]) if (existsSync(d)) return d;
  return root;
}

/** SYSTEM.md 파일들. 이름이 _ 나 . 으로 시작하는 폴더(틀, 숨김)는 건너뛴다 */
export function systemFiles(root: string): { folder: string; path: string; rel: string }[] {
  const dir = systemsDir(root);
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !/^[_.]/.test(e.name) && existsSync(join(dir, e.name, 'SYSTEM.md')))
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((e) => {
      const path = join(dir, e.name, 'SYSTEM.md');
      return { folder: e.name, path, rel: relative(root, path).replace(/\\/g, '/') };
    });
}

/** 파일들이 마지막으로 바뀐 때 (다시 읽을지 볼 때 쓴다) */
export function registryStamp(root: string): string {
  return systemFiles(root)
    .map((f) => `${f.rel}:${statSync(f.path).mtimeMs}`)
    .join('|');
}

export function loadRegistry(root: string): Registry {
  const hash = createHash('sha256');
  const systems: Registry['systems'] = [];
  const problems: Problem[] = [];
  for (const f of systemFiles(root)) {
    const source = readFileSync(f.path, 'utf8');
    hash.update(`${f.rel}\n${source}\n`);
    const r = lintSystem(source, { folder: f.folder });
    for (const m of r.errors) problems.push({ file: f.rel, level: 'error', message: m });
    for (const m of r.warnings) problems.push({ file: f.rel, level: 'warn', message: m });
    if (r.system && r.errors.length === 0) systems.push({ file: f.rel, system: r.system });
  }
  // 두 시스템이 같은 이름을 쓰면 둘 다 오류지만, 뒤에 나온 쪽만 뺀다 (먼저 있던 항목은 계속 찾히게)
  const cross = lintSystemSet(systems);
  problems.push(...cross);
  const bad = new Set(cross.filter((p) => p.level === 'error').map((p) => p.file));
  return {
    root,
    systems: systems.filter((s) => !bad.has(s.file)),
    problems,
    version: hash.digest('hex').slice(0, 12),
    loadedAt: new Date().toISOString(),
  };
}

export const registryName = (root: string) => basename(root) || root;
