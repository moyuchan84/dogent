# 17. Claude Desktop · Claude Code · Claude in Chrome 대비 빠진 기능과 사내 에이전트 연계

> 문서 상태: v0.1 (2026-11-02) · 1차 구현됨 (G1~G4). 나머지는 4절의 순서로 진행
> 관련: [09-client-architecture.md](09-client-architecture.md) (D1: Claude Code + Claude in Chrome 구조), [13-subagent-lazy-skill.md](13-subagent-lazy-skill.md), [16-opencode-install.md](16-opencode-install.md)

Dogent는 처음부터 Claude Code(판단·스킬·도구)와 Claude in Chrome(브라우저 조작)을 나눈 구조로 만들었다 (09 D1). 이 문서는 세 제품의 기능을 하나씩 대 보고, Dogent에 없는 것과 반쯤 있는 것을 정리한다. 또 사내에서 함께 쓰는 **opencode(GLM-5.3)와 Claude Code를 Dogent와 서로 부르게 하는 방법**을 정한다.

판정: **있음** = 같은 일을 함 · **일부** = 비슷하지만 빠진 데가 있음 · **없음** · **안 함** = 일부러 넣지 않음

## 1. 기능 대조

### 1.1 Claude Code

| 기능 | Claude Code | Dogent 지금 | 판정 | 우선 |
|---|---|---|---|---|
| 에이전트 루프 + 도구 | 파일 읽기·쓰기·편집, 셸, 검색, 웹 | 브라우저 도구, 엑셀(COM), MCP 도구, 스킬 스크립트(`run_script`) | 일부 | — |
| PC 파일·코드·셸 작업 | Read/Write/Edit/Bash | **에이전트에 맡김** (G3: Claude Code·opencode 호출) | 일부 → 있음 | ✅ 이번 |
| 지침 파일 (CLAUDE.md) | 사용자·프로젝트별 | **DOGENT.md** (개인 `~/.dogent/DOGENT.md` + 팀 저장소 `DOGENT.md`), "기억해: …" | 있음 | ✅ G2 |
| 이어지는 대화 | 한 세션 안 맥락, `--continue`, `/clear` | **대화 맥락** (최근 5차례, 결과 파일·데이터셋), `--continue`, "새 대화" | 있음 | ✅ G1 |
| 지난 대화 골라 이어 가기 (`--resume`) | 있음 | 마지막 대화 하나만 | 일부 | P2 |
| 긴 대화 압축 (compaction) | 자동 요약 | 최근 5차례만 보임 (요약 400자) | 일부 | P3 |
| 스킬 | SKILL.md, 개인/프로젝트/플러그인 | SKILL.md, 개인 > 팀 > 기본, 지연 로딩, 품질 검사 | 있음 | — |
| 스킬을 만들고 고치는 UX | 스킬 파일, 말로 요청 | **흐름 편집기**(확장): 대화 + 단계 카드, 말로 고치기, 여기까지 시험, 되돌리기. 스킬은 목표 문장들의 순서이고 모델이 판단하는 Claude 방식 (docs/23) | 있음 | ✅ |
| 서브에이전트 | Task 도구 | `run_skill` (스킬을 자식으로). 일반 `delegate`는 아직 (13 문서) | 일부 | P2 |
| MCP 클라이언트 | stdio·HTTP·SSE, 권한 | 같음 (`dogent mcp add/import`, allow/ask/deny, 키워드) | 있음 | — |
| MCP 서버로 쓰이기 | `claude mcp serve` | **`dogent serve`, 앱의 MCP 주소** (G4) | 있음 | ✅ G4 |
| 권한 모드 | ask/acceptEdits/plan/bypass | 저장·상신 승인 창(확장), 도구 권한, `--allow-write`, `--dry-run` | 일부 | — |
| 계획 먼저 보이기 (plan mode, 할 일 목록) | TodoWrite, plan mode | 스킬은 단계가 보임. 자유 요청은 계획을 먼저 보이지 않음 | 일부 | P2 |
| 훅 (PreToolUse 등) | 있음 | 없음 (감사 기록·사내 정책 검사에 쓸 수 있음) | 없음 | P3 |
| 사용자 명령 (`/명령`) | `.claude/commands` | 스킬이 그 역할. 대화창에서 `/스킬id` 바로 부르기는 없음 | 일부 | P3 |
| 비대화 실행 (`-p --output-format json`) | 있음 | `dogent "<요청>"`(글), `dogent serve`(MCP, JSON) | 일부 | P3 |
| 예약 실행 | 클라우드 루틴 | `dogent schedule` (작업 스케줄러) | 있음 | — |
| 모델 고르기 | 작업마다 | 사내 모델 하나. 어려운 일은 에이전트(Claude·GLM)에 맡김 | 일부 | — |

### 1.2 Claude in Chrome

| 기능 | Claude in Chrome | Dogent 지금 | 판정 | 우선 |
|---|---|---|---|---|
| 화면 읽기 (접근성 트리, 찾기) | read_page, find | snapshot(요소 번호, iframe, 표 요약), find, read_text | 있음 | — |
| 클릭·입력·선택·키·스크롤 | computer, form_input | click, type, select, press_key, scroll, go_back | 있음 | — |
| 탭·탭 그룹 | 탭 그룹 안에서만 | 탭 목록·열기·고르기, Dogent 탭 그룹, 있는 탭 먼저 쓰기 | 있음 | — |
| 사이트 권한 | 사이트마다 허용 | 조작할 사이트 목록 (빌드 + "이 사이트 허용") | 있음 | — |
| 민감한 동작 확인 | 구매·전송 전에 묻기 | 저장·상신 승인 창 (확장이 지킴, 어느 클라이언트든) | 있음 | — |
| 로그인 | 사람이 함 | 사람이 함, `wait_for_login` | 있음 | — |
| **스크린샷 + 그림으로 판단** | screenshot, zoom, 좌표 클릭 | **screenshot**(보이는 영역, JPEG, 사이트 목록 안·로그인 화면 거절), `llm.vision`을 켜면 모델에 그림을 함께 보냄(`look` 동작). 좌표 클릭·zoom은 없음 | 있음(제한) | ✅ P1-1 |
| **파일 올리기** (첨부 칸) | file_upload | **upload_file** (Dogent 클라이언트에서만. 올릴 폴더 제한 + 승인 창 + 크기·사이트 재검증, R3) | 있음(제한) | ✅ P1-2 |
| 콘솔·네트워크 읽기 | read_console_messages, read_network_requests | 없음 (스킬 만드는 사람의 문제 찾기에 쓸모) | 없음 | P3 |
| JS 실행 | javascript_tool | 넣지 않음. 페이지에서 임의 코드를 돌리면 안전장치를 우회할 수 있다 | 안 함 | — |
| GIF 녹화 | gif_creator | 없음. 실행 기록과 스킬 녹화는 있음 | 없음 | P3 |
| 저장한 작업 (shortcuts) | 바로가기 | 스킬, "이 실행을 스킬로 저장" | 있음 | — |
| 예약 | 있음 | `dogent schedule` | 있음 | — |
| 표 → 엑셀, 여러 페이지 읽기 | 모델이 직접 | `extract_table`(페이지 넘김), `download_table`, `fill_table`, 엑셀 저장 | 더 많음 | — |

### 1.3 Claude Desktop

| 기능 | Claude Desktop | Dogent 앱 지금 | 판정 | 우선 |
|---|---|---|---|---|
| 대화 + 이어 말하기 | 있음 | **대화 맥락** (G1). 앱을 다시 켜도 6시간 안이면 이어 감, "새 대화" | 있음 | ✅ G1 |
| 대화 목록·검색 | 있음 | 실행 기록(최근 50건)만. 대화 단위 목록 없음 | 일부 | P2 |
| **파일 첨부 (끌어다 놓기)** | 있음 | 없음. 파일 경로를 글로 써야 함 | 없음 | **P1** |
| 프로젝트 (지식 + 지침) | 있음 | 시스템 사전 + DOGENT.md + 팀 저장소 | 일부 | — |
| 결과물 (Artifacts) | 있음 | HTML 보고서(`write_html`), 엑셀 → "열기"·"폴더에서 보기" | 일부 | — |
| 커넥터 (MCP) 화면 | 있음 | 커넥터 화면 (붙여 넣어 더하기, 시험, 권한) | 있음 | — |
| 마크다운 보이기 | 있음 | 있음 | 있음 | — |
| "새 대화" 버튼 | 있음 | 입력 칸에 "새 대화"라고 쓰면 됨. 버튼은 아직 | 일부 | P2 |
| 컴퓨터 조작 (computer use) | 있음 | 오피스 도구(COM)로 Excel만. 다른 PC 앱은 안 다룸 | 일부 | — |
| 음성·그림 만들기 | 있음 | 업무 범위 밖 | 안 함 | — |

## 2. 이번에 만든 것 (G1~G4)

### G1. 이어지는 대화

- 세션이 앞선 요청·처리 방식(스킬/자유 요청)·결과 요약·저장한 파일·만든 데이터셋을 기억한다 (`client/src/conversation.ts`).
- 요청 해석(`planRequest`)과 자유 요청 둘 다 "앞선 대화"를 함께 본다. 그래서 "그거 엑셀로도 만들어 줘", "방금 것 중 7라인만"을 알아듣는다.
- **데이터셋도 이어진다.** 앞선 실행이 만든 표(예: `wip` 128행)가 다음 자유 요청의 데이터셋으로 들어가, 다시 조회하지 않고 가공·저장한다. 표의 값은 메모리에만 두고 파일에 쓰지 않는다.
- 대화 모드·앱: 세션이 끝날 때까지 이어진다. 앱은 다시 켜도 6시간 안이면 이어 간다. "새 대화"(`new`, `/clear`)로 비운다.
- 한 번 실행 `dogent "<요청>"`은 새 대화. `--continue`(`-c`)면 마지막 대화를 이어 간다.
- 모델에는 최근 5차례만 보인다 (작은 모델의 프롬프트를 지키려고).

### G2. 지침 파일 DOGENT.md

- 개인 `~/.dogent/DOGENT.md`와 팀 스킬 폴더의 `DOGENT.md`를 모든 요청에서 모델이 함께 본다 (각 3000자까지).
- 대화에서 "기억해: 결과 엑셀은 늘 라인별로 시트를 나눈다" → 개인 지침에 한 줄 더함. `memory`로 보기.
- 터미널: `dogent memory`, `dogent memory add "<한 줄>"`, `dogent memory edit`.

### G3. Dogent → Claude Code · opencode (에이전트에 맡기기)

```
dogent agents add claude                                  # Claude Code (claude -p)
dogent agents add opencode --args "-m <제공자>/glm-5.3"     # opencode (opencode run) + 사내 GLM
dogent agents test                                        # 짧은 일을 맡겨 답이 오는지
dogent ask claude "Downloads의 재공확인_7라인.xlsx에서 공정별 정체시간 평균을 구해 줘"
```

- 에이전트 하나가 MCP 서버 하나처럼 보인다 (도구 `claude.ask`, `opencode.ask`). 그래서 자유 요청이 화면 일과 섞어 부를 수 있다: "MES에서 7라인 재공 내려받아서 **클로드코드로** 공정별로 분석해 줘".
- 요청에 "클로드코드", "claude", "오픈코드", "opencode", "glm"이 나오고 화면 일이 없으면 브라우저 없이 에이전트로만 한다 (MCP 서버 키워드와 같은 규칙).
- **부를 때마다 묻는다** (기본 권한 ask). 무엇을 맡기는지 보여 주고 사람이 허락해야 부른다. `dogent agents allow claude`로 끌 수 있다.
- 할 일은 **stdin으로만** 넘긴다. 명령줄 인자로 넘기면 윈도우의 `.cmd` 실행 파일이 셸을 거치며 `&`, `"` 같은 글자가 명령으로 읽힐 수 있기 때문이다.
- 일할 폴더는 결과 저장 폴더(기본 내려받기)다. Claude Code는 `--permission-mode acceptEdits`로 그 폴더의 파일 쓰기만 묻지 않고 하고, 셸 명령은 비대화 모드에서 막힌다 (필요하면 `--args "--allowedTools Bash(python:*)"`처럼 연다).
- 설정: `~/.dogent/agents.json`. 시간 제한은 기본 600초 (`timeoutSec`).

### G4. Claude Code · opencode → Dogent (Dogent를 MCP 서버로)

Dogent가 도구 다섯 개를 내놓는다 (`client/src/mcp-serve.ts`).

| 도구 | 하는 일 |
|---|---|
| `dogent_request(request, allow_write?, dry_run?)` | 사내 웹 업무를 말로 맡긴다. 스킬을 골라 실행하거나 자유 요청으로 하고, 결과 요약·파일 경로·데이터셋·진행 기록을 돌려준다 |
| `dogent_run_skill(skill_id, inputs)` | 스킬 하나를 정한 값으로 |
| `dogent_skills(query?)` | 스킬 목록·찾기 |
| `dogent_systems(query?)` | 사내 시스템 사전 |
| `dogent_new_conversation()` | 앞선 대화 지우기 |

**어디서 띄우나**

| | Dogent 앱이 켜져 있을 때 (보통) | 앱 없이 |
|---|---|---|
| 켜기 | `dogent config mcpServePort 39218` → 앱 다시 켜기 | 설정 없음 |
| 주소 | `http://127.0.0.1:39218/mcp` + `Authorization: Bearer <dogent token>` | stdio: `node <설치 폴더>\dogent.mjs serve` |
| 사람의 확인 | 맡긴 일이 **앱의 대화에 보이고**, 실행 확인·질문은 사람이 앱에서 답한다 | 실행 확인은 건너뛴다. 그 밖의 확인(엑셀 쓰기, 스크립트, 바꾸는 도구)은 하지 않는 쪽으로 |
| 공통 | 저장·상신은 `allow_write`를 켜야 하고, 켜도 **브라우저의 승인 창**에서 사람이 승인한다. 조작할 사이트 목록·로그인 대기도 그대로 (09 D6) | |

```
# Claude Code — 앱의 주소
claude mcp add --transport http dogent http://127.0.0.1:39218/mcp --header "Authorization: Bearer <dogent token>"
# Claude Code — 앱 없이
claude mcp add dogent -- node D:\Multimedia\Dogent\dogent.mjs serve
```

opencode (`opencode.json`):

```json
{
  "mcp": {
    "dogent": { "type": "remote", "url": "http://127.0.0.1:39218/mcp", "headers": { "Authorization": "Bearer <dogent token>" } }
  }
}
```

(앱 없이: `"dogent": { "type": "local", "command": ["node", "D:\\Multimedia\\Dogent\\dogent.mjs", "serve"] }`)

- 앱 주소는 이 PC 안(127.0.0.1)에서만 받고, 토큰이 맞아야 하며, 브라우저에서 온 요청(Origin 머리글)은 거절한다.
- `dogent serve`는 브리지를 자기 안에 띄운다. 앱이 켜져 있으면 포트가 겹쳐 뜨지 않으니 앱의 주소를 쓴다.
- 한 번에 한 일만 받는다. 앱이 다른 일을 하는 중이면 "끝난 뒤에 다시"로 답한다.

## 3. 연계 방법 정리 — 누가 무엇을 맡나

| 방향 | 방법 | 이럴 때 |
|---|---|---|
| Dogent → 에이전트 | G3 `claude.ask` / `opencode.ask` | 사내 화면에서 뽑은 표를 분석·가공하는 코드, 파일 정리, 보고서 글 |
| 에이전트 → Dogent (일 단위) | G4 `dogent_request` | 여러 시스템에 걸친 큰 일을 Claude Code가 계획하고, 사내 웹 부분만 Dogent에 맡김. 스킬·승인·사이트 목록이 그대로 지켜진다 |
| 에이전트 → 확장 (동작 단위) | 기존 브리지 `bridge/hub.mjs` (snapshot, click …) | 스킬이 없는 화면을 Claude Code가 직접 한 단계씩 다룰 때. 안전장치는 확장이 지킨다 |
| 모두 → 시스템 사전 | 시스템 MCP (`templates/dogent-systems`) | 시스템 이름·주소를 모두 같은 사전으로 |

예: "GSAMS에 엑셀의 방화벽 신청 10건 넣어 줘"
1. Claude Code가 엑셀을 읽어 행을 확인한다 (자기 도구).
2. `dogent_request("GSAMS IP 방화벽 신청, 파일 D:\\신청.xlsx, 행마다", allow_write: true)` → Dogent가 스킬로 행마다 입력하고, 상신은 사람이 브라우저 승인 창에서 승인한다.
3. Dogent가 돌려준 결과 엑셀(행별 신청 번호)을 Claude Code가 받아 메일 초안을 쓴다.

**확인할 것 (사내에서 아직 시험하지 못함)**
- 사내 Claude Code·opencode의 비대화 실행(`claude -p`, `opencode run`)이 허용되는지, 사용량 정책. 집 PC에서는 `claude -p`로 연결 시험을 통과했다 (7초).
- `opencode run`이 stdin으로 할 일을 받는지는 사내 판에서 `dogent agents test opencode`로 확인한다. 안 되면 `kind: command`로 감싼 스크립트를 쓴다.
- opencode의 기본 권한은 묻지 않고 파일 편집·명령 실행을 한다. 일할 폴더의 `opencode.json`에 `"permission": {"bash": "deny"}`처럼 막아 두기를 권한다.
- `dogent serve`(stdio)는 Node가 필요하다. 앱의 주소는 Node가 없어도 된다.
- Claude Code의 MCP 도구 제한 시간: 화면 업무는 몇 분 걸리므로 `MCP_TOOL_TIMEOUT`을 넉넉히 둔다.

## 4. 남은 일 (순서)

| # | 할 일 | 왜 | 크기 |
|---|---|---|---|
| P1-1 | **스크린샷 보조 판단**: 확장 `captureVisibleTab` → 사내 모델이 그림을 받으면(멀티모달) 그림을 함께 보냄. 안 받으면 에이전트(Claude)에 맡김 | canvas 그리드, 그림 버튼, 차트 화면 | 중 |
| P1-2 | **파일 올리기** `upload_file(ref, path)`: 첨부 칸에 PC 파일을 넣음 (Chrome DevTools 없이 DataTransfer로). 조작할 사이트 안, 사용자 폴더 안 파일만 | 신청서 첨부, 엑셀 업로드 화면 | 중 |
| P1-3 | **앱에 파일 끌어다 놓기**: 끌어 놓은 파일을 요청의 파일 입력·자유 요청의 대상 파일로 | Desktop의 첨부와 같은 쓰임 | 소 |
| P2-1 | 대화 목록·이어 가기(`--resume`), 앱의 "새 대화" 버튼 | Desktop·Code의 대화 관리 | 소 |
| P2-2 | 자유 요청의 계획 먼저 보이기 (할 일 3~7개를 보이고 확인받은 뒤 실행) | plan mode, 큰 일을 맡길 때의 안심 | 중 |
| P2-3 | `delegate`: 긴 자유 요청을 작은 일로 나눠 맡김 (13 문서) | 서브에이전트 | 중 |
| ~~P2-4~~ | ~~시스템 MCP를 요청 시작 때 부르기~~ → **구현됨(G1)**: `dogent config systemsUrl`로 공용 사전 서버를 받아 로컬 사전('공용')으로 씀. 요청 해석·자유 요청·"주소 열까요?"에 자동 주입 | 사전 공유 | ✅ |
| P3 | 훅(감사 기록), 콘솔·네트워크 읽기, 실행 GIF, `/스킬id`, 긴 대화 요약, `--json` 출력 | 있으면 좋음 | — |
