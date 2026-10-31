// 공유 스킬 저장소의 목록 파일(index.json)을 만든다.
//
//   pnpm skill:index [폴더]        기본은 skills
//
// 폴더 안의 <id>/SKILL.md (와 policy.yaml, scripts/*)를 찾아 해시와 함께 적는다. 스킬을 고치거나 더한 뒤 다시 실행해
// index.json을 함께 올린다. 확장은 이 목록에 적힌 파일만 읽고, 해시가 다르면 쓰지 않는다.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const dir = resolve(process.argv[2] ?? 'skills');
if (!existsSync(dir)) {
  console.error(`폴더가 없습니다: ${dir}`);
  process.exit(1);
}

// 확장은 줄바꿈을 \n으로 맞춘 뒤 해시를 내므로 여기서도 같게 한다.
const hash = (file) => createHash('sha256').update(readFileSync(file, 'utf8').replace(/\r\n/g, '\n'), 'utf8').digest('hex');

const skills = [];
for (const entry of readdirSync(dir, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  const skillFile = join(dir, entry.name, 'SKILL.md');
  if (!existsSync(skillFile)) continue;
  const id = /^id:\s*(\S+)\s*$/m.exec(readFileSync(skillFile, 'utf8'))?.[1];
  if (!id) {
    console.error(`${entry.name}/SKILL.md 에 id가 없습니다`);
    process.exit(1);
  }
  const item = { id, path: `${entry.name}/SKILL.md`, sha256: hash(skillFile) };
  const policyFile = join(dir, entry.name, 'policy.yaml');
  if (existsSync(policyFile)) {
    item.policy = `${entry.name}/policy.yaml`;
    item.policy_sha256 = hash(policyFile);
  }
  // 스킬에 딸린 스크립트 (run_script)
  const scriptDir = join(dir, entry.name, 'scripts');
  if (existsSync(scriptDir)) {
    const files = readdirSync(scriptDir, { withFileTypes: true })
      .filter((f) => f.isFile() && /\.(mjs|js|py)$/.test(f.name))
      .map((f) => ({ path: `${entry.name}/scripts/${f.name}`, sha256: hash(join(scriptDir, f.name)) }));
    if (files.length) item.files = files;
  }
  skills.push(item);
}
skills.sort((a, b) => a.id.localeCompare(b.id));

// 시스템 사전: <폴더>/systems/<id>/SYSTEM.md
const systems = [];
const sysDir = join(dir, 'systems');
if (existsSync(sysDir)) {
  for (const entry of readdirSync(sysDir, { withFileTypes: true })) {
    const file = join(sysDir, entry.name, 'SYSTEM.md');
    if (!entry.isDirectory() || !existsSync(file)) continue;
    const id = /^id:\s*(\S+)\s*$/m.exec(readFileSync(file, 'utf8'))?.[1];
    if (!id) {
      console.error(`systems/${entry.name}/SYSTEM.md 에 id가 없습니다`);
      process.exit(1);
    }
    systems.push({ id, path: `systems/${entry.name}/SYSTEM.md`, sha256: hash(file) });
  }
  systems.sort((a, b) => a.id.localeCompare(b.id));
}

writeFileSync(join(dir, 'index.json'), `${JSON.stringify({ ...(systems.length ? { systems } : {}), skills }, null, 2)}\n`);
console.log(`${join(dir, 'index.json')} 에 스킬 ${skills.length}개${systems.length ? `, 시스템 ${systems.length}개` : ''}를 적었습니다`);
