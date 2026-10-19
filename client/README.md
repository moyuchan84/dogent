# Dogent 클라이언트 (터미널)

회사에는 Claude Code가 없어서, 그 자리를 하는 프로그램입니다. 판단·스킬·모델 호출은 이 클라이언트가 하고, 화면 읽기·조작은 브라우저의 Dogent 확장이 합니다 (docs/09 D1).

```
dogent (이 폴더)  ──MCP──  브리지(bridge/hub.mjs, 이 프로세스 안)  ──WebSocket / Native Messaging──  Dogent 확장  ──  사내 웹 화면
     │
     └── 사내 Gemma (모델)
```

- 스킬 실행 루프는 사이드 패널과 같은 `src/core`를 씁니다. 브라우저 쪽만 `McpBrowser`(src/core/mcp-browser.ts)로 바뀝니다.
- 조작할 사이트 목록과 저장·상신 승인은 확장이 지킵니다. 저장·상신은 브라우저에 뜨는 Dogent 승인 창에서 한 번 승인합니다.
- 로그인 화면을 만나면 멈추고, 사람이 브라우저에서 로그인하면 이어 갑니다. 비밀번호는 입력하지 않습니다.

## 폴더

| 파일 | 하는 일 |
|---|---|
| `src/main.ts` | 명령(요청, run, skills, tabs, token, config, check, sync)과 실행 흐름 |
| `src/bridge.ts` | 브리지를 프로세스 안에서 띄우고 확장이 붙기를 기다림 |
| `src/config.ts` | 설정: 개발 기본값 → 빌드한 환경 파일 → `~/.dogent/config.json` |
| `src/skills.ts` | 스킬 폴더: 개인 > 팀 > 기본 |
| `src/terminal.ts` | 묻기·진행 표시·승인 안내 |
| `src/store.ts` | 실행 기록(`~/.dogent/runs.jsonl`), 경로 기억(`paths.json`), 결과 파일 저장 |
| `src/save-skill.ts` | 잘 된 자유 요청을 개인 스킬로 저장 |
| `build.mjs` | 한 파일(`dist/dogent.mjs`)로 묶기. Node만 있으면 돈다 |

## 빌드

확장과 같은 환경 파일을 씁니다. 집(Ollama)과 회사(Gemma)는 모드만 바꿉니다.

```bash
pnpm client:build            # 개발 기본값 (모의 모델 localhost:4174)
pnpm client:build:home       # .env.home.local
pnpm client:build:company    # .env.company.local  (WXT_LLM_BASE_URL, WXT_LLM_API_KEY, WXT_LLM_MODEL, WXT_LLM_HEADERS …)
```

`client/dist/dogent.mjs`에는 API 키가 들어갑니다. 저장소에 올리지 않고(.gitignore), 사내에서만 나눕니다.

## 처음 한 번

1. 토큰 확인: `pnpm client token` (또는 `node client/dist/dogent.mjs token`)
2. 브라우저의 Dogent 사이드 패널 → 설정 → 클라이언트 연결: WebSocket(또는 Native Messaging)을 켜고 토큰을 넣고 저장
3. 사용자 값이 필요하면: `pnpm client config llm.userId <SSO ID>`
4. 팀 스킬 저장소를 받아 두었으면: `pnpm client config teamSkills D:\work\dogent-skills`

Claude Code가 같은 브리지를 띄워 두었으면 포트가 겹칩니다. 둘 중 하나만 켜세요.

## 쓰기

```bash
pnpm client                                   # 대화: "무엇을 할까요? >"
pnpm client "8라인 재공 확인해줘"               # 맞는 스킬을 골라 입력값을 뽑아 실행
pnpm client "8라인 선택하고 조회해서 몇 건인지 알려줘"   # 맞는 스킬이 없으면 지금 화면에서 자유 요청 → 끝나면 스킬로 저장할지 묻는다
pnpm client run wip-check line=7라인           # 스킬을 입력값으로 바로 실행
pnpm client run wip-adjust source=D:\조정.xlsx  # 파일 입력은 경로로
pnpm client skills                            # [개인] [팀] [기본]
pnpm client skills search 홀드 해제            # 말로 스킬 찾기 (조사·어미가 붙어도). 말이 없으면 지금 브라우저 화면의 사이트용 스킬
pnpm client skills info hold-release          # 입력, 위험도, 담당, 이 PC에서의 성공률
pnpm client doctor                            # 확장이 안 붙을 때 원인 점검: 토큰, 포트, Native Messaging 등록, 회사 정책(크롬·엣지), 호스트 실행, 실시간 시험
pnpm client doctor --fix                      # Native Messaging 호스트를 등록 (터미널 dogent는 등록하지 않으므로 앱 없이 쓸 때 필요). 확장을 못 찾으면 --id <확장 ID>
pnpm client systems                           # 사내 시스템 사전 (이름·별칭). 요청에 시스템 이름이 나오면 그 시스템 설명을 모델에 함께 보여 준다
pnpm client systems info mes                  # 화면(메뉴 경로), 용어, 이 시스템의 스킬 (docs/05-skill-spec.md 6-1)
pnpm client skill new "라인 골라 HOLD Lot을 사유별로 정리해 줘. 라인은 매번 다름"   # 말로 스킬 만들기: 지금 화면을 보고 초안 → 말로 고치기 → 시험 → 저장
pnpm client skill edit wip-check              # 편집기로 열고, 닫으면 품질 검사 (DOGENT_EDITOR, 기본 notepad)
pnpm client check D:\my\SKILL.md              # 품질 검사
pnpm client schedule add 아침재공 --at 09:00 --days 월,수,금 wip-check line=7라인   # 작업 스케줄러에 예약 (로그인해 있을 때만, 저장·상신은 안 함)
pnpm client schedule list                     # 예약과 다음 실행 시각
pnpm client schedule remove 아침재공
pnpm client sync                              # 팀 스킬 저장소 git pull
```

| 옵션 | |
|---|---|
| `--yes` | 실행 전 확인을 묻지 않음 |
| `--allow-write` | 자유 요청에서 저장·상신 버튼 허용 (누르기 전에 승인 창) |
| `--dry-run` | 저장·상신 직전에 멈춤 |
| `--wait <초>` | 확장 연결을 기다리는 시간 (기본 60) |

실행 중 Ctrl+C는 멈춤, 한 번 더 누르면 끝냅니다. 결과 엑셀은 기본으로 내려받기 폴더에 저장합니다 (`config outputDir`로 바꿈).

## 브라우저가 여럿일 때

크롬과 엣지 둘 다 확장을 연결해 두면 둘 다 붙습니다.

```bash
pnpm client browsers                    # 연결된 브라우저 (6초 기다렸다가 보여 줌)
pnpm client tabs --browser 크롬          # 이번만 그 브라우저
pnpm client config browser edge         # 늘 그 브라우저
```

- 같은 종류가 둘이면 확장의 클라이언트 연결 → **이 브라우저 이름**에 이름을 붙입니다.
- 번호는 실행마다 다시 매겨지므로 명령에는 이름을 씁니다. 대화 모드에서는 `browser 2`도 됩니다.
- 한 번 고른 브라우저는 실행 중에 바뀌지 않습니다.

## 엑셀 (오피스 도구)

`pnpm office:build`로 `office/dist/dogent-office.exe`를 만들어 두면 클라이언트가 찾아 씁니다. 자세한 것은 [office/README.md](../office/README.md).

```bash
pnpm client excel D:자료재공.xlsx       # Excel로 열어 시트와 앞부분 보기
pnpm client excel docs                    # 사용자의 Excel에 열린 문서 (문서 공유망에서 연 문서 등)
pnpm client excel resave <원본> <새 경로>  # Excel로 다시 저장 (문서 보안 재암호화 확인용)
```

- 스킬의 엑셀 파일 입력은 먼저 직접 읽고, 안 되면(문서 보안 파일 등) Excel로 엽니다.
- `config saveThroughExcel true`면 결과 엑셀을 Excel을 거쳐 저장합니다.

## 스킬 폴더

| 출처 | 위치 |
|---|---|
| 개인 | `%USERPROFILE%\.dogent\skills\<id>\SKILL.md` (자유 요청을 저장하면 여기에 생김) |
| 팀 | `config teamSkillsUrl`의 `index.json` 주소에서 받아 둔 것(`%USERPROFILE%\.dogent\team-cache`, git 필요 없음), 또는 `config teamSkills`로 알려 준 폴더 (dogent-skills 저장소를 git clone한 곳, `skills/<id>/SKILL.md`) |
| 기본 | 빌드할 때 저장소의 `skills/`를 넣은 것 |

같은 id면 개인 > 팀 > 기본 순서로 앞의 것을 씁니다.

팀 스킬 저장소를 주소로 받기 (확장의 "공유 스킬 저장소"와 같은 `index.json`):

```bash
pnpm client config teamSkillsUrl https://(GitHub 호스트)/(조직)/dogent-skills/raw/main/skills/index.json
pnpm client config teamSkillsToken (개인 토큰)   # 비공개 저장소일 때 (Authorization: token …)
pnpm client sync                                  # 지금 받기. 평소에는 한 시간에 한 번 스스로 받는다
```

- 빌드 설정의 `WXT_SKILLS_URL`이 기본 주소가 됩니다 (확장과 같은 값).
- 목록에 적힌 파일만, 해시가 맞고 품질 검사 오류가 없는 것만 받습니다. 닿지 않으면 마지막으로 받아 둔 것을 씁니다.
- 스킬이 많으면 말로 요청할 때 맞는 스킬과 지금 화면의 사이트를 다루는 스킬 20개만 모델에 보여 줍니다.

## 시험

```bash
pnpm build && pnpm client:build && pnpm e2e:client
```

실제 Chromium에 확장을 올리고 클라이언트를 별도 프로세스로 띄워, 스킬 실행·말로 요청·승인 창 상신·자유 요청을 스킬로 저장·사이트 목록 밖 차단을 확인합니다.
