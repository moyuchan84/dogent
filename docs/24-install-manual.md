# Dogent 설치 매뉴얼

> 기준일 2026-11-09 · 저장소 main (훅, MCP 카탈로그, 브라우저 자동 실행 반영)
> 이 문서는 **처음 설치하는 사람**을 위한 한 장짜리 순서입니다. 자세한 문제 해결은 [12-install-guide.html](12-install-guide.html), 회사 PC 재설치는 [15-company-reinstall.html](15-company-reinstall.html), 사내 opencode에 맡기는 요청문은 [16-opencode-install.md](16-opencode-install.md).
> 서버 쪽(스킬 저장소, MCP 카탈로그, 시스템 사전, Hub, LLM 프록시) 준비는 [25-infra-setup.md](25-infra-setup.md).

## 1. 무엇이 설치되나

| 구성 | 위치 | 하는 일 | 필요한 것 |
|---|---|---|---|
| 브라우저 확장 | `extension\` (크롬·엣지에 로드) | 업무 화면을 읽고 조작. 승인 창, 사이트 허용, 화면 점검 | 크롬 또는 엣지 |
| 데스크탑 앱 | `app\Dogent.exe` | 말로 요청하고 스킬을 실행하는 창. 확장과의 연결을 스스로 등록 | 없음 (Node 불필요) |
| 오피스 도구 | `dogent-office.exe` | 사용자의 Excel·Word·PowerPoint를 COM으로 부림 (NASCA·EDM 문서) | Office 설치된 PC |
| 터미널 클라이언트 | `dogent.mjs`, `bin\dogent.cmd` | 앱과 같은 엔진의 명령줄 판. 예약 실행, MCP·훅 관리 | Node.js 22 이상 |

설치 위치는 `D:\Multimedia\Dogent`(없으면 `%LOCALAPPDATA%\Dogent`). 내 스킬·설정·기록·토큰은 `%USERPROFILE%\.dogent`에 있고 업데이트·제거해도 남습니다.

## 2. 역할 나누기

- **배포 담당자:** 빌드해서 묶음(zip)을 만든다 (3장).
- **사용자:** 묶음을 풀고 `install.cmd`를 누른 뒤 확장을 로드한다 (4장).

혼자 쓰는 PC라면 두 역할을 모두 한 PC에서 합니다 (`-Install` 옵션).

## 3. 배포 담당자: 빌드

### 3-1. 준비물 확인

```bat
node -v          :: 22 이상
pnpm -v          :: 없으면 build.cmd가 corepack으로 켬
git --version
```

.NET Framework 4.x의 `csc.exe`(윈도우 기본)로 오피스 도구를 컴파일하므로 Visual Studio는 필요 없습니다.

### 3-2. 빌드 설정 파일 (회사 모드)

```bat
copy .env.company.example .env.company.local
notepad .env.company.local
```

반드시 채울 값 (API 제공 측에서 받음):

| 키 | 뜻 |
|---|---|
| `WXT_LLM_BASE_URL` | `api_base_url` (`/chat/completions` 앞까지) |
| `WXT_LLM_API_KEY` | `credential_key` |
| `WXT_LLM_MODEL` | `model` |
| `WXT_LLM_USER_TYPE` | 사용자 유형 |

선택 값: `WXT_LLM_HEADERS`(헤더 틀), `WXT_LLM_JSON_MODE`, `WXT_LLM_VISION`, `WXT_LLM_TIMEOUT_SCALE`, `WXT_SKILLS_URL`, `WXT_SYSTEMS_URL`, `WXT_HUB_URL`, `WXT_BRIDGE_MODE`. 각 키의 뜻은 `.env.company.example` 주석에 있습니다. 파일에 `(…)` 자리가 남아 있으면 빌드가 멈춥니다.

> **주의:** 회사 모드 묶음에는 API 키가 글자 그대로 들어갑니다. 사내 파일 서버로만 나누고 저장소·메일·메신저·개인 GitHub에 올리지 않습니다. `release\`와 `*.local`은 Git에서 빠져 있습니다.

기본 동작은 **모든 http·https 사이트 허용**입니다 (접근하면 안 되는 주소는 사내 방화벽센터가 막음). 보안 검토로 목록 방식이 필요하면 `WXT_ALL_SITES=false`를 넣고, 그러면 `WXT_SITE_PERMISSIONS`의 사이트만 처음부터 열리고 나머지는 사용자가 패널의 "이 사이트 허용"으로 더합니다.

### 3-3. 빌드

```bat
install\build.cmd -Mode company -Zip
```

결과: `release\Dogent-company-<판>\` 과 `release\Dogent-company-<판>.zip`.

| 옵션 | 뜻 |
|---|---|
| `-Mode dev\|home\|company` | 빌드 설정. dev=모의 모델, home=`.env.home.local`(Ollama), company=`.env.company.local` |
| `-Parts extension,client,office,desktop` | 일부만 빌드 |
| `-Zip` | zip도 만듦 |
| `-Install` | 만든 뒤 이 PC에 바로 설치 |
| `-Test` | 빌드 전에 타입 검사와 단위 시험 |
| `-Reinstall` | `pnpm install` 다시 |

빌드 터미널의 "빌드 설정: company" 요약에서 **주소·모델·헤더 이름**을 눈으로 확인하고 나눕니다.

한 부분만 고쳤을 때:

```bat
pnpm build:company           :: 확장  → .output\chrome-mv3-company
pnpm client:build:company    :: 터미널 클라이언트
pnpm office:build            :: 오피스 도구
pnpm desktop:pack:company    :: 데스크탑 앱 (오피스 도구를 먼저 빌드)
```

## 4. 사용자: 설치

1. 받은 `Dogent-company-<판>.zip`을 **풉니다** (zip 안에서 바로 실행하면 파일을 못 찾습니다).
2. `install.cmd`를 두 번 누릅니다. "Windows의 PC 보호"가 뜨면 추가 정보 → 실행.
3. 스크립트가 크롬/엣지 확장 관리 화면을 열고 확장 폴더 경로를 클립보드에 넣어 둡니다.
   - 개발자 모드 켜기 → **압축해제된 확장 프로그램을 로드합니다** → `Ctrl+V` → 폴더 선택
   - 퍼즐 아이콘에서 Dogent 고정(핀)
   - 크롬과 엣지를 둘 다 쓰면 둘 다 로드
4. 창으로 돌아가 Enter. 스크립트가 앱을 띄웁니다. 앱은 처음 뜰 때 확장을 찾아 연결(Native Messaging)을 스스로 등록합니다.
5. 앱 위쪽에 **브라우저 이름(크롬/엣지)** 이 보이면 연결된 것입니다.

> 확장은 반드시 `D:\Multimedia\Dogent\extension`에서 로드합니다. 저장소의 `.output\…`이나 `release\…`에서 로드하면 업데이트 때 경로가 달라집니다.

## 5. 처음 한 번 설정 (사용자)

| 순서 | 할 일 | 성공 기준 |
|---|---|---|
| 1 | 사이드 패널 → 설정 → **사용자 ID**에 사내 SSO ID 입력 (앱·`dogent`는 Windows 계정이 기본값) | — |
| 2 | 설정 → **연결 시험** | "연결됨". "닿지 못했습니다"+`이 주소 접근 허용` 버튼이 나오면 누름 |
| 3 | 업무 화면을 열고 패널 위 **화면 점검** | 읽지 못하는 iframe·canvas 그리드·shadow DOM이 보고서에 나옴 |
| 4 | 터미널에서 `dogent doctor` | 토큰·포트·호스트 등록·회사 정책·실시간 연결 모두 OK |

확장이 안 붙으면 `dogent doctor --fix`(호스트 재등록).

### 새로 생긴 편의 (이번 판)

- **브라우저 자동 실행:** 브라우저가 꺼져 있으면 `dogent`가 크롬/엣지를 대신 띄웁니다(이미 떠 있으면 새 창을 더 열지 않음). 어느 브라우저인지는 `dogent config browser edge`로 정합니다. 사내 PC에서의 동작은 아직 확인하지 못했습니다.
- **훅, `/명령`, `계획:`**: 별도 설치 없이 클라이언트에 들어 있습니다 (사용법은 [26-usecase-guide.md](26-usecase-guide.md)).
- **MCP 카탈로그:** 팀 저장소 주소만 정해 두면 `dogent mcp browse / install`을 쓸 수 있습니다 ([25-infra-setup.md](25-infra-setup.md) 3장).

## 6. 업데이트와 제거

| 상황 | 방법 |
|---|---|
| 묶음을 받아 쓰는 PC | 새 묶음을 풀고 `install.cmd` 다시. 같은 폴더에 덮어쓰고 확장은 1분 안에 스스로 새 판을 읽음 |
| 저장소가 있는 PC | `install\update.cmd` (git pull → 전부 빌드 → 덮어쓰기 → 앱 재실행). `-Mode`, `-NoPull` 옵션 |
| 제거 | 시작 메뉴 → Dogent 제거 (`uninstall.cmd`). 설정·스킬까지 지우려면 `uninstall.cmd -Purge`. 확장은 브라우저에서 직접 삭제 |

## 7. 설치 확인 체크리스트

- [ ] `D:\Multimedia\Dogent\app\Dogent.exe`가 실행된다
- [ ] 앱 위쪽에 브라우저 이름이 뜬다
- [ ] 패널 → 설정 → 연결 시험이 "연결됨"
- [ ] `dogent doctor`가 모두 통과한다
- [ ] 업무 화면에서 **화면 점검** 보고서가 나온다
- [ ] `dogent "이 화면 요약해줘"`가 결과를 낸다
- [ ] (Excel 사용 시) `dogent excel docs`가 열린 문서를 보여 준다

## 8. 자주 막히는 곳

| 증상 | 확인 |
|---|---|
| 앱에 브라우저 이름이 안 뜬다 | 확장이 `D:\Multimedia\Dogent\extension`에서 로드됐는지, `dogent doctor --fix` |
| 연결 시험 실패 | `WXT_LLM_BASE_URL`, 사내망/VPN, "이 주소 접근 허용", 헤더 틀 |
| 포트 39217 충돌 | 공용 PC·원격 데스크톱에서 두 번째 사용자는 브리지를 못 띄움 → Native Messaging 방식 사용 |
| 실행 파일이 보안 SW에 차단 | `Dogent.exe`, `dogent-office.exe` 예외 요청 (사내 확인 목록 C6) |
| 확장 ID가 바뀜 | `keys\dogent-extension.pem`(저장소 제외)을 분실했거나 로드 경로가 바뀐 경우. 키를 안전한 곳에 백업 |
| `dogent` 명령을 못 찾음 | 새 터미널을 열어 PATH 갱신 확인, 또는 `D:\Multimedia\Dogent\bin\dogent.cmd` |

## 9. 집(Ollama)·모의 환경에서 시험하기

```bash
pnpm install
pnpm build:home            # .env.home.local (Ollama 설정)
pnpm mock:site             # 모의 업무 사이트 http://localhost:4173
pnpm ollama:proxy          # 또는 pnpm mock:llm (모의 모델)
```

`.output\chrome-mv3-home`을 로드해 시험합니다. 자세한 순서는 [README.md](../README.md)와 [08-hands-on-guide.html](08-hands-on-guide.html).
