# 28. 도구 호출 평가 세트와 제약 디코딩

> 문서 상태: v0.1 (2026-11-16) · 구현됨. 사내 Gemma에서는 아직 재 보지 않음
> 관련: [27-gaps-and-improvements.md](27-gaps-and-improvements.md) (P0-3 사내 Gemma 연결, Q1 품질 측정), [21-hub-and-llm-proxy.md](21-hub-and-llm-proxy.md) (LLM 프록시), [17-claude-parity.md](17-claude-parity.md)

Dogent의 에이전트는 차례마다 모델에게서 동작 하나(`{"thought", "tool", "args"}`)를 받는다. 작은 모델(Gemma)이 이 답을 얼마나 잘 내는지가 성공률을 정한다. 이 문서는 그것을 **재는 방법(평가 세트)**과 **형식 오류를 처음부터 막는 방법(제약 디코딩)**을 다룬다.

순서는 이렇다. 먼저 재고, 켜 보고, 다시 재서 나아졌을 때만 켠다. 제약 디코딩은 기본으로 꺼져 있다.

## 1. 평가 세트

### 1.1 케이스 하나

케이스 하나는 **한 차례의 판단**이다. 그때 모델이 본 것과 정답 동작을 담는다.

| 칸 | 내용 |
|---|---|
| `turn.skill`, `turn.body`, `turn.step` | 스킬 머리(이름·허용 도메인), 단계 본문, 지금 할 단계 |
| `turn.snapshot` | 화면 **스냅샷 원본** (그린 글이 아님) |
| `turn.history`, `turn.datasets`, `turn.changes` | 지금까지의 동작, 데이터셋 요약, 직전 동작 뒤 바뀐 줄 |
| `turn.office`, `turn.tools`, `turn.skills` | 열린 오피스 문서, 외부 도구(MCP), 부를 수 있는 스킬 |
| `expect` | 정답 동작. 배열이면 그중 하나면 맞음 |
| `reviewed`, `source`, `tags` | 사람이 확인했는지, 출처(seed·manual·capture), 묶음 |

평가할 때는 저장된 입력을 **지금의 프롬프트(`buildTurnMessages`)와 화면 그리기(`renderSnapshot`)로 다시 그린다**. 그래서 프롬프트·스키마·화면 표기를 고칠 때마다 같은 케이스로 정답률을 다시 잴 수 있다.

### 1.2 채점

- **형식 통과(첫 답)**: 첫 답이 `parseAction`을 통과했다.
- **형식 통과(다시 묻기 포함)**: 실행과 같은 말(`retryPrompt`)로 최대 2번 다시 물어 통과했다.
- **도구 정답**: 도구 이름이 맞다.
- **동작 정답**: 도구와 인자가 모두 맞다. `expect.args`에 적은 칸만 비교한다. 글은 앞뒤 공백과 대소문자를 가리지 않고, `"3"`과 `3`은 같게 본다.

정해진 값이 없는 칸에는 맞추개를 쓴다.

| 맞추개 | 뜻 |
|---|---|
| `{"$contains": "173"}` | 이 글을 포함 (finish 요약에 들어가야 할 숫자 등) |
| `{"$regex": "^P7-"}` | 정규식 |
| `{"$oneOf": [6, 7]}` | 이 중 하나 (엑셀·CSV 내려받기 버튼 둘 다 맞을 때) |
| `{"$any": true}` / `{"$absent": true}` | 값이 있기만 하면 / 없어야 |
| `{"$el": {"name": "조회", "role": "button"}}` | ref가 가리키는 요소의 이름·역할 |

### 1.3 기본 케이스 (저장소 `evals/tool-calls/`, 66개)

| 파일 | 만든 방법 | 수 |
|---|---|---|
| `seed.json` | `EVAL_SEED=1 pnpm vitest run tests/tool-eval-seed.test.ts`. 모의 사이트에서 예시 스킬 5개와 자유 요청 1개를 모의 모델로 돌리며 모델이 정한 차례를 모았다 (`direct: false`) | 35 |
| `seed.json`의 `*-goal` | 위 케이스의 단계 글에서 "args는 다음을 그대로 쓴다"와 인자 원문을 지운 것. 모델이 인자를 베끼지 않고 화면에서 요소를 골라야 한다 | 19 |
| `manual.json` | 손으로 만든 자유 요청: 화면에 이미 답이 있음, 값이 없으면 묻기, 할 수 없는 일, 입력란 고르기, 전체 페이지 받기, 다음 페이지, CSV | 7 |
| `files.json` | PC 파일 도구 (첨부한 파일 읽기·CSV로 쓰기·끝내기, 목록 보고 찾기). 같은 생성기로 만든다 ([29](29-file-tools-and-attachments.md)) | 5 |

예시 스킬은 대부분 인자가 적힌 단계라 쉬운 편이다. 실제로는 `skillDirect`가 모델 없이 처리하는 단계다. **판단력을 보려면 `goal`·`free`·`manual` 태그를 따로 본다** (`--tag goal`). 기본 케이스는 클라이언트 빌드에 들어가므로 사내 PC에서 저장소 없이 바로 돌릴 수 있다.

### 1.4 사내에서 케이스 모으기

모의 사이트 케이스만으로는 사내 화면에서의 실력을 알 수 없다. 실제 실행에서 모은다.

```
dogent eval capture on        # 모델이 동작을 정할 때마다 ~/.dogent/evals/captured/<시각>-<스킬>-<n>.json
(평소처럼 일을 시킨다: 앱·터미널. 확장 패널 단독 실행은 파일을 못 쓰므로 모으지 않는다)
dogent eval review            # 하나씩 보며 맞으면 y, 틀리면 정답 JSON, 쓸모없으면 d
dogent eval capture off
```

- 모은 케이스는 정답 자리에 **그때 모델이 고른 동작**이 들어 있고 `reviewed: false`다. 검토 전 케이스는 평가에서 빠진다 (`--all`로 넣을 수 있다).
- **사내 화면의 글(Lot ID, 이름 등)이 그대로 들어간다.** 사내 저장소에만 두고 개인 GitHub에 올리지 않는다.
- 틀린 답을 고쳐 둔 케이스가 가장 쓸모 있다. 모델이 실제로 틀리는 곳이기 때문이다.

### 1.5 돌리기

```
dogent eval tools                              # 기본 케이스 + ~/.dogent/evals, json과 schema 두 방식
dogent eval tools --modes plain,json,schema    # 형식 지정 없음까지 셋을 나란히
dogent eval tools --tag goal                   # 목표만 적힌 단계만
dogent eval tools ~/.dogent/evals/captured     # 모은 것만
dogent eval list                               # 출처·검토·태그별 수
```

결과는 터미널 표와 `~/.dogent/evals/reports/<시각>.json`으로 남는다. 모델 서버에는 한 번에 하나씩 보낸다.

```
                            json              schema
케이스                      61                61
형식 통과 (첫 답)           …                 …
형식 통과 (다시 묻기 포함)  …                 …
도구 정답                   …                 …
동작 정답 (도구+인자)       …                 …
평균 호출 수                …                 …
평균 시간                   …                 …
```

## 2. 제약 디코딩 (json_schema)

### 2.1 하는 일

`llm.jsonSchema`를 켜면 동작을 정하는 요청에 `response_format: {"type": "json_schema", "json_schema": {"name": "dogent_action", "schema": …}}`를 함께 보낸다. vLLM·SGLang·TGI·Ollama처럼 문법 기반 디코딩을 하는 서버는 모델이 이 스키마에 맞는 글자만 내게 한다. 그래서 다음 오류가 처음부터 나오지 않는다.

- JSON이 아닌 답, 앞뒤에 붙은 설명
- 없는 도구 이름, 인자 이름 오타, 모르는 칸
- **지금 화면에 없는 ref 번호** (ref는 차례마다 화면의 번호 enum으로 좁힌다)
- 표가 아닌 요소에 `extract_table`·`fill_table` (표 도구의 ref는 표만)
- 없는 외부 도구·스킬·스크립트 이름 (목록 enum)

스키마는 `src/core/action-schema.ts`가 차례마다 만든다. 크기는 10~11KB쯤이다.

- **프롬프트에 안내한 도구만 넣는다.** 오피스 도구는 오피스를 쓸 수 있을 때, `call_tool`은 외부 도구가 있을 때, `look`은 vision이 켜졌을 때만 넣는다. 지금 단계 글에 이름이 적힌 도구(예: "run_skill로 …")는 늘 넣는다.
- `thought`는 300자까지로 묶어 끝없이 생각을 늘어놓다가 답이 잘리는 것을 막는다.
- 문법 엔진마다 지원이 다른 키(`format`, `pattern`, `oneOf`, `default` 등)는 뺀다. 값 검사는 `parseAction`이 다시 하므로 스키마가 느슨해도 안전하다.
- 규칙: **스키마에 맞는 답은 반드시 `parseAction`도 받아야 한다.** 모든 기본 케이스의 정답이 그 차례의 스키마에 맞는지를 `tests/tool-eval.test.ts`가 검사한다.

### 2.2 서버가 모를 때

서버가 `json_schema`를 거절하면(400·422이고 본문에 response_format·schema 같은 말이 있으면) 그 클라이언트에서는 끄고 `jsonMode` 방식으로 한 번 다시 보낸다. 평가 결과의 schema 열에는 "서버가 json_schema를 받지 않아 json_object로 보냈습니다"가 적힌다. 거절하지 않고 조용히 무시하는 서버라면 schema 열과 json 열의 숫자가 거의 같게 나온다.

### 2.3 켜기

| 어디서 | 방법 |
|---|---|
| 앱·터미널 | `dogent config llm.jsonSchema true` (`dogent config`의 "답 형식" 줄에서 확인) |
| 확장 | 패널 → 설정 → "제약 디코딩" |
| 빌드 기본값 | `.env.company.local`의 `WXT_LLM_JSON_SCHEMA=true` |
| 집 Ollama | `.env.home.example`은 켜 둠. `pnpm ollama:proxy`가 `json_schema`를 Ollama의 `format`(구조화 출력, Ollama 0.5 이상)으로 넘긴다 |
| LLM 프록시 | 본문을 그대로 넘기므로 따로 할 일 없음 |

## 3. 사내에서 할 일 (P0-3과 함께)

1. 사내 PC에서 `dogent eval tools --modes plain,json,schema`를 돌린다. 호출 오류가 나면 연결부터 고친다.
2. schema 열에 "받지 않아" 줄이 있으면 서빙 담당에게 guided decoding(vLLM이면 `xgrammar`·`outlines` 백엔드)이 켜져 있는지 묻는다.
3. schema가 json보다 **형식 통과(첫 답)와 동작 정답이 모두 같거나 높고**, 평균 시간이 크게 늘지 않으면 켠다 (`WXT_LLM_JSON_SCHEMA=true`로 다시 빌드).
4. 앱에서 `dogent eval capture on`으로 1~2주 모은 뒤 검토하고, 사내 케이스로 다시 잰다. 이 수가 프롬프트·도구를 고칠 때의 기준이 된다.

## 4. 이번에 하지 않은 것

- 사내 Gemma·Ollama 실측. 이 PC에는 Ollama가 없어서 Ollama의 `format` 변환은 단위 시험으로만 확인했다.
- 요청 해석(`planRequest`, 스킬 고르기)과 스킬 다듬기의 스키마. 같은 방법(스킬 id enum)으로 넓힐 수 있다.
- 차례마다 도구 목록 자체를 줄이는 것 (프롬프트의 도구 설명을 상황별로 빼기). 평가 세트로 효과를 잰 뒤에 한다.
- 확장 패널 단독 실행에서의 케이스 모으기 (파일 쓰기가 없음). 필요하면 실행 기록 내보내기에 붙인다.
