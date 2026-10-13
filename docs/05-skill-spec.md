# 05. 스킬(SOP) 명세

> 문서 상태: 초안 (v0.1, 2026-10-13)

스킬은 업무 절차 하나를 에이전트가 따라 할 수 있게 적은 문서입니다. 현업 담당자가 직접 읽고 고칠 수 있어야 하므로 Markdown으로 씁니다.

## 1. 파일 구조

```
skills/
  wip-check/
    SKILL.md          # 스킬 본문 (필수)
    policy.yaml       # 입력값 검증 규칙 (선택)
    template.xlsx     # 결과 양식 (선택)
    tests/            # 회귀 테스트용 기록 화면 (선택)
```

## 2. SKILL.md 형식

상단 YAML은 **기계가 강제하는 선언**, 본문은 **모델이 따라가는 절차**입니다.

### 2.1 선언부 필드

| 필드 | 필수 | 설명 |
|---|:-:|---|
| `id` | ● | 고유 식별자 (영문 소문자, 하이픈) |
| `name` | ● | 표시 이름 |
| `description` | ● | 언제 쓰는 스킬인지. 스킬 자동 선택에 쓰인다 |
| `version` | ● | 버전 (major.minor.patch) |
| `owner` | ● | 담당 부서/담당자 |
| `risk` | ● | 스킬이 쓰는 최고 위험 등급 (R0~R3) |
| `domains` | ● | 접근 허용 도메인. 여기 없는 곳으로는 이동할 수 없다 |
| `inputs` | ● | 입력 항목 (이름, 형식, 필수 여부, 설명, 기본값) |
| `outputs` |  | 결과물 형식 |
| `submit_steps` |  | R3 동작이 일어나는 단계 번호. 여기 없는 단계에서 제출 계열 버튼을 누르면 차단된다 |
| `schedulable` |  | 스케줄 실행 허용 여부 (R0~R1만 가능) |
| `limits` |  | 최대 단계 수, 타임아웃 |

### 2.2 본문 구성

| 절 | 내용 |
|---|---|
| `## 단계` | 번호가 붙은 절차. 각 단계에 `확인:` 줄로 검증 조건을 적는다 |
| `## 판단 기준` | 업무 규칙 (임계값, 분류 기준 등) |
| `## 예외` | 상황별 대응. 적혀 있지 않은 상황은 중단하고 보고한다 |
| `## 결과` | 사용자에게 보여줄 요약 형식 |

## 3. 예시 1 — 재공 확인 (조회형, R1)

```markdown
---
id: wip-check
name: 재공 확인
description: 라인·공정별 재공 현황을 조회하고 정체 Lot을 정리한다
version: 1.0.0
owner: 생산관리
risk: R1
domains:
  - mes.example.internal
inputs:
  - name: line
    label: 라인
    type: string
    required: true
  - name: step
    label: 공정
    type: string
    required: false
  - name: hold_hours
    label: 정체 기준(시간)
    type: number
    default: 24
outputs:
  - type: xlsx
    sheets: [원본, 정체Lot, 공정별집계]
schedulable: true
limits:
  max_steps: 30
  timeout_sec: 300
---

## 단계

1. 재공 현황 조회 화면으로 이동한다.
   - 확인: 화면 제목에 "재공 현황"이 보인다.
2. 라인에 {line}을 선택한다. {step}이 주어졌으면 공정도 선택한다.
   - 확인: 선택한 값이 조건 영역에 표시된다.
3. 조회 버튼을 누른다.
   - 확인: 재공 목록 그리드가 갱신된다 (로딩 표시가 사라진다).
4. 재공 목록 그리드를 전부 추출한다. 페이지가 나뉘어 있으면 끝까지 넘긴다.
   - 확인: 추출 행 수가 화면의 총 건수와 같다.
5. 추출한 데이터를 가공한다.
   - 정체Lot: 정체시간이 {hold_hours} 이상인 행, 정체시간 내림차순
   - 공정별집계: 공정별 Lot 수와 수량 합계
6. 세 시트로 엑셀을 저장한다.

## 판단 기준

- 정체시간 컬럼 단위는 시간이다.
- 상태가 "HOLD"인 Lot은 정체시간과 무관하게 정체Lot에 포함한다.

## 예외

- 조회 결과가 0건이면 조건을 그대로 알리고 끝낸다. 조건을 바꿔 다시 조회하지 않는다.
- 로그인 화면이 나오면 중단하고 사용자에게 로그인을 요청한다.

## 결과

총 재공 Lot 수, 공정별 수량 상위 5개, 정체 Lot 수와 상위 10건, 저장한 파일 경로.
```

## 4. 예시 2 — IP 방화벽 해제 신청 (제출형, R3)

```markdown
---
id: firewall-request
name: IP 방화벽 해제 신청
description: 방화벽 정책 신청 사이트에 해제 신청서를 작성하고 상신한다
version: 1.0.0
owner: 인프라운영
risk: R3
domains:
  - fw-request.example.internal
inputs:
  - name: src_ip
    label: 출발지 IP
    type: ip
    required: true
  - name: dst_ip
    label: 목적지 IP
    type: ip
    required: true
  - name: port
    label: 포트
    type: port
    required: true
  - name: protocol
    label: 프로토콜
    type: enum
    values: [TCP, UDP]
    default: TCP
  - name: period_days
    label: 기간(일)
    type: number
    required: true
  - name: reason
    label: 사유
    type: text
    required: true
submit_steps: [6]
schedulable: false
---

## 단계

1. 입력값을 policy.yaml 규칙으로 검증한다. 위반이 있으면 사이트에 접속하지 않고 중단한다.
2. 신청 사이트의 신규 신청 화면으로 이동한다.
   - 확인: "방화벽 정책 신청" 양식이 보인다.
3. 출발지, 목적지, 포트, 프로토콜, 기간, 사유를 입력한다.
   - 확인: 각 필드에 입력한 값이 그대로 표시된다.
4. 화면의 입력 값을 다시 읽어 요청 내용과 대조한다.
   - 확인: 모든 항목이 일치한다.
5. 신청 내용 요약을 사용자에게 보여주고 상신 승인을 요청한다.
6. 승인되면 상신 버튼을 누른다.
   - 확인: 신청 번호가 표시된다.
7. 신청 번호를 기록하고 사용자에게 알린다.

## 예외

- 사유가 비어 있으면 사용자에게 요청한다. 사유를 대신 작성하지 않는다.
- 같은 출발지·목적지·포트의 진행 중 신청이 보이면 중복 가능성을 알리고 판단을 받는다.
- 상신 후 오류 메시지가 나오면 원문 그대로 보고한다. 다시 상신하지 않는다.

## 결과

신청 번호, 신청 내용 요약, 결재 대기 상태 안내.
```

`policy.yaml`

```yaml
rules:
  - field: src_ip
    deny_cidr_wider_than: 24        # /24보다 넓은 대역 금지
  - field: dst_ip
    deny_cidr_wider_than: 24
  - field: port
    deny_values: [any, "0-65535"]
  - field: period_days
    max: 365
  - field: reason
    min_length: 10
```

실제 규칙 값은 보안 부서 기준에 맞춰 정합니다.

## 5. 작성 규칙

1. **한 단계에 한 가지 동작**을 적는다. "조회하고 내려받는다"는 두 단계로 나눈다.
2. **모든 단계에 확인 조건**을 적는다. 확인할 수 없는 단계는 에이전트가 성공 여부를 알 수 없다.
3. 화면에 보이는 **라벨 그대로** 적는다 ("조회" 버튼, "라인" 선택 상자). 좌표나 내부 ID는 적지 않는다.
4. 업무 규칙은 **숫자와 조건으로** 적는다 ("오래된 Lot" 대신 "정체시간 24 이상").
5. 예외에 없는 상황은 **중단 후 보고**가 기본이다. 임의 대응을 기대하지 않는다.
6. 저장·상신·삭제가 있는 스킬은 반드시 `risk: R3`와 `submit_steps`를 선언한다.

## 6. 수명 주기

| 단계 | 내용 |
|---|---|
| 작성 | 템플릿 복사 후 작성. 개인 로컬 폴더에서 테스트 |
| 드라이런 | R3 직전에 멈추는 모드로 5회 이상 실행 |
| 검토 | 사내 Git에 변경 요청, 스킬 오너가 승인 |
| 배포 | 병합 시 다음 동기화부터 사용자에게 적용 |
| 모니터링 | 성공률이 기준 아래로 떨어지면 오너에게 알림 |
| 수정 | 화면 변경 시 스킬만 고쳐 재배포. 버전을 올린다 |
| 폐기 | 선언부에 `deprecated: true` 표시 후 일정 기간 뒤 삭제 |
