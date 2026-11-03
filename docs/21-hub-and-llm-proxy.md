# 21. Hub와 LLM 프록시

`docs/20-target-architecture.html`의 5-3(정책·중지·기록), 5-4(모델 키 C안), 7장(데이터 모델)을 작게 구현한 것입니다. 샘플 서버와 사용법은 `templates/dogent-hub/`에 있습니다. Hub도 프록시도 **선택 사항**이며, 설정하지 않으면 Dogent는 이전과 똑같이 돕니다.

## 1. 구조

```
사용자 PC (Dogent 앱·터미널)                      사내 서버
  client/src/hub.ts  ── GET /v1/policy (ETag) ──▶  Hub (tools/hub.mjs)
                     ── POST /v1/runs ─────────▶   파일 저장소 (state.json, runs.jsonl, audit.jsonl)
  모델 호출 ── POST /v1/chat/completions ───────▶  LLM 프록시 (tools/llm-proxy.mjs) ──▶ Gemma 게이트웨이
```

| 구성요소 | 소스 | 묶은 결과 |
|---|---|---|
| Hub | `tools/hub-core.ts`(저장소 인터페이스, 파일 저장소, 요청 처리), `tools/hub.ts`(서버 시작) | `templates/dogent-hub/tools/hub.mjs` |
| LLM 프록시 | `tools/llm-proxy-core.ts`, `tools/llm-proxy.ts` | `templates/dogent-hub/tools/llm-proxy.mjs` |
| 클라이언트 | `client/src/hub.ts`, `client/src/session.ts`(실행 앞뒤), `client/src/config.ts` | |

`pnpm hub:bundle`로 서버 두 개를 `.mjs` 한 파일씩으로 묶고(rolldown, 시스템 사전 서버와 같은 방식), `pnpm hub`으로 로컬에서 Hub를 띄웁니다(`HUB_TOKEN`, `HUB_ADMIN_TOKEN` 필요).

### Hub

- `Store` 인터페이스(정책, 중지 스위치, 실행 요약, 통계, 감사) 뒤에 저장소를 둡니다. 기본은 `FileStore`(상태 JSON을 임시 파일 후 바꿔치기로 원자적으로 쓰고, 실행 요약·감사는 JSONL 추가). PostgreSQL 구현은 `schema.sql`(users, runs, skill_stats, policies, kill_switches, issue_reports, audit_log)만 있고 구현은 없습니다.
- 인증: 공유 Bearer 토큰 둘(`HUB_TOKEN` 클라이언트용, `HUB_ADMIN_TOKEN` 관리용). 토큰이 없거나 16자 미만이거나 둘이 같으면 **시작을 거부**합니다. 비교는 sha256 후 `timingSafeEqual`.
- 정책 판(version)은 정책이나 중지 스위치가 바뀔 때마다 오르고 ETag가 됩니다. 응답의 `ttlSec`이 클라이언트의 "정책 유효 시간"입니다.
- 실행 요약은 **화이트리스트 필드만** 저장합니다. 필드 모양이 틀리면 그 필드를 버리고, 필수 필드가 틀리면 그 건을 거절(rejected)합니다. 본문 1MB, 한 번에 200건 제한.

### LLM 프록시

- `POST …/chat/completions`(스트리밍 포함)를 `LLM_UPSTREAM_URL/chat/completions`로 그대로 전달합니다. 업스트림 주소·키·헤더 틀은 서버 환경 변수에만 있습니다. 헤더 틀은 `src/core/llm.ts`의 `buildHeaders`를 그대로 써서 클라이언트의 `WXT_LLM_HEADERS`와 자리표시자 의미가 같습니다.
- 사용자: `Authorization: Bearer <개인 토큰>`을 토큰 표(`--tokens`)로 확인해 userId·userType을 정하고 헤더 틀의 `{userId}`·`{userType}`에 넣습니다. 표에 없으면 401.
- 사용자별 분당 제한(`--rate`, 메모리 토큰 버킷), 업스트림 429/5xx는 `Retry-After`와 함께 그대로 돌려줍니다. 업스트림에 닿지 못하면 502.
- 감사 기록(`--audit`)에는 프롬프트·응답을 남기지 않습니다 (사용자, 시각, 모델, 상태, 지연, 토큰 수).

## 2. 클라이언트 동작

설정: `dogent config hubUrl <주소>`, `dogent config hubToken <토큰>`(빌드 기본 주소는 `WXT_HUB_URL`). `hubUrl`이 없으면 아래는 하나도 일어나지 않습니다.

- **정책 받기:** 앱은 켤 때와 5분마다, 터미널은 명령을 시작할 때(`refreshAll`) 받습니다. 마지막으로 확인한 지 `ttlSec`의 절반이 지났을 때만 서버에 묻고(ETag, 바뀐 게 없으면 304) 결과를 `~/.dogent/hub-policy.json`에 `fetchedAt`과 함께 저장합니다. 닿지 못하면 저장된 것을 씁니다. `dogent sync`는 즉시 받습니다.
- **실행 전 검사**(`Session.execute`, 스킬 실행과 자유 요청 공통): `evaluatePolicy`(순수 함수)가 판정합니다.
  1. 중지 스위치가 그 스킬 id / 그 스킬이 다루는 시스템(스킬의 허용 도메인과 시스템 사전의 도메인이 겹치는 것) / `all`에 걸리면 **실행하지 않고** 이유를 보여 줍니다. 정책이 만료되어도 마지막으로 받은 스위치는 계속 지킵니다.
  2. 정책이 **만료**됐고(`fetchedAt + ttlSec` 경과) 실행 직전에 다시 받아 보고도 Hub에 닿지 못하면, 저장·상신(R3)만 막고 R1·R2는 허용합니다 (경고만).
  3. 정책을 한 번도 받은 적이 없으면(Hub 설정만 있고 서버 불통) 막지 않고 경고만 합니다.
- **실행 요약 보내기:** 실행이 끝나면 화이트리스트 필드만 `~/.dogent/hub-outbox.jsonl`에 먼저 적고 `POST /v1/runs`로 보냅니다. 닿지 못하면 아웃박스에 남아 다음 정책 확인이나 다음 실행 때 다시 보냅니다(runId 멱등). 기다리지 않고, 타임아웃은 4초, 오류는 조용히 무시합니다. 정책에 막힌 시도도 `blocked`로 보냅니다.
  - 보내는 값: runId, userId(`llm.userId`, 없으면 Windows 계정), skillId, skillVersion, risk(R0은 R1로), result(ok｜fail｜aborted｜blocked), startedAt, durationMs, modelCalls(모델 호출 횟수), errorClass(오류 글이 아니라 login, timeout, llm, browser, office, other 같은 분류어, 또는 killswitch·expired·user·policy), approved, clientVersion.
  - 입력값, 화면 글자, 표 값, 요청 문장, 결과 글, 파일 이름은 보내지 않습니다 (`tests/hub-client.test.ts`가 고정).

### LLM 프록시를 쓰는 클라이언트

클라이언트 코드는 바꿀 필요가 없습니다. `llm.baseUrl`을 프록시 주소(`http://서버:8791/v1`)로, `llm.apiKey`를 개인 토큰으로 두고 `llm.headers`(헤더 틀)는 비웁니다. 그러면 기존 코드가 `Authorization: Bearer <개인 토큰>`으로 프록시를 부르고, 프록시가 업스트림 헤더 틀을 채워 게이트웨이로 보냅니다. 클라이언트에는 게이트웨이 키가 없습니다. 429/5xx 재시도는 클라이언트가 이미 합니다.

## 3. 운영 절차

1. 토큰 두 개를 만들고(`randomBytes(24)`) Secret/환경 변수로 넣어 `hub.mjs`를 띄웁니다. 앞단에 사내 CA의 HTTPS를 둡니다.
2. 사용자에게 `hubUrl`/`hubToken`을 알려 줍니다(회사 빌드에는 `WXT_HUB_URL`).
3. 스킬이 화면 변경으로 깨지면: `GET /v1/admin/stats`로 연속 실패를 보고, `POST /v1/admin/killswitch`로 그 스킬을 중지, 고친 뒤 `DELETE`로 해제. 감사는 `GET /v1/admin/audit`.
4. 프록시를 쓰려면 토큰 표에 사용자별 개인 토큰을 만들어 넣고 사용자에게 전달합니다. 퇴사·교체는 표에서 지웁니다(재시작 불필요).
5. 사용자 표와 로그의 보관 기간을 정하고 오래된 줄을 지우는 작업을 둡니다.

## 4. 보안

- 토큰은 서버 환경 변수/Secret에만 두고 로그·감사에 남기지 않습니다. 감사 기록에는 토큰이 들어가지 않습니다.
- 데이터 최소 수집: Hub는 화이트리스트 밖의 필드를 저장하지 않고, 프록시는 프롬프트·응답을 쓰지 않습니다.
- 클라이언트 토큰으로는 관리 기능(정책·중지 스위치·통계·감사)을 쓸 수 없습니다.
- 클라이언트는 PC에서 서버로 나가는 연결만 씁니다(인바운드 포트 없음).

## 5. 한계

- **파일 저장소 = 단일 인스턴스.** 프로세스 하나만 파일을 씁니다. k8s에서도 복제 1, `Recreate` 전략. 늘리려면 PostgreSQL 구현이 먼저입니다.
- **SSO가 아닙니다.** 공유 Bearer 토큰이고, Hub는 클라이언트가 보낸 `userId`를 믿습니다(사칭 가능). 프록시는 개인 토큰이라 그 점이 낫습니다.
- PostgreSQL은 `schema.sql`만 있습니다. 통계는 메모리에서 계산하므로 수십만 건을 넘으면 DB 구현이 필요합니다. 보관 기간 삭제 작업은 아직 없습니다.
- 자유 요청이 지금 보고 있는 화면의 시스템은 실행 전에는 알 수 없어, 시스템 중지 스위치는 요청이 말한 시스템에만 적용됩니다(스킬은 허용 도메인으로 판정). 전체(`all`)와 `free` 스킬 id 중지는 항상 적용됩니다.
- 프록시의 속도 제한은 메모리라 복제마다 따로 셉니다. 스트리밍 업스트림의 토큰 수는 마지막 조각에 `usage`가 있을 때만 기록됩니다.
- 만료 후 R3 차단은 PC의 시계와 `fetchedAt`에 기대므로 PC 시계를 바꾸면 우회됩니다(정책 응답 서명은 아직 없음).

## 6. 사내에서 확인할 것

- Hub와 프록시를 올릴 곳(k8s 또는 VM), 사내 CA HTTPS 진입점, PC에서의 접속 경로(프록시/방화벽) — docs/20의 A1, A5.
- 게이트웨이의 **개인 키 발급이 되는지**, 프록시 사용 허용 여부, 사용자별 한도 — A9. 프록시가 `x-dep-ticket` 한 개의 공용 키로 여러 사용자를 대신 호출해도 되는지(`user-id` 헤더로 구분)도 확인.
- 게이트웨이가 **스트리밍(SSE)** 을 주는지, 헤더에 한글을 허용하지 않는 점, 요청 크기 제한.
- 실행 요약의 수집 범위(userId 포함 여부)와 보관 기간에 대한 보안 부서 합의 — docs/19 C8, C26.
- 서버 로그에 남길 수 있는 정보의 기준 — A7.
- SSO(OIDC/SAML) 방식 — A4. 도입되면 공유 토큰을 사용자 토큰으로 바꿉니다.
