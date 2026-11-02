# dogent-systems — 공용 시스템 사전

사내 시스템(GSAMS, MES 등)의 이름·별칭·주소·화면·용어를 한 곳에서 관리하는 저장소입니다. 반영된 내용은 **시스템 MCP 서버**를 통해 Dogent, opencode, Claude Code 등 모든 도구에 같은 답으로 나갑니다.

> 이 폴더는 Dogent 저장소의 `templates/dogent-systems`에서 왔습니다. 사내 GitHub에 새 저장소(예: `dogent-systems`)를 만들고 이 폴더의 내용을 그대로 올리세요.

## 구조

```
systems/
  gsams/SYSTEM.md        ← 시스템 하나 = 폴더 하나. 폴더 이름 = id
  _template/SYSTEM.md    ← 새 시스템용 틀 (_ 로 시작하는 폴더는 검사·서버가 읽지 않는다)
tools/
  system-check.mjs       ← 검사기 (Dogent에서 생성. 고치지 않는다)
  systems-mcp.mjs        ← 시스템 MCP 서버 (Dogent에서 생성. 고치지 않는다)
.github/
  workflows/systems.yml  ← PR마다 검사
  CODEOWNERS             ← 시스템별 검토 담당
  pull_request_template.md
```

두 도구 모두 Node 20 이상만 있으면 돌고 `npm install`이 필요 없습니다.

## 품질을 지키는 방법

| 장치 | 하는 일 |
|---|---|
| 원본 하나 | 사전은 이 저장소에만 둡니다. 서버와 도구는 여기서 읽기만 합니다 |
| 검사기 (CI) | 형식, 폴더=id, 주소가 `domains` 안인지, 두 시스템이 같은 이름·별칭을 쓰는지 봅니다. 오류가 있으면 PR이 통과하지 않습니다 |
| CODEOWNERS 리뷰 | 시스템마다 담당 부서가 승인해야 반영됩니다 (브랜치 보호에서 Code Owners 리뷰를 켭니다) |
| `status` | `verified` = 담당자가 확인함, `draft` = 검증 전. go/link 등에서 자동으로 가져온 항목은 `draft`로 넣습니다. 찾기 결과에 상태가 같이 나갑니다 |
| 신고 | 쓰는 사람이 틀린 내용을 `report_issue`로 알리면 서버의 신고 파일에 쌓입니다. 담당자가 보고 PR로 고칩니다 |

검사기 규칙

- **오류 (반영 안 됨):** 선언부 형식, `id`와 폴더 이름이 다름, `url`이나 화면 `url`이 `domains` 밖, 같은 화면이 두 번 있음, `updated`가 YYYY-MM-DD가 아님, 같은 `id`, 다른 시스템과 겹치는 이름·별칭
- **경고:** 검증 전(`draft`), 틀 칸을 채우지 않음(`(…)`), 별칭·화면·용어 없음, 설명이 너무 짧음, 다른 시스템과 같은 사이트

```
node tools/system-check.mjs .            # 오류가 있으면 실패
node tools/system-check.mjs . --strict   # 경고도 실패로 친다 (verified만 두는 저장소라면)
```

## 시스템을 더하거나 고치는 순서

1. `systems/_template`을 `systems/<id>`로 복사하고 채웁니다. 별칭(`aliases`)에는 사람들이 실제로 부르는 말(줄임말, 업무 이름)을 넣습니다.
2. `node tools/system-check.mjs .` 로 오류가 없는지 봅니다.
3. PR을 올리면 CI 검사와 담당자 리뷰를 거쳐 main에 반영됩니다.
4. 서버가 `--pull`로 main을 받아 오면(기본 몇 분) 모두에게 새 판이 나갑니다. 판 번호는 `GET /health`나 `list_systems`로 봅니다.

## 시스템 MCP 서버

```
node tools/systems-mcp.mjs --root . --host 0.0.0.0 --port 8787 --pull 300 --reports /var/dogent-systems/issues.jsonl
```

| 옵션 | 뜻 |
|---|---|
| `--root` | 이 저장소를 받아 둔 폴더 |
| `--host` | 다른 PC에서 붙게 하려면 `0.0.0.0` (기본 `127.0.0.1`) |
| `--port` | 기본 8787 |
| `--pull <초>` | 그 간격마다 `git pull --ff-only`. 리뷰를 거친 main만 나갑니다 |
| `--reports <파일>` | `report_issue` 신고를 쌓을 파일 (JSON 줄). 없으면 신고를 받지 않습니다 |
| `SYSTEMS_MCP_TOKEN` | 환경 변수로 주면 `Authorization: Bearer <토큰>`이 있어야 받습니다 |
| `--stdio` | 한 PC에서 시험할 때 (stdin/stdout) |

- 주소: `http://<서버>:8787/mcp` (Streamable HTTP, 답은 JSON)
- 사전 전체: `GET http://<서버>:8787/systems.json` — SYSTEM.md 원문과 판 번호. Dogent 앱·터미널이 이 주소로 받아 로컬 사전으로 씁니다 (토큰이 있으면 같은 인증, 판 번호가 ETag라 바뀌지 않았으면 304)
- 상태: `GET /health` → 판 번호, 시스템 수, 오류로 뺀 파일 수
- 파일이 바뀌면 다음 요청 때 다시 읽습니다. 오류가 있는 파일은 빼고 나머지로 계속 돕니다

도구

| 도구 | 하는 일 |
|---|---|
| `find_system(query, limit?)` | 이름·별칭·요청 문장으로 찾기 → id, 이름, 주소, 사이트, 상태 |
| `get_system(id)` | 주소, 사이트, 로그인, 화면(메뉴 경로), 용어, 주의사항 + 모델에 보여 줄 설명(`prompt`) |
| `list_systems()` | 전체 목록과 판 번호 |
| `report_issue(id, problem, reporter?)` | 틀린 내용이나 없는 시스템을 신고 |

### 각 도구에서 붙이기

```
dogent mcp add systems http://<서버>:8787/mcp --transport http
claude mcp add --transport http systems http://<서버>:8787/mcp
```

토큰을 쓰면 `--header "Authorization: Bearer <토큰>"`을 더합니다.

### Dogent 앱·터미널에서 자동으로 쓰기

위의 MCP 등록은 모델이 필요할 때 부르는 방식입니다. Dogent 앱·터미널은 사전을 **받아 와서 요청마다 자동으로** 씁니다 (요청에 시스템 이름이 나오면 설명을 모델에 함께 보여 주고, 화면이 안 열려 있으면 주소를 열지 묻습니다).

```
dogent config systemsUrl http://<서버>:8787          # 또는 …/mcp 주소 그대로
dogent config systemsToken <토큰>                    # 서버에 SYSTEMS_MCP_TOKEN을 썼을 때
dogent sync                                          # 지금 받기 (평소에는 한 시간에 한 번 스스로, 앱은 켤 때 받음)
dogent systems                                       # [공용] 표시로 보임
```

- 받은 사전은 `~/.dogent/systems-cache`에 둡니다. 서버에 닿지 않으면 마지막으로 받아 둔 것을 씁니다.
- 같은 id는 **개인 > 공용 > 팀 > 기본** 순서입니다. 공용이 정본이고, 개인 폴더의 사전으로 내 PC에서만 덮어쓸 수 있습니다.
- 서버에서 형식 오류로 뺀 항목은 클라이언트에도 내려가지 않습니다. 클라이언트도 받을 때 형식을 다시 검사하고, 맞지 않으면 그 항목만 받지 않습니다.
- 회사 빌드에 처음부터 넣으려면 `.env.company.local`에 `WXT_SYSTEMS_URL=http://<서버>:8787`을 적고 클라이언트·앱을 다시 빌드합니다. 토큰은 빌드에 넣지 않습니다.
