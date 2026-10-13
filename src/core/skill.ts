import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { stepCheck } from './check';

export const RISK_LEVELS = ['R0', 'R1', 'R2', 'R3'] as const;
export type Risk = (typeof RISK_LEVELS)[number];

const InputSpec = z.object({
  name: z.string().regex(/^[a-z][a-z0-9_]*$/),
  label: z.string().optional(),
  type: z.enum(['string', 'number', 'text', 'enum', 'ip', 'port']).default('string'),
  required: z.boolean().default(false),
  default: z.union([z.string(), z.number()]).optional(),
  values: z.array(z.string()).optional(),
});
export type InputSpec = z.infer<typeof InputSpec>;

const SkillMeta = z.object({
  id: z.string().regex(/^[a-z][a-z0-9-]*$/),
  name: z.string().min(1),
  description: z.string().min(1),
  version: z.string().regex(/^\d+\.\d+\.\d+$/),
  owner: z.string().min(1),
  risk: z.enum(RISK_LEVELS),
  domains: z.array(z.string().min(1)).min(1),
  inputs: z.array(InputSpec).default([]),
  outputs: z.unknown().optional(),
  submit_steps: z.array(z.number().int().positive()).default([]),
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
}

export type SkillInputs = Record<string, string | number>;

/** SKILL.md 원문을 선언부(YAML)와 본문으로 나눠 검증한다. */
export function parseSkill(source: string): Skill {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(source.replace(/^﻿/, ''));
  if (!m) throw new Error('스킬 선언부(--- 로 감싼 YAML)를 찾을 수 없습니다');
  const parsed = SkillMeta.safeParse(parseYaml(m[1]));
  if (!parsed.success) throw new Error(`스킬 선언부 오류:\n${z.prettifyError(parsed.error)}`);
  const body = m[2].trim();
  const steps = extractSteps(body);
  if (steps.length === 0) throw new Error('스킬 본문에 "## 단계" 절과 번호 목록이 필요합니다');
  steps.forEach((text, i) => {
    try {
      stepCheck(text);
    } catch (e) {
      throw new Error(`${i + 1}단계: ${(e as Error).message}`);
    }
  });
  for (const s of parsed.data.submit_steps) {
    if (s > steps.length) throw new Error(`submit_steps의 ${s}번 단계가 본문에 없습니다`);
  }
  return { ...parsed.data, body, steps };
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
      values[spec.name] = s;
    }
  }
  return { values, errors };
}

/** 본문의 {name} 자리에 입력값을 넣는다. 값이 없는 선택 입력은 "(미지정)"으로 표시한다. */
export function fillTemplate(skill: Skill, values: SkillInputs): string {
  const names = new Set(skill.inputs.map((i) => i.name));
  return skill.body.replace(/\{([a-z][a-z0-9_]*)\}/g, (whole, name: string) => {
    if (!names.has(name)) return whole;
    return name in values ? String(values[name]) : '(미지정)';
  });
}
