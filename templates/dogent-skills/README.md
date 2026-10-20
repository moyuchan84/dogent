# dogent-skills

Dogent가 쓰는 팀 공유 스킬 저장소입니다. 스킬 하나가 폴더 하나이고, 이 저장소에 반영된 스킬은 Dogent를 쓰는 모든 사람의 목록에 `[공유]`로 나타납니다. 확장이나 클라이언트를 다시 배포하지 않아도 됩니다.

> 이 폴더는 Dogent 저장소의 `templates/dogent-skills`에서 왔습니다. 사내 GitHub에 새 저장소(예: `dogent-skills`)를 만들고 이 폴더의 내용을 그대로 올리세요.

## 구조

```
skills/
  index.json          ← 스킬 목록 (tools/skill-index.mjs 가 만든다. 손으로 고치지 않는다)
  wip-check/          ← 폴더 이름 = 스킬 id
    SKILL.md          ← 이름·설명·입력값(앞부분) + 단계(본문)
    policy.yaml       ← (선택) 입력값 규칙. 저장·상신하는 스킬은 거의 필수
  systems/            ← 시스템 사전. 시스템 하나가 폴더 하나 (index.json에도 적힌다)
    mes/SYSTEM.md     ← 이름·별칭·주소·화면(메뉴 경로)·용어. 요청에 시스템 이름이 나오면 모델에 함께 보여 준다
tools/
  skill-check.mjs     ← 품질 검사기 (Dogent에서 생성. 고치지 않는다)
  skill-index.mjs     ← index.json 생성기
.github/
  workflows/skills.yml      ← PR마다 품질 검사와 목록 확인
  pull_request_template.md  ← PR 체크리스트
  CODEOWNERS                ← 스킬별 검토 담당
```

## 스킬을 더하거나 고치는 순서

1. **만들기**: Dogent 사이드 패널 → **스킬 만들기**에서 녹화하고, 품질 검사(B등급 이상)와 **다른 값으로 시험 실행**을 통과시킵니다. 저장·상신하는 스킬은 "시험 실행"을 켜고 상신 직전에 멈추는 것까지 확인합니다.
2. **내려받기**: 내 초안 → **SKILL.md 내려받기**.
3. **브랜치에 넣기**: `skills/<id>/SKILL.md`로 넣습니다. 폴더 이름과 SKILL.md의 `id`가 같아야 합니다.
4. **목록 갱신**:
   ```bash
   node tools/skill-index.mjs skills
   node tools/skill-check.mjs skills    # 올리기 전에 직접 검사
   ```
5. **PR**: 체크리스트를 채워 올립니다. CI가 품질 검사와 목록을 다시 확인하고, CODEOWNERS에 적힌 담당자가 승인하면 main에 반영합니다.

고칠 때도 같습니다. SKILL.md를 고치면 반드시 `index.json`을 다시 만들어야 합니다. Dogent는 목록의 해시와 다른 파일은 쓰지 않습니다.

## 검토 기준

| 항목 | 기준 |
|---|---|
| 품질 등급 | B 이상 (CI가 막음) |
| 시험 실행 | 녹화와 다른 값으로 통과. R3는 상신 직전까지 |
| 저장·상신 | `risk: R3`, `submit_steps`, `submit_labels` 선언 (녹화하면 자동). 넣으면 안 되는 값은 `policy.yaml` |
| 담당 | `owner`에 화면이 바뀌면 고칠 부서. CODEOWNERS에도 같은 팀 |
| 비밀값 | 스킬에 비밀번호·키·개인정보를 적지 않는다 |

저장소에 쓸 수 있는 사람이 곧 모든 사용자의 스킬을 바꿀 수 있는 사람입니다. main 브랜치 보호(PR 필수, CODEOWNERS 승인 필수, CI 통과 필수)를 켜 두세요.

## Dogent에서 이 저장소 쓰기

목록 주소는 다음 모양입니다.

```
https://<사내 GitHub 호스트>/<조직>/dogent-skills/raw/main/skills/index.json
```

- **배포할 때 넣기**: Dogent 저장소의 `.env.company.local`에 적고 `pnpm build:company`로 빌드합니다.
  ```
  WXT_SKILLS_URL=https://<호스트>/<조직>/dogent-skills/raw/main/skills/index.json
  WXT_SKILLS_WITH_LOGIN=true
  ```
- **설치된 확장에서 바로**: 사이드 패널 → 설정 → **공유 스킬 저장소**에 주소를 적고, **브라우저 로그인으로 읽기**를 켭니다.

비공개 저장소는 로그인해야 보입니다. **브라우저 로그인으로 읽기**를 켜면 브라우저에 로그인된 사내 GitHub 세션으로 읽습니다. 그러니 먼저 브라우저에서 사내 GitHub에 로그인해 두세요.

- **로그인 화면이 왔습니다**: 브라우저에서 사내 GitHub에 로그인합니다.
- **닿지 못함**: 원본 파일이 다른 호스트(예: `raw.<호스트>`)로 넘어가는 구성일 수 있습니다. 그 호스트를 설정 → **조작할 사이트**에 더합니다.

## CI 러너

GitHub Enterprise Server에는 GitHub가 제공하는 러너가 없어서 사내 러너(`self-hosted`)에서 돕니다. 러너에는 **Node 20 이상만** 있으면 됩니다. 검사기가 파일 하나라 npm 설치가 필요 없습니다. 러너 라벨이 다르면 `.github/workflows/skills.yml`의 `runs-on`을 바꿉니다.

## 검사기 업데이트

`tools/skill-check.mjs`는 Dogent 저장소에서 만듭니다. Dogent의 검사 규칙이 바뀌면 거기서 `pnpm skill:bundle`을 실행하고, 생긴 `templates/dogent-skills/tools/skill-check.mjs`로 이 저장소의 파일을 바꿉니다.
