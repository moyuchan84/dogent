// 새 스킬의 틀을 만든다. 손으로 쓸 때도 녹화로 만든 초안과 같은 모양에서 시작하게 한다.
//
//   pnpm skill:new <id> [이름]
//
// 만든 뒤 `pnpm skill:lint`로 품질 검사를 통과시킨다. 기준은 docs/06-skill-authoring.md.
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const [id, name = '새 스킬'] = process.argv.slice(2);
if (!id || !/^[a-z][a-z0-9-]*$/.test(id)) {
  console.error('사용법: pnpm skill:new <id> [이름]\nid는 영문 소문자로 시작하고 소문자·숫자·하이픈만 씁니다 (예: wip-check)');
  process.exit(1);
}
const dir = join(import.meta.dirname, '../skills', id);
if (existsSync(dir)) {
  console.error(`skills/${id} 이(가) 이미 있습니다`);
  process.exit(1);
}

const skill = `---
id: ${id}
name: ${JSON.stringify(name)}
description: (무엇을 조회하거나 입력하는 업무인지 한 문장으로)
version: 0.1.0
owner: (화면이 바뀌면 고칠 책임이 있는 부서)
risk: R1
domains:
  - localhost:4173
inputs:
  - name: keyword
    label: 조회 조건
    type: string
    required: true
schedulable: false
limits:
  max_steps: 30
  timeout_sec: 300
---

## 단계

1. navigate로 업무 화면으로 이동한다. args는 다음을 그대로 쓴다. 이미 열려 있으면 이동하지 않는다.
   \`{"url": "http://localhost:4173/wip.html"}\`
   - 검사: url("/wip.html") and text("화면 제목")
2. type으로 "조회 조건"을 입력한다. args는 다음을 그대로 쓴다.
   \`{"ref": "조회 조건", "text": "{keyword}"}\`
   - 검사: value("조회 조건") == "{keyword}"
3. click으로 "조회" 버튼을 한 번 누른다. args는 다음을 그대로 쓴다.
   \`{"ref": "조회"}\`
   - 검사: did("click") and text("총")
4. finish로 결과를 보고한다. args는 다음을 그대로 쓴다.
   \`{"summary": "조회를 마쳤습니다."}\`

## 예외

- 화면에 오류 메시지가 나오면 abort로 메시지 원문을 그대로 알린다. 같은 동작을 다시 하지 않는다.
- 조회 결과가 없으면 abort로 조건을 그대로 알린다.

## 결과

(사용자에게 알려줄 내용)
`;

mkdirSync(dir, { recursive: true });
writeFileSync(join(dir, 'SKILL.md'), skill);
console.log(`skills/${id}/SKILL.md 를 만들었습니다. 화면에 맞게 고친 뒤 pnpm skill:lint 로 검사하세요.`);
