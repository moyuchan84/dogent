# 16. opencode로 회사 PC 설치 자동화

회사 PC의 opencode에 Dogent 빌드·설치를 맡기는 안내입니다. 사람이 읽기 좋은 HTML판은 [16-opencode-install.html](16-opencode-install.html), 사람이 손으로 하는 순서는 [15-company-reinstall.html](15-company-reinstall.html)에 있고, 이 문서는 그 순서를 **사람에게 묻지 않고 멈추지 않는 명령**으로 바꾼 것입니다.

- 전제: 저장소를 받았고, 저장소 루트에 `.env.company.local`을 채워 두었습니다.
- opencode가 하는 일: 점검 → 빌드 → `D:\Multimedia\Dogent`에 설치 → 앱 실행 → 결과 확인 → 보고
- 사람이 하는 일: 브라우저에 확장을 처음 한 번 로드하고, 사이드 패널에서 연결과 사용자 ID를 설정합니다. 브라우저 화면 조작이라 opencode가 할 수 없습니다.
- 설치 폴더가 `D:\Multimedia\Dogent`인 이유: 사내 보안 프로그램(EDM/NASCA) 때문에 크롬은 `D:\Multimedia` 아래 폴더의 확장만 로드할 수 있습니다. 설치 프로그램은 `D:\Multimedia`가 있으면 그 아래에, 없으면 `%LOCALAPPDATA%\Dogent`에 설치합니다. 예전 `%LOCALAPPDATA%\Dogent` 설치는 새 설치가 정리합니다.

## 1. opencode에 넣을 요청

저장소 루트에서 opencode를 열고 아래를 그대로 붙여 넣습니다.

```text
docs/16-opencode-install.md 를 읽고 "2. 에이전트 절차"를 순서대로 실행해 줘.
- 명령은 문서에 적힌 그대로 쓰고, 대화형 스크립트(.cmd)는 실행하지 마.
- .env.company.local 의 값은 화면에 출력하거나 커밋하지 마.
- 단계가 실패하면 "4. 실패했을 때" 표대로 한 번만 조치해 보고, 그래도 안 되면 멈추고 오류 메시지를 그대로 보여 줘.
- 끝나면 "5. 보고 양식"으로 보고해 줘.
```

이미 설치한 PC에서 업데이트만 할 때는 이렇게 요청합니다.

```text
docs/16-opencode-install.md 의 "3. 업데이트 절차"를 실행하고 "5. 보고 양식"으로 보고해 줘.
```

## 2. 에이전트 절차 (처음 설치)

> **opencode에게:** 아래 규칙을 지킵니다.
>
> 1. `install\*.cmd`는 실행하지 않습니다. 끝에 `pause`나 `timeout`이 있어 멈춥니다. 항상 `powershell -NoProfile -ExecutionPolicy Bypass -File install\*.ps1 ...`로 부릅니다.
> 2. `install.ps1`은 반드시 `-Quiet`로 부릅니다. 빼면 `Read-Host`에서 입력을 기다리며 멈춥니다. `build.ps1 -Install`도 첫 설치에서는 확장 로드를 기다리며 멈추므로 쓰지 않습니다.
> 3. `.env.company.local`을 `cat`/`Get-Content`로 출력하지 않습니다. 키가 들어 있습니다. 검사는 아래 명령처럼 빈 자리만 찾습니다.
> 4. `release\` 폴더와 `.env.*.local` 파일은 커밋하지 않습니다. `.gitignore`에 들어 있으니 `git add -f`를 쓰지 않습니다.
> 5. 관리자 권한은 필요 없습니다. 관리자 권한을 요구하는 조치는 하지 말고 멈춥니다.
> 6. 명령은 저장소 루트에서 PowerShell로 실행합니다. 셸이 bash라면 각 명령을 `powershell -NoProfile -Command "..."`로 감쌉니다. `powershell`을 찾지 못하면 전체 경로 `C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe`를 씁니다.
> 7. 설치 폴더에 `-Target`을 넘기지 않습니다. 기본값(`D:\Multimedia\Dogent`)이어야 크롬이 확장을 로드할 수 있고, 예전 `%LOCALAPPDATA%\Dogent` 설치도 정리됩니다.

### 2-1. 준비물 점검

```powershell
node -v                         # v22 이상이어야 한다
pnpm -v                         # 없으면: corepack enable pnpm  (그래도 없으면 npm install -g pnpm)
git status --short              # 저장소 루트인지 확인. 고친 파일이 있으면 보고에 적는다
Test-Path .env.company.local    # True 여야 한다
Test-Path "$env:SystemRoot\Microsoft.NET\Framework64\v4.0.30319\csc.exe"   # False면 오피스 도구만 뺀다 (4절)
Test-Path D:\Multimedia         # True 여야 한다. False면 멈추고 보고 (그대로 설치하면 %LOCALAPPDATA%\Dogent에 깔려 크롬이 확장을 못 읽는다)
```

### 2-2. 회사 설정 빈칸 검사 (값은 출력하지 않음)

```powershell
Select-String -Path .env.company.local -Pattern '=\((api_base_url|credential_key|model|user_type)\)' | ForEach-Object { $_.Line.Split('=')[0] }
```

아무것도 나오지 않아야 합니다. 변수 이름이 나오면 **멈추고** 사람에게 그 변수를 채워 달라고 합니다. 이 상태로 빌드하면 스크립트가 메모장을 띄우고 실패합니다.

### 2-3. 빌드하고 배포 묶음 만들기

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File install\build.ps1 -Mode company -Test
```

- 확장, 터미널 클라이언트, 오피스 도구, 데스크탑 앱을 빌드하고 `release\Dogent-company-<판>\`에 묶습니다.
- `-Test`는 typecheck와 단위 시험을 먼저 돌립니다. 시험이 실패하면 멈추고 실패한 시험 이름을 보고합니다. 시험 없이 설치만 급하면 사람에게 물은 뒤 `-Test`를 뺍니다.
- 처음에는 `pnpm install`과 Electron 다운로드로 수 분이 걸립니다. 명령 제한 시간을 10분 이상으로 잡습니다.
- 마지막에 `✓ release\Dogent-company-<판>`과 `완료했습니다.`가 나와야 합니다.

### 2-4. 이 PC에 설치

```powershell
$ver = (Get-Content -Raw package.json | ConvertFrom-Json).version
powershell -NoProfile -ExecutionPolicy Bypass -File "release\Dogent-company-$ver\install.ps1" -Quiet
```

`-Quiet`라서 묻지 않고, 브라우저와 앱도 띄우지 않습니다. 켜져 있던 Dogent 앱은 닫고 덮어씁니다. 출력에 `브라우저에 확장 로드` 안내가 나오는 것은 정상입니다. 그 단계는 사람이 합니다(2-7).

### 2-5. 앱 실행 (브라우저 연결 등록)

```powershell
Start-Process "D:\Multimedia\Dogent\Dogent.exe"
Start-Sleep -Seconds 5
Get-Process Dogent -ErrorAction SilentlyContinue | Select-Object Id, StartTime
```

앱은 뜰 때마다 Native Messaging 호스트(`com.dogent.bridge`)를 스스로 등록합니다. 크롬이 띄우는 호스트 파일은 `D:\Multimedia\Dogent\native\`에 두고, 예전 위치(`%USERPROFILE%\.dogent`)에 남은 호스트 파일은 지웁니다. 토큰과 내 스킬·기록은 `%USERPROFILE%\.dogent`에 그대로 있습니다.

### 2-6. 설치 확인

```powershell
$d = "D:\Multimedia\Dogent"
'extension\manifest.json', 'Dogent.exe', 'dogent-office.exe', 'dogent.mjs', 'bin\dogent.cmd', 'build-info.txt', 'native\native-host.cmd', 'native\com.dogent.bridge.json' |
  ForEach-Object { '{0,-24} {1}' -f $_, (Test-Path (Join-Path $d $_)) }
Get-Content -Encoding UTF8 "$d\build-info.txt" -TotalCount 5      # "모드: company" 여야 한다
reg query "HKCU\Software\Google\Chrome\NativeMessagingHosts\com.dogent.bridge" 2>$null
reg query "HKCU\Software\Microsoft\Edge\NativeMessagingHosts\com.dogent.bridge" 2>$null
```

| 확인할 것 | 기대 값 |
|---|---|
| `extension\manifest.json`, `Dogent.exe`, `dogent.mjs` | True |
| `dogent-office.exe` | True (csc.exe가 없어 뺐으면 False가 맞음) |
| `build-info.txt`의 모드 | `company` |
| `native\native-host.cmd`, `native\com.dogent.bridge.json` | True (앱이 뜬 뒤) |
| NativeMessagingHosts 레지스트리 | 쓰는 브라우저 쪽 값이 `D:\Multimedia\Dogent\native\com.dogent.bridge.json`. 없으면 앱이 아직 안 떴거나 등록 전이니 10초 뒤 다시 본다 |

### 2-7. 사람에게 넘길 일 (opencode는 안내만)

opencode는 아래 내용을 그대로 사람에게 보여 주고 끝냅니다. 확장 폴더 경로는 실제 값으로 바꿔 적습니다.

1. `chrome://extensions`(엣지는 `edge://extensions`)를 엽니다.
2. 다른 폴더(`...\dogent\.output\...`, `...\release\Dogent-...`, 예전 설치 위치 `...\AppData\Local\Dogent\extension`)에서 로드한 Dogent가 있으면 **삭제**합니다.
3. 오른쪽 위 **개발자 모드**를 켜고 **압축해제된 확장 프로그램을 로드합니다**를 누른 뒤 `D:\Multimedia\Dogent\extension`을 고릅니다. 이 로드는 처음 한 번만 하면 됩니다.
4. 툴바에서 Dogent 사이드 패널을 열고 **설정 → 클라이언트 연결**에서 **Native Messaging**을 고른 뒤 저장합니다. 같은 화면에서 사용자 ID와 조작할 사이트를 넣습니다.
5. Dogent 앱 위쪽에 브라우저 이름이 보이면 연결된 것입니다.
6. 실제 업무 스킬을 돌리기 전에 대상 사내 화면을 열어 놓고, 패널이 화면을 제대로 읽는지(화면 점검) 먼저 확인합니다.

## 3. 업데이트 절차

확장을 `D:\Multimedia\Dogent\extension`에서 한 번 로드해 둔 PC라면 업데이트는 명령 하나입니다.

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File install\update.ps1 -Mode company -Test
```

- `git pull --ff-only` → 의존성이 바뀌었으면 `pnpm install` → 전부 빌드 → 덮어써 설치 → 켜져 있던 앱을 새 판으로 다시 띄웁니다.
- 고친 파일이 있으면 pull을 건너뛰고 지금 코드로 빌드합니다. 출력에 `고친 파일이 N개` 경고가 보이면 보고에 적습니다.
- git 없이 코드를 옮겨 온 PC면 `-NoPull`을 붙입니다.
- 확장은 다시 로드하지 않습니다. 확장이 폴더의 새 판을 알아채고 1분 안에 스스로 다시 읽습니다.
- 출력에 `Dogent를 다른 폴더(...)에서 로드해 두었습니다`가 보이거나, 확장 로드를 기다리며 멈추면 확장이 아직 이 폴더에서 로드되지 않은 것입니다. 2-7을 사람에게 안내합니다.
- 업데이트가 끝나면 2-6 확인을 다시 돌립니다.

## 4. 실패했을 때

| 출력에 보이는 것 | 한 번 해 볼 조치 |
|---|---|
| `Node.js가 없습니다` / `22 이상이 필요합니다` | 멈추고, 사내 소프트웨어 센터에서 Node.js LTS(22 이상)를 설치해 달라고 사람에게 요청 |
| `pnpm을 켜지 못했습니다` | `npm install -g pnpm` 후 새 셸에서 2-3 다시 |
| `채우지 않은 (…) 값이 있습니다` | 멈추고 2-2 결과의 변수를 채워 달라고 요청 (메모장이 열려 있으면 그대로 둔다) |
| `pnpm install 실패` (ETIMEDOUT, ECONNREFUSED, 403) | 사내 npm 미러 주소를 사람에게 받아 `npm config set registry <주소>` 후 2-3을 `-Reinstall`과 함께 다시 |
| Electron 다운로드 실패 | 사내 미러 주소가 있으면 `$env:ELECTRON_MIRROR='<주소>'` 후 다시. 없으면 `-Parts extension,client,office`로 데스크탑 앱을 빼고 빌드하고 보고에 적기 |
| `오피스 도구 빌드 실패` / csc.exe 없음 | `-Parts extension,client,desktop`으로 다시 빌드 (Excel 기능만 빠짐) |
| `typecheck 실패` / `단위 시험 실패` | 코드를 고치지 말고 멈춘다. 실패한 파일·시험 이름과 메시지를 보고 |
| `확장 폴더를 복사하지 못했습니다 (robocopy ...)` | 확장 폴더를 연 탐색기 창을 닫아 달라고 요청한 뒤 2-4 다시 |
| `Dogent.exe` 덮어쓰기 실패 (사용 중) | `Get-Process Dogent, dogent-office -ErrorAction SilentlyContinue \| Stop-Process -Force` 후 2-4 다시 |
| 실행 정책 오류 | 명령에 `-ExecutionPolicy Bypass`가 빠졌는지 확인. 정책 자체를 바꾸지는 않는다 |

표에 없는 오류는 조치하지 말고 멈춘 뒤 마지막 30줄을 그대로 보여 줍니다.

## 5. 보고 양식

```text
Dogent 설치 결과 (처음 설치 | 업데이트)
- 판 / 커밋: 0.1.0 / abc1234        (build-info.txt)
- 모드: company
- 시험: 통과 | 건너뜀 | 실패(이름)
- 설치된 부분: 확장 ✓  데스크탑 앱 ✓  오피스 도구 ✓/✗  터미널 클라이언트 ✓
- 앱 실행: 됨 (PID 1234)
- 브라우저 연결 등록: 크롬 ✓ / 엣지 ✓
- 빼거나 우회한 것: (없음 | 예: 데스크탑 앱 — Electron 미러 없음)
- 경고: (예: 고친 파일 2개로 pull 건너뜀)
- 사람이 할 일: 2-7의 1~6 (업데이트였고 확장이 이미 로드돼 있으면 "없음")
```
