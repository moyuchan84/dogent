import { z } from 'zod';
import { lintSkill } from './lint';

/**
 * 공유 스킬 저장소.
 *
 * 스킬을 하나 고칠 때마다 확장을 다시 배포하지 않도록, 사내 파일 서버나 Git 저장소에 올린 스킬을
 * 확장이 읽어 온다. 저장소에는 skills/<id>/SKILL.md 들과 그 목록인 index.json이 있다
 * (index.json은 `pnpm skill:index`가 만든다).
 *
 * - 목록에 적힌 파일만, 목록과 같은 서버에서만 읽는다.
 * - 목록에 해시가 있으면 받은 내용과 대조한다.
 * - 받은 스킬은 번들된 스킬과 같은 규칙으로 검사하고, 오류가 있으면 쓰지 않는다.
 * - 스킬이 조작할 수 있는 사이트는 여전히 확장의 허용 목록 안으로 제한된다.
 */

const relativePath = z
  .string()
  .min(1)
  .refine((p) => !/^[a-z][a-z0-9+.-]*:|^\/|(^|\/)\.\.(\/|$)|\\/i.test(p), '목록 파일 기준의 상대 경로여야 합니다');

export const SkillIndex = z.object({
  skills: z.array(
    z.object({
      id: z.string().min(1),
      path: relativePath,
      sha256: z.string().optional(),
      policy: relativePath.optional(),
      policy_sha256: z.string().optional(),
    }),
  ),
});
export type SkillIndex = z.infer<typeof SkillIndex>;

/** 저장소에서 받아 검사를 통과한 스킬 하나 */
export interface SharedSkill {
  id: string;
  version: string;
  source: string;
  policy?: string;
}

export interface SyncResult {
  skills: SharedSkill[];
  /** 받지 못했거나 검사에서 떨어진 스킬. 이 스킬들은 목록에 나타나지 않는다. */
  errors: string[];
}

export interface SyncPorts {
  /** 주소의 내용을 글자로 받는다. 실패하면 던진다. */
  fetchText(url: string): Promise<string>;
  /** 글자의 SHA-256을 16진수로 돌려준다. 없으면 해시를 대조하지 않는다. */
  sha256?(text: string): Promise<string>;
}

/** 목록을 받아 거기 적힌 스킬을 모두 읽고 검사한다. 목록 자체를 읽지 못하면 던진다. */
export async function syncSkills(indexUrl: string, ports: SyncPorts): Promise<SyncResult> {
  let raw: unknown;
  try {
    raw = JSON.parse(await ports.fetchText(indexUrl));
  } catch (e) {
    throw new Error(`스킬 목록을 읽지 못했습니다 (${indexUrl}): ${(e as Error).message}`);
  }
  const index = SkillIndex.safeParse(raw);
  if (!index.success) throw new Error(`스킬 목록의 형식이 잘못되었습니다:\n${z.prettifyError(index.error)}`);

  const skills: SharedSkill[] = [];
  const errors: string[] = [];
  const seen = new Set<string>();
  const get = async (path: string, expected: string | undefined) => {
    const text = (await ports.fetchText(new URL(path, indexUrl).href)).replace(/\r\n/g, '\n');
    if (expected && ports.sha256 && (await ports.sha256(text)) !== expected.toLowerCase()) {
      throw new Error(`${path}의 내용이 목록의 해시와 다릅니다`);
    }
    return text;
  };

  for (const entry of index.data.skills) {
    try {
      if (seen.has(entry.id)) throw new Error('목록에 같은 id가 두 번 있습니다');
      seen.add(entry.id);
      const source = await get(entry.path, entry.sha256);
      const policy = entry.policy ? await get(entry.policy, entry.policy_sha256) : undefined;
      const report = lintSkill(source, policy);
      const failed = report.findings.filter((f) => f.level === 'error');
      if (failed.length > 0 || !report.skill) throw new Error(failed.map((f) => f.message).join(' / '));
      if (report.skill.id !== entry.id) throw new Error(`파일의 id는 "${report.skill.id}"입니다`);
      skills.push({ id: entry.id, version: report.skill.version, source, policy });
    } catch (e) {
      errors.push(`${entry.id}: ${(e as Error).message}`);
    }
  }
  return { skills, errors };
}
