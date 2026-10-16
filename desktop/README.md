# Dogent 데스크탑 (Electron)

터미널 클라이언트에 화면을 입힌 앱입니다. 엔진은 같습니다(`client/src/session.ts`). 그래서 터미널에서 되는 일은 앱에서도 똑같이 되고, 스킬 폴더·설정·실행 기록도 같은 것(`%USERPROFILE%\.dogent`)을 씁니다.

```
Dogent 앱 ─ 브리지(앱 안) ─ WebSocket / Native Messaging ─ 브라우저의 Dogent 확장 ─ 업무 화면
   ├─ 사내 Gemma (모델)
   └─ 오피스 도구 dogent-office.exe (Excel, 문서 보안 문서, EDM 문서)
```

## 화면

| 곳 | 하는 일 |
|---|---|
| 위쪽 | 연결된 브라우저 고르기 (크롬·엣지가 함께 붙으면 골라 씀), 설정 |
| 왼쪽 · 스킬 | 개인 > 팀 > 기본 스킬. 누르면 입력 칸이 대화에 나와 바로 실행 |
| 왼쪽 · 엑셀 문서 | 지금 Excel에 열린 문서 (EDM에서 읽기·편집으로 연 문서 등) |
| 가운데 | 대화. 실행은 카드 하나로 단계·승인 안내·결과(저장한 파일 → 폴더에서 보기)를 보여 줌. 묻는 것은 카드로 답함 |
| 아래 | 요청 입력 (Enter 보내기). 실행 중에는 중지. 자유 요청의 저장·상신 허용, 시험 실행 |
| 설정 | 확장 연결 토큰(복사), 사용자 ID, 쓸 브라우저, 결과 저장 폴더, 팀 스킬 폴더 |

저장·상신은 앱에 무엇을 승인하는지 보이고, 실제 승인은 브라우저에 뜨는 **Dogent 승인 창**에서 합니다 (확장이 지키는 안전장치, docs/09 D6).

## 빌드와 실행

```bash
pnpm install                  # 처음 한 번 (Electron을 내려받음)
pnpm desktop:build            # 모의 모델 / --mode home / --mode company
pnpm desktop                  # 빌드한 앱 띄우기
pnpm desktop:pack             # 한 파일 실행본 desktop/release/Dogent-<판>.exe (회사 설정은 desktop:pack:company)
```

- 회사 설정(`.env.company.local`)으로 빌드하면 앱에 API 키가 들어갑니다. 실행본은 사내에서만 나눕니다 (`desktop/dist`, `desktop/release`는 저장소에 올라가지 않음).
- 사내망에서 Electron을 내려받지 못하면 사내 미러를 씁니다: `set ELECTRON_MIRROR=<사내 미러>/electron/` 후 `pnpm install`.
- 오피스 도구를 함께 넣으려면 먼저 `pnpm office:build`. 실행본을 만들 때 `office/dist/dogent-office.exe`가 있으면 함께 들어갑니다.

## 처음 한 번

1. 앱의 **설정** → 확장 연결 토큰을 **복사**
2. 브라우저의 Dogent 사이드 패널 → 설정 → 클라이언트 연결 → WebSocket, 토큰 붙여 넣기 → 저장
3. 앱 위쪽에 브라우저 이름이 보이면 연결된 것입니다 (크롬·엣지 둘 다 했으면 둘 다 보이고 골라 씀)

터미널 클라이언트와 앱을 동시에 켜면 브리지 포트가 겹칩니다. 하나만 켭니다.

## 시험

```bash
pnpm build && pnpm desktop:build && pnpm e2e:desktop
```

실제 앱을 띄워 말로 요청 → 실행, 스킬 눌러 실행, 승인 창 상신, 자유 요청을 스킬로 저장, 설정을 확인합니다.
