# Dogent 인프라 설정 가이드 (스킬 · MCP · 시스템 사전 · Hub · LLM 프록시)

> 기준일 2026-11-09 · 설치 자체는 [24-install-manual.md](24-install-manual.md). 이 문서는 **사내에 서버·저장소를 만들고 클라이언트에 연결하는 순서**입니다.
> 서버가 하나도 없어도 Dogent는 단독으로 돕니다(스킬·MCP는 개인 설정, 사전은 로컬). 아래는 모두 **선택**이며, 여러 명이 쓰기 시작할 때 하나씩 켭니다.

## 1. 전체 그림

| 구성 | 틀 위치 | 무엇을 | 서버 필요 | 클라이언트 연결 키 |
|---|---|---|---|---|
| 팀 스킬 저장소 | `templates/dogent-skills` | 업무 스킬을 PR·리뷰로 공유 | 사내 GitHub (서버 없음) | `teamSkillsUrl`, `teamSkillsToken` |
| MCP 카탈로그 | `templates/dogent-skills/mcp` | 사내 MCP 서버 목록과 설치 한 줄 | 위 저장소와 같음 | `mcpCatalogUrl`, `mcpCatalogToken` |
| 사내 MCP 서버 | `templates/dogent-mcp` | 사내 도구를 에이전트가 부르게 함 | Node 20 서버/컨테이너 | `dogent mcp add/install` |
| 시스템 사전 | `templates/dogent-systems` | 시스템 이름·별칭·주소·화면을 모두에게 같게 | Node 20 서버 (포트 8787) | `systemsUrl`, `systemsToken` |
| Hub | `templates/dogent-hub` | 중지 스위치, 정책, 실행 요약 수집 | Node 20 서버 (포트 8790) | `hubUrl`, `hubToken` |
| LLM 프록시 | `templates/dogent-hub/tools/llm-proxy.mjs` | 모델 키를 서버에만 두고 사용자별 제한·감사 | Node 20 서버 (포트 8791) | `llm.baseUrl`, `llm.apiKey` |

권장 도입 순서: **팀 스킬 저장소 → 시스템 사전 → MCP 카탈로그/서버 → Hub → LLM 프록시** (앞의 것이 효과가 크고 운영 부담이 작습니다).

공통 원칙

- 토큰·비밀번호는 저장소·빌드 파일·로그에 적지 않고 **환경 변수/Secret**으로만 둡니다.
- 서버는 HTTPS 리버스 프록시 뒤에 둡니다 (토큰이 헤더로 갑니다).
- 저장소에 쓸 수 있는 사람 = 모든 사용자의 스킬·사전·MCP 목록을 바꿀 수 있는 사람입니다. **main 보호, 쓰기 권한 제한, CODEOWNERS**를 먼저 겁니다.

## 2. 팀 스킬 저장소

### 2-1. 만들기

1. 사내 GitHub에 `dogent-skills` 저장소를 만들고 `templates/dogent-skills`의 내용을 그대로 올립니다.
2. 브랜치 보호: main 직접 푸시 금지, PR 필수, **Code Owners 리뷰 필수**.
3. `.github/CODEOWNERS`를 부서별 담당자로 고칩니다 (`skills/<id>/`, `mcp/<id>/` 단위).
4. CI(`.github/workflows/skills.yml`)가 사내 self-hosted 러너를 전제합니다. 러너가 없으면 PR 전에 손으로:

```bash
node tools/skill-check.mjs skills       # 스킬 품질 검사
node tools/mcp-index.mjs mcp --check    # MCP 카탈로그 검사
```

### 2-2. 스킬 올리기

```bash
pnpm skill:new <id>           # (Dogent 저장소에서) 새 스킬 뼈대
# 사내 화면에서 말로 만들기/녹화 → 품질 B 이상 → 시험 실행 통과
pnpm skill:index              # index.json 갱신 (파일 해시 포함)
```

스킬 폴더를 `skills/<id>/SKILL.md`로 넣고 PR → CI 검사 + 담당자 승인 → main.

### 2-3. 클라이언트 연결

```bash
dogent config teamSkillsUrl https://<GitHub 호스트>/<조직>/dogent-skills/raw/main/skills/index.json
dogent config teamSkillsToken <개인 액세스 토큰>     # 저장소가 로그인을 요구할 때
dogent sync                                          # 지금 받기 (평소 1시간마다 자동)
dogent skills                                        # [팀] 표시 확인
```

회사 빌드에 처음부터 넣으려면 `.env.company.local`에 `WXT_SKILLS_URL`(+ 로그인 필요 시 `WXT_SKILLS_WITH_LOGIN=true`).
해시가 다르거나 품질 오류가 있는 스킬은 받지 않고 이유를 보여 줍니다. 같은 id면 **개인 > 팀 > 기본** 순입니다.

## 3. MCP 카탈로그와 사내 MCP 서버

### 3-1. 구조

```
dogent-skills/
  skills/…
  mcp/
    catalog.json          ← tools/mcp-index.mjs 가 만든다. 손으로 고치지 않는다
    mes-lots/server.json  ← 서버 하나 = 폴더 하나. 폴더 이름 = id
```

### 3-2. 사내 MCP 서버 만들기 (`templates/dogent-mcp`)

1. 폴더를 복사해 새 저장소(또는 `mcp-<이름>/`)를 만듭니다. 의존 패키지 없이 Node 20만 필요합니다.
2. `server.mjs`의 `TOOLS`에 도구를 씁니다: `name`, `description`(무엇을 언제 쓰는지 구체적으로), `inputSchema`, `readOnly`, `handler`.
   - `readOnly: true`는 바로 호출, `false`(저장·상신·삭제·홀드)는 부르기 전에 사람에게 묻습니다.
3. 내 PC에서 시험:

```bash
dogent mcp add my-mcp -- node D:\path\to\server.mjs
dogent mcp test my-mcp            # 도구 목록이 보이면 성공
dogent "my-mcp로 7라인 Lot 목록 보여줘"
```

4. 서버로 올리기:

```bash
MCP_TOKEN=<토큰> node server.mjs --http 8800            # http://호스트:8800/mcp
docker build -t my-mcp . && docker run -p 8800:8800 -e MCP_TOKEN=<토큰> my-mcp
```

앞단에 사내 HTTPS를 둡니다. 도구 안에서 입력값을 다시 검증하고(모델이 만든 값), 응답에 개인정보를 필요 이상으로 싣지 않습니다.

### 3-3. 카탈로그에 올리기

`templates/dogent-mcp/server.json`을 고쳐 `mcp/<id>/server.json`으로 넣습니다.

| 항목 | 규칙 |
|---|---|
| `id` | 소문자로 시작, 소문자·숫자·하이픈 40자 이내 |
| `owner` | 담당 부서 (필수) |
| `writes` | 바꾸는 도구가 있으면 `true` |
| `requires_env` | 사용자가 준비할 환경 변수 이름 (`${NAME}`으로 쓰면 반드시 여기 적음) |
| `spec` | `command`(이 PC에서 띄움) 또는 `url`(원격) **중 하나만** |
| `spec.permissions` | 바꾸는 도구는 `ask` |
| `spec.keywords` | 요청에 이 말이 나오면 브라우저 없이 이 서버로 처리 |
| 금지 | 토큰·비밀번호 값을 그대로 적기 (검사기가 막음), 토큰이 필요한 서버를 `http://`로 두기 (localhost 제외) |

```bash
node tools/mcp-index.mjs mcp          # catalog.json 다시 만들기
node tools/mcp-index.mjs mcp --check  # CI가 하는 검사
```

PR → CODEOWNERS의 해당 서버 운영팀 승인 → main.

### 3-4. 사용자 PC 연결

```bash
dogent config teamSkillsUrl <…/skills/index.json>   # 설정돼 있으면 카탈로그 주소는 옆의 …/mcp/catalog.json으로 자동
dogent config mcpCatalogUrl <…/mcp/catalog.json>    # 따로 정하려면
dogent config mcpCatalogToken <개인 토큰>            # 비어 있으면 teamSkillsToken을 씀

export MES_MCP_TOKEN=<토큰>                         # 서버의 requires_env (Windows는 setx)
dogent mcp browse                                    # ✔ = 설치됨
dogent mcp install mes-lots                          # 내용을 보여 주고 확인 → ~/.dogent/mcp.json 에 더하고 연결 시험
dogent mcp allow|ask|deny <서버> <도구|*>            # 권한 조정
```

설치는 항상 주소·실행 명령·환경 변수를 보여 주고 사람이 확인해야 합니다. 이 PC에서 명령을 실행하는 서버(`command`)는 **승인된 저장소의 것만** 설치하세요.

Claude Code/Cursor/opencode에서 쓰던 설정은 `dogent mcp import <파일|주소>`로 가져올 수 있습니다.

## 4. 공용 시스템 사전 서버

1. 사내 GitHub에 `dogent-systems` 저장소를 만들고 `templates/dogent-systems`를 올립니다. CODEOWNERS는 **시스템별 담당 부서**로 둡니다.
2. 서버 PC/컨테이너에서:

```bash
export SYSTEMS_MCP_TOKEN=<토큰>            # 선택, 있으면 Bearer 필요
node tools/systems-mcp.mjs --root . --host 0.0.0.0 --port 8787 --pull 300 --reports /var/dogent-systems/issues.jsonl
```

3. 시스템 추가: `systems/_template`을 `systems/<id>`로 복사 → 채움(별칭이 핵심) → `node tools/system-check.mjs .` → PR → 담당자 승인. 서버가 `--pull` 주기로 main을 받아 반영합니다.
4. 클라이언트:

```bash
dogent config systemsUrl http://<서버>:8787
dogent config systemsToken <토큰>
dogent sync && dogent systems           # [공용] 표시
```

회사 빌드 기본값은 `WXT_SYSTEMS_URL` (토큰은 빌드에 넣지 않음). 서버가 꺼져도 마지막으로 받은 캐시(`~/.dogent/systems-cache`)로 동작합니다. 같은 시스템을 팀 스킬 저장소의 `systems/`에도 적지 마세요.
운영 상세: [18-systems-dictionary-guide.md](18-systems-dictionary-guide.md).

## 5. Hub (중지 스위치 · 정책 · 실행 요약)

```bash
export HUB_TOKEN=<클라이언트용, 16자 이상>
export HUB_ADMIN_TOKEN=<관리용, 16자 이상, 서로 다르게>
node tools/hub.mjs --data ./hub-data --port 8790 --host 0.0.0.0
```

- 한 프로세스만 씁니다 (파일 저장소, 복제 1). HTTPS 리버스 프록시 필수.
- 중지 스위치: `POST /v1/admin/killswitch` (`scope`: skill / system / all). 해제는 `DELETE /v1/admin/killswitch/:id`. 통계 `GET /v1/admin/stats?days=7`. 예시 curl은 `templates/dogent-hub/README.md`.
- 클라이언트: `dogent config hubUrl http://서버:8790`, `dogent config hubToken <HUB_TOKEN>` (빌드 기본값 `WXT_HUB_URL`).
- 정책 만료(TTL) 후에는 R3(저장·상신)만 차단됩니다. Hub가 꺼져도 조회 업무는 계속됩니다.
- 수집하는 것은 허용 필드뿐(스킬 id, 결과, 시간, 모델 호출 수 등). **값·화면 글자·요청 문장은 보내지 않습니다.**
- 컨테이너/k8s: `Dockerfile`, `deploy/k8s.yaml`.

## 6. LLM 프록시 (선택)

모델 키를 빌드에서 빼고 서버에만 두는 방법입니다.

```bash
export LLM_UPSTREAM_URL=https://(게이트웨이)/v1
export LLM_UPSTREAM_KEY=<게이트웨이 키>
export LLM_UPSTREAM_HEADERS='{"x-dep-ticket":"{key}","Send-System-Name":"{systemName}","user-id":"{userId}","user-type":"{userType}","prompt-msg-id":"{uuid}","completion-msg-id":"{uuid}","content-type":"application/json"}'
node tools/llm-proxy.mjs --tokens ./tokens.json --port 8791 --host 0.0.0.0 --rate 60 --audit ./llm-audit.jsonl
```

- `tokens.json`: 개인 토큰 → `{userId, userType}` 표. 고치면 재시작 없이 반영. 파일에 원문을 두지 않으려면 sha256 해시를 키로.
- 클라이언트: `dogent config llm.baseUrl http://서버:8791/v1`, `dogent config llm.apiKey <개인 토큰>`. 빌드에 `WXT_LLM_HEADERS`가 있었다면 비우고 다시 빌드하거나 config의 `llm.headers`를 `null`로.
- 감사 기록에는 사용자·시각·모델·상태·지연·토큰 수만 남습니다 (프롬프트·응답 없음).

## 7. 포트와 방화벽 표

| 포트 | 무엇 | 어디서 어디로 |
|---|---|---|
| 39217 | 브리지 WebSocket | 같은 PC 안 (127.0.0.1). PC당 1개 |
| 39218 | 앱의 Dogent MCP 서버 | 같은 PC 안 (Claude Code·opencode가 접속, 토큰 필요) |
| 8787 | 시스템 사전 서버 | 사용자 PC → 서버 |
| 8790 | Hub | 사용자 PC → 서버 |
| 8791 | LLM 프록시 | 사용자 PC → 서버 |
| 8800 (예) | 사내 MCP 서버 | 사용자 PC → 서버 |
| 4173/4174/11434 | 개발용 모의 사이트·모의 모델·Ollama | 회사에서는 안 씀 |

## 8. 사용자 PC의 설정 파일 (`%USERPROFILE%\.dogent`)

| 파일/폴더 | 내용 |
|---|---|
| `config.json` | 위의 `dogent config` 값들 |
| `mcp.json` | 연결한 MCP 서버 (카탈로그 설치 결과 포함) |
| `hooks.json` | 개인 훅. **팀 저장소에서는 받지 않음** (동기화만으로 명령이 실행되면 안 되므로) |
| `agents.json` | Claude Code·opencode 위임 설정 |
| `skills\`, `team-cache\`, `systems-cache\` | 개인 스킬 / 팀 스킬 캐시 / 공용 사전 캐시 |
| `DOGENT.md` | 개인 지침 ("기억해: …") |
| `runs.jsonl`, `bridge-token` | 실행 기록 / 연결 토큰 |

## 9. 연결 확인 체크리스트

- [ ] `dogent sync` 후 `dogent skills`에 [팀] 스킬이 보인다
- [ ] `dogent mcp browse`에 카탈로그가 보이고 `dogent mcp test <이름>`이 도구 목록을 낸다
- [ ] `dogent systems`에 [공용] 시스템이 보인다
- [ ] Hub: `GET /health`가 `{ok:true}`, `dogent config`의 Hub 줄이 정상, 중지 스위치를 걸면 해당 스킬이 막힌다
- [ ] LLM 프록시: 연결 시험 "연결됨", 감사 파일에 줄이 쌓인다
- [ ] 서버를 일부러 끄고도 조회 업무가 돈다 (캐시로 동작)
- [ ] 저장소: main 보호와 CODEOWNERS가 걸려 있다

## 10. 운영 시 반드시 정할 것

| 항목 | 이유 |
|---|---|
| 서버가 놓일 곳, 운영 주체, 가동 시간 | Hub·사전·프록시는 누가 24시간 지키는지 |
| 인증 방식 | 지금은 공유 토큰. 사내 SSO 연동은 미구현 |
| 보관 기간 | Hub `runs.jsonl`, 프록시 감사 파일의 삭제 주기 (보안 부서와 협의) |
| 토큰 발급·회수 절차 | 사용자별 토큰을 누가 발급하는지 |
| 백업 | `hub-data`, 신고 파일, 확장 ID 키(`keys\dogent-extension.pem`) |
