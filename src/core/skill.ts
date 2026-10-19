import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { stepCaptures, stepCheck } from './check';

export const RISK_LEVELS = ['R0', 'R1', 'R2', 'R3'] as const;
export type Risk = (typeof RISK_LEVELS)[number];

const InputSpec = z.object({
  name: z.string().regex(/^[a-z][a-z0-9_]*$/),
  label: z.string().optional(),
  /**
   * 이 값이 무엇인지 한두 문장. 요청을 해석할 때 모델이 요청에서 이 값을 뽑는 데 쓰고, 입력 폼에도 보인다.
   * 예: "검색창에 넣을 값. Lot ID나 제품코드 일부"
   */
  description: z.string().optional(),
  type: z.enum(['string', 'number', 'text', 'enum', 'ip', 'port', 'file']).default('string'),
  required: z.boolean().default(false),
  default: z.union([z.string(), z.number()]).optional(),
  values: z.array(z.string()).optional(),
  /** type이 file일 때, 읽은 표를 담을 데이터셋 이름 */
  dataset: z.string().min(1).optional(),
});
export type InputSpec = z.infer<typeof InputSpec>;

/** policy.yaml의 입력값 규칙. 모델 판단과 무관하게 실행 전에 적용한다. */
const InputRule = z.object({
  field: z.string(),
  /** 이 길이보다 넓은 대역(접두 길이가 더 짧은 CIDR)을 금지한다. 예: 24면 /16 금지 */
  deny_cidr_wider_than: z.number().int().min(0).max(32).optional(),
  deny_values: z.array(z.union([z.string(), z.number()])).optional(),
  min: z.number().optional(),
  max: z.number().optional(),
  min_length: z.number().int().positive().optional(),
});
export type InputRule = z.infer<typeof InputRule>;
const PolicyFile = z.object({ rules: z.array(InputRule).default([]) });

const SkillMeta = z.object({
  id: z.string().regex(/^[a-z][a-z0-9-]*$/),
  name: z.string().min(1),
  description: z.string().min(1),
  version: z.string().regex(/^\d+\.\d+\.\d+$/),
  owner: z.string().min(1),
  risk: z.enum(RISK_LEVELS),
  domains: z.array(z.string().min(1)).min(1),
  /** 찾기에 쓰는 말 (시스템 이름, 업무 이름, 대상 등). 스킬 검색에서 이름 다음으로 크게 친다 */
  tags: z.array(z.string().min(1)).default([]),
  inputs: z.array(InputSpec).default([]),
  outputs: z.unknown().optional(),
  submit_steps: z.array(z.number().int().positive()).default([]),
  /** 승인 후 누를 수 있는 버튼 이름. 비우면 저장·상신 계열 버튼 전부가 승인 대상이 된다. */
  submit_labels: z.array(z.string().min(1)).default([]),
  schedulable: z.boolean().default(false),
  limits: z
    .object({
      max_steps: z.number().int().positive().default(40),
      timeout_sec: z.number().int().positive().default(300),
    })
    .default({ max_steps: 40, timeout_sec: 300 }),
});
export type SkillMeta = z.infer<typeof SkillMeta>;

export interface Skill extends SkillMeta {
  body: string;
  steps: string[];
  rules: InputRule[];
}

export type SkillInputs = Record<string, string | number>;

/** SKILL.md 원문을 선언부(YAML)와 본문으로 나눠 검증한다. policy.yaml이 있으면 입력값 규칙으로 읽는다. */
export function parseSkill(source: string, policySource?: string): Skill {
  source = source.replace(/\r\n/g, '\n');
  const m =/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(source.replace(/^﻿/, ''));
  if (!m) throw new Error('스킬 선언부(--- 로 감싼 YAML)를 찾을 수 없습니다');
  const parsed = SkillMeta.safeParse(parseYaml(m[1]));
  if (!parsed.success) throw new Error(`스킬 선언부 오류:\n${z.prettifyError(parsed.error)}`);
  const body = m[2].trim();
  const steps = extractSteps(body);
  if (steps.length === 0) throw new Error('스킬 본문에 "## 단계" 절과 번호 목록이 필요합니다');
  steps.forEach((text, i) => {
    try {
      stepCheck(text);
      stepCaptures(text);
    } catch (e) {
      throw new Error(`${i + 1}단계: ${(e as Error).message}`);
    }
  });
  for (const i of parsed.data.inputs) {
    if (i.type === 'file' && !i.dataset) {
      throw new Error(`입력 "${i.name}"은(는) file 형식이므로 dataset(읽은 표를 담을 이름)이 필요합니다`);
    }
  }
  for (const s of parsed.data.submit_steps) {
    if (s > steps.length) throw new Error(`submit_steps의 ${s}번 단계가 본문에 없습니다`);
  }
  let rules: InputRule[] = [];
  if (policySource) {
    const policy = PolicyFile.safeParse(parseYaml(policySource));
    if (!policy.success) throw new Error(`policy.yaml 오류:\n${z.prettifyError(policy.error)}`);
    rules = policy.data.rules;
    const names = new Set(parsed.data.inputs.map((i) => i.name));
    for (const r of rules) {
      if (!names.has(r.field)) throw new Error(`policy.yaml의 field "${r.field}"는 스킬 입력에 없습니다`);
    }
  }
  return { ...parsed.data, body, steps, rules };
}

/** "## 단계" 절의 번호 항목을 꺼낸다. 각 항목에는 딸린 줄(확인 조건 등)이 함께 들어간다. */
export function extractSteps(body: string): string[] {
  const lines = body.split(/\r?\n/);
  const start = lines.findIndex((l) => /^##\s*단계\s*$/.test(l));
  if (start < 0) return [];
  const steps: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (/^##\s/.test(line)) break;
    const m = /^\d+\.\s+(.+)$/.exec(line);
    if (m) steps.push(m[1].trim());
    else if (steps.length > 0 && line.trim()) steps[steps.length - 1] += `\n${line.trimEnd()}`;
  }
  return steps;
}

/** 입력값을 검증하고 기본값을 채운다. 부족하거나 잘못된 항목은 errors로 돌려준다. */
export function resolveInputs(
  skill: Skill,
  raw: Record<string, unknown>,
): { values: SkillInputs; errors: string[] } {
  const values: SkillInputs = {};
  const errors: string[] = [];
  for (const spec of skill.inputs) {
    const label = spec.label ?? spec.name;
    let v = raw[spec.name];
    if (v === undefined || v === null || String(v).trim() === '') v = spec.default;
    if (v === undefined) {
      if (spec.required) errors.push(`${label}: 필수 입력입니다`);
      continue;
    }
    if (spec.type === 'number') {
      const n = Number(v);
      if (!Number.isFinite(n)) {
        errors.push(`${label}: 숫자여야 합니다`);
        continue;
      }
      values[spec.name] = n;
    } else {
      const s = String(v).trim();
      if (spec.type === 'enum' && spec.values && !spec.values.includes(s)) {
        errors.push(`${label}: ${spec.values.join(', ')} 중 하나여야 합니다`);
        continue;
      }
      if (spec.type === 'ip' && !parseIp(s)) {
        errors.push(`${label}: IPv4 주소 형식이 아닙니다 (예: 10.1.2.3 또는 10.1.2.0/24)`);
        continue;
      }
      if (spec.type === 'port' && !isPort(s)) {
        errors.push(`${label}: 포트는 1~65535 사이의 숫자 또는 범위(예: 8000-8010)여야 합니다`);
        continue;
      }
      values[spec.name] = s;
    }
  }
  errors.push(...checkInputRules(skill, values));
  return { values, errors };
}

/** "10.1.2.3" 또는 "10.1.2.0/24"를 읽는다. 접두 길이가 없으면 단일 주소(/32)로 본다. */
export function parseIp(s: string): { prefix: number } | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})(?:\/(\d{1,2}))?$/.exec(s);
  if (!m) return null;
  if (m.slice(1, 5).some((o) => Number(o) > 255)) return null;
  const prefix = m[5] === undefined ? 32 : Number(m[5]);
  return prefix <= 32 ? { prefix } : null;
}

function isPort(s: string): boolean {
  const m = /^(\d{1,5})(?:-(\d{1,5}))?$/.exec(s);
  if (!m) return false;
  const lo = Number(m[1]);
  const hi = m[2] === undefined ? lo : Number(m[2]);
  return lo >= 1 && hi <= 65535 && lo <= hi;
}

/**
 * policy.yaml의 규칙을 입력값에 적용한다. 위반이 있으면 실행을 시작하지 않는다.
 * 폼 검증(resolveInputs)과 실행 직전(runSkill) 두 곳에서 부른다.
 */
export function checkInputRules(skill: Skill, values: SkillInputs): string[] {
  const errors: string[] = [];
  for (const rule of skill.rules) {
    const v = values[rule.field];
    if (v === undefined) continue;
    const spec = skill.inputs.find((i) => i.name === rule.field);
    const label = spec?.label ?? rule.field;
    const text = String(v).trim();
    if (rule.deny_cidr_wider_than !== undefined) {
      const ip = parseIp(text);
      if (ip && ip.prefix < rule.deny_cidr_wider_than) {
        errors.push(`${label}: /${rule.deny_cidr_wider_than}보다 넓은 대역(${text})은 신청할 수 없습니다`);
      }
    }
    if (rule.deny_values?.some((d) => String(d).toLowerCase() === text.toLowerCase())) {
      errors.push(`${label}: "${text}"은(는) 허용되지 않는 값입니다`);
    }
    if (rule.max !== undefined && Number(v) > rule.max) errors.push(`${label}: ${rule.max} 이하여야 합니다`);
    if (rule.min !== undefined && Number(v) < rule.min) errors.push(`${label}: ${rule.min} 이상이어야 합니다`);
    if (rule.min_length !== undefined && text.length < rule.min_length) {
      errors.push(`${label}: ${rule.min_length}자 이상 적어야 합니다`);
    }
  }
  return errors;
}

/** 본문의 {name} 자리에 입력값을 넣는다. 값이 없는 선택 입력은 "(미지정)"으로 표시한다. */
export function fillTemplate(skill: Skill, values: SkillInputs): string {
  // `...` 안은 모델이 그대로 복사할 JSON 인자이므로 값을 JSON 문자열 규칙으로 이스케이프한다.
  // 그 밖의 본문에서는 줄바꿈만 공백으로 바꿔 단계 구조가 깨지지 않게 한다.
  return skill.body
    .split(/(`[^`\n]*`)/)
    .map((part) =>
      part.startsWith('`')
        ? substitute(skill, values, part, (v) => JSON.stringify(v).slice(1, -1))
        : substitute(skill, values, part, (v) => v.replace(/\s*\n\s*/g, ' ')),
    )
    .join('');
}

/** 자리표시자를 값 그대로 바꾼다. 검사 식의 비교값처럼 화면 값과 정확히 맞춰야 하는 곳에 쓴다. */
export function fillValue(skill: Skill, values: SkillInputs, text: string): string {
  return substitute(skill, values, text, (v) => v);
}

function substitute(skill: Skill, values: SkillInputs, text: string, encode: (v: string) => string): string {
  const names = new Set(skill.inputs.map((i) => i.name));
  return text.replace(/\{([a-z][a-z0-9_]*)\}/g, (whole, name: string) => {
    if (!names.has(name)) return whole;
    return name in values ? encode(String(values[name])) : '(미지정)';
  });
}
