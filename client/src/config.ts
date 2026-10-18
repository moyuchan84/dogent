import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { join } from 'node:path';
import type { LlmSettings } from '../../src/core';
import { dogentConfig } from '../../dogent.config';
import { findOfficeExe } from './office';

/**
 * 클라이언트 설정.
 *
 * 모델 설정은 확장과 같은 순서로 정한다: 개발 기본값(dogent.config.ts) → 빌드한 환경 파일(.env.<mode>.local)
 * → 사용자 설정 파일(~/.dogent/config.json). 집(Ollama)과 회사(Gemma 게이트웨이)는 빌드 모드만 바꾸면 된다.
 */
export interface UserConfig {
  /** 바꾸고 싶은 모델 설정만 적는다 (예: userId) */
  llm?: Partial<LlmSettings>;
  /** 팀 스킬 저장소(사내 GitHub Enterprise의 dogent-skills)를 받아 둔 폴더 */
  teamSkills?: string;
  /** 엑셀 결과를 저장할 폴더. 기본은 내려받기 폴더 */
  outputDir?: string;
  /** 확장과 잇는 WebSocket 포트 */
  bridgePort?: number;
  /** 확장이 든 브라우저가 여럿일 때 쓸 브라우저 이름 일부 (예: edge, chrome) */
  browser?: string;
  /** 오피스 도구(dogent-office.exe) 경로. 없으면 클라이언트 옆이나 저장소의 office/dist에서 찾는다 */
  officeExe?: string;
  /** 결과 엑셀을 Excel로 다시 저장한다. 문서 보안(NASCA) 규정상 Excel로 저장해야 할 때 켠다 */
  saveThroughExcel?: boolean;
  /** 스킬을 만들 때 넣을 담당 부서 (처음 저장할 때 물어 기억한다) */
  owner?: string;
}

export interface ClientConfig {
  home: string;
  llm: LlmSettings;
  personalSkills: string;
  teamSkills?: string;
  outputDir: string;
  bridgePort?: number;
  officeExe?: string;
  saveThroughExcel: boolean;
  browser?: string;
  owner?: string;
  /** 사용자 설정 파일 경로 */
  file: string;
}

/**
 * 지금 로그인한 Windows 계정 이름 (도메인 계정이면 도메인을 뺀 ID, 예: CORP\hong → hong). 사내 게이트웨이의 사용자 ID가 보통 이 계정이라
 * 설정에 따로 적지 않았을 때 대신 쓴다. 읽지 못하면 빈 값.
 */
export function windowsAccount(): string {
  try {
    return (process.env.USERNAME || userInfo().username || '').trim();
  } catch {
    return '';
  }
}

/** 사용자 폴더. 시험할 때는 DOGENT_HOME으로 바꾼다. */
export function dogentHome(): string {
  return process.env.DOGENT_HOME ?? join(homedir(), '.dogent');
}

export function loadConfig(): ClientConfig {
  const home = dogentHome();
  const file = join(home, 'config.json');
  let user: UserConfig = {};
  if (existsSync(file)) {
    try {
      user = JSON.parse(readFileSync(file, 'utf8')) as UserConfig;
    } catch (e) {
      throw new Error(`${file}을(를) 읽지 못했습니다: ${(e as Error).message}`);
    }
  }
  const llm: LlmSettings = { ...dogentConfig.llmDefaults, ...__DOGENT_BUILD__.llm, ...user.llm };
  // 사용자 ID를 적지 않았으면 Windows 계정으로 채운다 (SSO ID가 다르면 dogent config llm.userId 로 덮어쓴다).
  if (!llm.userId?.trim()) llm.userId = windowsAccount() || undefined;
  return {
    home,
    llm,
    personalSkills: join(home, 'skills'),
    teamSkills: user.teamSkills,
    outputDir: user.outputDir ?? join(homedir(), 'Downloads'),
    bridgePort: user.bridgePort,
    officeExe: user.officeExe,
    browser: user.browser,
    saveThroughExcel: user.saveThroughExcel === true,
    owner: user.owner,
    file,
  };
}

/** 사용자 설정 파일의 값 하나를 바꾼다. llm.userId처럼 점으로 적는다. */
export function setConfig(key: string, value: string): string {
  const home = dogentHome();
  const file = join(home, 'config.json');
  mkdirSync(home, { recursive: true });
  const user = (existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {}) as Record<string, unknown>;
  const parts = key.split('.');
  let at = user;
  for (const p of parts.slice(0, -1)) at = (at[p] ??= {}) as Record<string, unknown>;
  const last = parts.at(-1)!;
  // 숫자·참거짓은 그대로 넣는다 (timeoutScale, jsonMode 같은 값).
  at[last] = value === 'true' ? true : value === 'false' ? false : value !== '' && Number.isFinite(Number(value)) && /^\d/.test(value) ? Number(value) : value;
  writeFileSync(file, JSON.stringify(user, null, 2));
  return file;
}

/** 보여 줄 때 키는 가린다. */
export function describeConfig(c: ClientConfig): string {
  const key = c.llm.apiKey ? `${c.llm.apiKey.slice(0, 3)}…(${c.llm.apiKey.length}자)` : '(없음)';
  return [
    `빌드 모드      ${__DOGENT_BUILD__.mode}`,
    `모델 API       ${c.llm.baseUrl}`,
    `모델           ${c.llm.model}`,
    `API 키         ${key}`,
    `헤더 틀        ${c.llm.headers ? Object.keys(c.llm.headers).join(', ') : '(없음, Authorization)'}`,
    `시스템 이름    ${c.llm.systemName ?? ''}`,
    `사용자 ID      ${c.llm.userId ?? ''}${c.llm.userId && c.llm.userId === windowsAccount() ? ' (Windows 계정)' : ''}`,
    `브라우저       ${c.browser ?? '(여럿이면 가장 나중에 연결된 것)'}`,
    `개인 스킬      ${c.personalSkills}`,
    `담당 부서      ${c.owner ?? '(스킬을 처음 저장할 때 묻습니다)'}`,
    `팀 스킬        ${c.teamSkills ?? '(설정 안 함: dogent config teamSkills <폴더>)'}`,
    `결과 저장      ${c.outputDir}${c.saveThroughExcel ? ' (Excel로 저장)' : ''}`,
    `오피스 도구    ${findOfficeExe(c.officeExe) ?? '(없음: pnpm office:build)'}`,
    `설정 파일      ${c.file}`,
  ].join('\n');
}
