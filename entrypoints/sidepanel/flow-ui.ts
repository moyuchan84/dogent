import type { BlockKind, Finding, Flow, FlowMeta, RunResult } from '@/src/core';

/** 카드의 시험 실행을 App에 맡길 때 넘기는 것 */
export interface TrialOptions {
  signal: AbortSignal;
  /** 파일 입력(엑셀)으로 고른 파일 */
  files: Record<string, File | undefined>;
  /** 실행 중 사용자에게 묻는 말 */
  ask: (question: string) => Promise<string>;
}

/** 녹화 직후·말로 만든 초안 등에서 사용자가 아직 정하지 않은 스킬 정보의 자리표시 */
export const PLACEHOLDER = {
  id: 'new-skill',
  name: '이름 없는 스킬',
  description: '(설명을 적어 주세요)',
  owner: '(담당 부서)',
} as const;

/** 카드 앞의 작은 기호 (글자라 다크 모드에서도 색만 맞으면 된다) */
export const KIND_GLYPH: Record<BlockKind, string> = {
  navigate: '→',
  click: '▣',
  type: '✎',
  select: '▾',
  extract: '▤',
  fill: '⇩',
  summarize: '≡',
  download: '⤓',
  goal: '“”',
  report: '✓',
  other: '·',
};

const OWNER_KEY = 'dogent.author.owner';

/** 담당 부서는 한 번 적으면 기억한다 (이 PC의 브라우저에만 저장) */
export function rememberedOwner(): string {
  try {
    return localStorage.getItem(OWNER_KEY) ?? '';
  } catch {
    return '';
  }
}

export function rememberOwner(owner: string): void {
  try {
    if (owner.trim() && owner !== PLACEHOLDER.owner) localStorage.setItem(OWNER_KEY, owner.trim());
  } catch {
    /* 저장하지 못해도 동작에는 지장이 없다 */
  }
}

/** 이름에서 스킬 ID를 제안한다. 영문·숫자가 없는 이름(한글만)이면 제안하지 않는다. */
export function suggestId(name: string): string {
  const id = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^[^a-z]+|-+$/g, '');
  return id;
}

export const ID_PATTERN = /^[a-z][a-z0-9-]*$/;

/** 저장하기 전에 채워야 할 스킬 정보가 비었으면 안내 문구, 다 됐으면 null */
export function infoProblem(meta: FlowMeta): string | null {
  if (!ID_PATTERN.test(meta.id) || meta.id === PLACEHOLDER.id) return '스킬 ID를 정해 주세요. 영문 소문자로 시작하고 소문자·숫자·하이픈만 씁니다 (예: wip-check)';
  if (!meta.name.trim() || meta.name === PLACEHOLDER.name) return '스킬 이름을 적어 주세요';
  if (!meta.description.trim() || meta.description === PLACEHOLDER.description) return '스킬이 무엇을 하는지 한두 문장으로 적어 주세요';
  if (!meta.owner.trim() || meta.owner === PLACEHOLDER.owner) return '담당 부서를 적어 주세요 (화면이 바뀌면 고칠 책임이 있는 부서)';
  return null;
}

/** 품질 검사 항목이 가리키는 카드 번호(0부터). 이동 단계 포함 번호다. */
export function findingIndex(f: Finding, flow: Flow): number | undefined {
  return f.step && f.step >= 1 && f.step <= flow.blocks.length ? f.step - 1 : undefined;
}

/** 시험 실행 결과를 모델이 읽을 문장으로. "방금 시험 결과"로 말로 고치기에 함께 보낸다. */
export function describeRun(upTo: number, res: RunResult): string {
  const ok = res.status === 'done' || res.status === 'dryrun';
  const head = `1번부터 ${upTo + 1}번 단계까지 시험 실행: ${ok ? '성공' : '실패'} (${res.status})`;
  const last = res.lastStep ? `\n마지막으로 한 단계: ${res.lastStep}번` : '';
  return `${head}${last}\n메시지: ${res.message}`;
}

/** 시험 결과를 카드에 보일 한 줄로 */
export function runLine(res: RunResult): string {
  const label = res.status === 'done' ? '성공' : res.status === 'dryrun' ? '성공 (저장·상신 직전에서 멈춤)' : res.status === 'stopped' ? '중지함' : res.status === 'aborted' ? '중단됨' : '실패';
  return `${label} · ${res.lastStep}번 단계까지 · ${res.message}`;
}

export function isRunOk(res: RunResult): boolean {
  return res.status === 'done' || res.status === 'dryrun';
}
