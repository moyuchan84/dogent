# dogent-hub — Hub 최소안과 LLM 프록시 (샘플)

> 이 폴더는 **샘플**입니다. Dogent 저장소의 `templates/dogent-hub`에서 왔고, 사내 표준(배포 방식, 인증, 저장소)에 맞게 고쳐 쓰세요. 설계는 `docs/20-target-architecture.html` 5-3, 5-4, 7장, 설명은 `docs/21-hub-and-llm-proxy.md`.

두 서버가 들어 있고, 둘 다 Node 20 이상만 있으면 돌아갑니다 (`npm install` 없음).

| 파일 | 하는 일 |
|---|---|
| `tools/hub.mjs` | **Hub**: 정책·중지 스위치를 내려 주고, 실행 요약(값·화면 글자 없음)을 받아 통계를 낸다 |
| `tools/llm-proxy.mjs` | **LLM 프록시**: 클라이언트의 OpenAI 호환 요청을 사내 Gemma 게이트웨이로 그대로 전달한다. 키는 서버에만 있다 |
| `schema.sql` | PostgreSQL 스키마 (문서용, 구현은 아직 없음) |
| `Dockerfile`, `deploy/k8s.yaml` | 컨테이너와 k8s 배치 예시 |

`tools/*.mjs`는 생성된 파일입니다. 고치지 말고 Dogent 저장소에서 `pnpm hub:bundle`로 다시 만듭니다.

## Hub 실행

```
export HUB_TOKEN=<클라이언트용 토큰>
export HUB_ADMIN_TOKEN=<관리용 토큰>
node tools/hub.mjs --data ./hub-data --port 8790 --host 0.0.0.0
```

- 토큰은 둘 다 **16자 이상, 서로 다르게**. 하나라도 없으면 서버가 시작하지 않습니다.
- 토큰 만들기: `node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"`
- `--data` 폴더에 `state.json`(정책·중지 스위치), `runs.jsonl`(실행 요약), `audit.jsonl`(관리 감사)이 쌓입니다. **한 프로세스만** 쓰세요 (복제 1).
- `--host`를 `0.0.0.0`으로 열 때는 앞단에 HTTPS 리버스 프록시를 두세요. 토큰은 평문 헤더로 갑니다.

| 환경 변수 | 뜻 |
|---|---|
| `HUB_TOKEN` | 클라이언트용: `GET /v1/policy`, `POST /v1/runs` |
| `HUB_ADMIN_TOKEN` | 관리용: `/v1/admin/*` (클라이언트용 기능도 쓸 수 있다) |

### 엔드포인트

| 요청 | 인증 | 설명 |
|---|---|---|
| `GET /health` | 없음 | `{ok:true}` |
| `GET /v1/policy` | 클라이언트 | `{version, issuedAt, ttlSec, killSwitches:[{id,scope,target,reason,since}], notice?}`. `ETag`/`If-None-Match`로 304 |
| `POST /v1/runs` | 클라이언트 | 실행 요약 하나 또는 배열(200건까지). `runId`로 멱등. 응답 `{accepted, duplicates, rejected}` |
| `PUT /v1/admin/policy` | 관리 | `{ttlSec?, notice?}` (notice는 null로 지움) |
| `POST /v1/admin/killswitch` | 관리 | `{scope:'skill'｜'system'｜'all', target, reason}` |
| `DELETE /v1/admin/killswitch/:id` | 관리 | 해제 |
| `GET /v1/admin/stats?days=7` | 관리 | 스킬별 실행 수·성공률·평균 시간·연속 실패, 사용자 수 |
| `GET /v1/admin/audit?limit=100` | 관리 | 관리 행위 기록 (최근 것 먼저) |

### 정책·중지 스위치 예시 (curl)

```
HUB=http://서버:8790
A="Authorization: Bearer $HUB_ADMIN_TOKEN"

# 정책 만료 시간(초)과 공지
curl -X PUT $HUB/v1/admin/policy -H "$A" -H 'content-type: application/json' -d '{"ttlSec":600,"notice":"금요일 18시 점검"}'

# 스킬 하나를 중지 / 시스템 하나를 중지 / 전부 중지
curl -X POST $HUB/v1/admin/killswitch -H "$A" -H 'content-type: application/json' -d '{"scope":"skill","target":"gsams-request","reason":"화면이 바뀌어 깨짐"}'
curl -X POST $HUB/v1/admin/killswitch -H "$A" -H 'content-type: application/json' -d '{"scope":"system","target":"gsams","reason":"시스템 점검"}'
curl -X POST $HUB/v1/admin/killswitch -H "$A" -H 'content-type: application/json' -d '{"scope":"all","reason":"긴급 중지"}'

# 해제 (id는 위 응답이나 GET /v1/policy 에 있다)
curl -X DELETE $HUB/v1/admin/killswitch/<id> -H "$A"

# 통계와 감사
curl "$HUB/v1/admin/stats?days=7" -H "$A"
curl "$HUB/v1/admin/audit?limit=50" -H "$A"
```

## LLM 프록시 실행

```
export LLM_UPSTREAM_URL=https://(게이트웨이)/v1          # 여기에 /chat/completions 를 붙여 보낸다
export LLM_UPSTREAM_KEY=<게이트웨이 키>
export LLM_UPSTREAM_HEADERS='{"x-dep-ticket":"{key}","Send-System-Name":"{systemName}","user-id":"{userId}","user-type":"{userType}","prompt-msg-id":"{uuid}","completion-msg-id":"{uuid}","content-type":"application/json"}'
export LLM_SYSTEM_NAME=dogent
export LLM_DEFAULT_USER_TYPE=employee
node tools/llm-proxy.mjs --tokens ./tokens.json --port 8791 --host 0.0.0.0 --rate 60 --audit ./llm-audit.jsonl
```

- `LLM_UPSTREAM_HEADERS`의 자리표시자는 클라이언트의 `WXT_LLM_HEADERS`와 같은 뜻입니다: `{key}` 업스트림 키, `{userId}`·`{userType}`는 **토큰 표에서 정한 값**, `{systemName}`, `{uuid}`(요청마다 새로). 틀을 안 주면 `Authorization: Bearer <키>`.
- `--tokens`: 개인 토큰 표(JSON). 파일을 고치면 재시작 없이 반영됩니다.

  ```json
  { "tokens": {
      "kim-4f9a…(긴 무작위 문자열)": { "userId": "kim", "userType": "employee" },
      "lee-77c1…": "lee",
      "<토큰의 sha256 16진수 64자>": { "userId": "park" }
  } }
  ```

  키는 토큰 원문이거나 sha256 16진수입니다 (파일에 원문을 두지 않으려면 해시로: `node -e "console.log(require('crypto').createHash('sha256').update('토큰').digest('hex'))"`).
- `--rate N`: 사용자당 분당 N회. 넘으면 `429` + `Retry-After`. 업스트림의 429·5xx는 `Retry-After`와 함께 그대로 돌려줍니다 (재시도는 클라이언트가 합니다).
- `--audit`: 감사 기록(JSONL). 사용자, 시각, 모델, 상태 코드, 지연, 토큰 수만 남기고 **프롬프트·응답 내용은 남기지 않습니다**.
- 업스트림에 닿지 못하면 `502`와 이유를 돌려줍니다. `GET /health`는 인증 없이 열려 있습니다.
- `LLM_TIMEOUT_SEC`(기본 120): 업스트림이 응답을 시작하기까지 기다리는 시간.

## 클라이언트 연결

**Hub:** 사용자 PC에서

```
dogent config hubUrl http://서버:8790
dogent config hubToken <HUB_TOKEN>
dogent config            # Hub 줄에서 확인
```

회사 빌드에 주소를 넣으려면 `.env.company.local`에 `WXT_HUB_URL=http://서버:8790` (토큰은 빌드에 넣지 않고 각자 설정). 설정이 없으면 Hub와 관련된 일은 하나도 하지 않습니다.

**LLM 프록시:** 클라이언트 코드는 바꿀 필요가 없습니다. 기존 모델 설정만 바꿉니다.

```
dogent config llm.baseUrl http://서버:8791/v1
dogent config llm.apiKey <개인 토큰>
```

회사 빌드가 `WXT_LLM_HEADERS`(x-dep-ticket 등)를 쓰고 있었다면, 프록시를 쓸 빌드는 `WXT_LLM_HEADERS`를 **비우고** `WXT_LLM_BASE_URL=http://서버:8791/v1`, `WXT_LLM_API_KEY=<개인 토큰>`으로 빌드해야 `Authorization: Bearer <개인 토큰>`이 나갑니다. 업스트림 헤더 틀은 프록시 서버가 가집니다. 이미 헤더 틀이 든 빌드를 쓰는 PC에서는 ~/.dogent/config.json의 llm에 "headers": null 을 넣어 Authorization 방식으로 되돌릴 수 있습니다.

## 데이터 보관과 개인정보 원칙

- Hub는 실행 요약의 **화이트리스트 필드**만 저장합니다: runId, userId, skillId, skillVersion, risk, result, startedAt, durationMs, modelCalls, errorClass(짧은 분류어), approved, clientVersion. 표 값, 화면 글자, 입력값, 요청 문장은 서버에 오지도 않고, 와도 버립니다.
- LLM 프록시는 프롬프트·응답을 어디에도 쓰지 않습니다 (메모리에서 흘려 보내기만).
- 보관 기간(예: 90일)과 삭제 작업은 보안 부서와 정하세요. 파일 저장소는 `runs.jsonl`의 오래된 줄을 지우는 작업을 따로 돌려야 합니다.
- 토큰은 환경 변수/Secret으로만 두고 저장소·로그에 남기지 않습니다.

## 한계

- 파일 저장소는 **단일 인스턴스**입니다. 여러 대로 늘리려면 `Store` 인터페이스(`tools/hub-core.ts`)를 PostgreSQL로 구현해야 합니다 (`schema.sql`).
- 사내 SSO가 아니라 **공유 토큰**입니다. 클라이언트가 보내는 `userId`를 서버가 믿습니다.
- LLM 프록시의 속도 제한은 프로세스 메모리라 복제마다 따로 셉니다.
