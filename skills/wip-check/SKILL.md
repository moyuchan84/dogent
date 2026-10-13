---
id: wip-check
name: 재공 확인
description: 라인·공정별 재공 현황을 조회하고 정체 Lot과 공정별 집계를 엑셀로 정리한다
version: 0.1.0
owner: 생산관리
risk: R1
domains:
  - localhost:4173
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
  max_steps: 40
  timeout_sec: 300
---

## 단계

1. 재공 현황 조회 화면 http://localhost:4173/wip.html 로 이동한다. 현재 화면에 "재공 현황 조회" 제목이 이미 보이면 이동하지 않는다.
   - 확인: 화면에 "재공 현황 조회" 제목이 보인다.
   - 검사: text("재공 현황 조회")
2. select로 "라인" 선택 상자에서 {line}을 선택한다. args는 다음을 그대로 쓴다.
   `{"ref": "라인", "value": "{line}"}`
   - 확인: "라인" 선택 상자의 value가 {line}이다.
   - 검사: value("라인") == "{line}"
3. select로 "공정" 선택 상자에서 {step}을 선택한다. args는 다음을 그대로 쓴다. 공정이 "(미지정)"이면 아무것도 하지 않고 넘어간다.
   `{"ref": "공정", "value": "{step}"}`
   - 확인: "공정" 선택 상자의 value가 {step}이다. 공정이 "(미지정)"이면 확인할 것이 없다.
   - 검사: value("공정") == "{step}"
4. click으로 "조회" 버튼을 한 번 누른다. args는 다음을 그대로 쓴다.
   `{"ref": "조회"}`
   - 확인: "조회 중" 표시가 없고 "총 N건"이 보인다.
   - 검사: did("click") and no_text("조회 중") and text("총")
5. extract_table로 재공 목록 표의 모든 페이지를 데이터셋 `wip`에 추출한다. args는 다음을 그대로 쓴다.
   `{"ref": "재공 목록", "dataset": "wip", "next_ref": "다음"}`
   - 확인: `wip`의 행 수가 화면의 "총 N건"과 같다.
   - 검사: rows("wip") == page_number("총 ([\d,]+)건")
6. transform으로 정체 Lot 데이터셋 `hold`를 만든다 (정체시간이 {hold_hours} 이상이거나 상태가 HOLD인 행, 정체시간 내림차순). args는 다음을 그대로 쓴다.
   `{"source": "wip", "target": "hold", "steps": [{"op": "filter", "match": "any", "where": [{"col": "정체시간", "cmp": ">=", "value": {hold_hours}}, {"col": "상태", "cmp": "==", "value": "HOLD"}]}, {"op": "sort", "by": "정체시간", "desc": true}]}`
   - 확인: 데이터셋 `hold`가 있다.
   - 검사: dataset("hold")
7. transform으로 공정별 집계 데이터셋 `by_step`을 만든다 (공정별 Lot 수와 수량 합계, 수량 합계 내림차순). args는 다음을 그대로 쓴다.
   `{"source": "wip", "target": "by_step", "steps": [{"op": "group", "by": ["공정"], "agg": [{"fn": "count", "as": "Lot수"}, {"fn": "sum", "col": "수량", "as": "수량합계"}]}, {"op": "sort", "by": "수량합계", "desc": true}]}`
   - 확인: 데이터셋 `by_step`이 있다.
   - 검사: dataset("by_step")
8. write_excel로 엑셀 파일을 저장한다. args는 다음을 그대로 쓴다.
   `{"filename": "재공확인_{line}", "sheets": [{"name": "원본", "dataset": "wip"}, {"name": "정체Lot", "dataset": "hold"}, {"name": "공정별집계", "dataset": "by_step"}]}`
   - 확인: 동작 기록에 write_excel 성공이 있다.
   - 검사: did("write_excel")
9. finish로 결과를 보고한다. summary에 `wip`, `hold`, `by_step`의 행 수와 저장한 파일 이름을 적는다.

## 판단 기준

- 정체시간 컬럼의 단위는 시간이다.
- 상태가 HOLD인 Lot은 정체시간과 무관하게 정체 Lot으로 본다.

## 예외

- 조회 결과가 0건이면 abort로 조건을 그대로 알린다. 조건을 바꿔 다시 조회하지 않는다.
- 선택하려는 라인이나 공정이 옵션에 없으면 abort하고 가능한 옵션을 알려준다.
- 5단계의 추출이 끝났는데도 행 수가 총 건수와 다르면 abort하고 두 숫자를 알려준다.

## 결과

총 재공 Lot 수, 정체 Lot 수, 공정 수, 저장한 파일 이름. 숫자는 데이터셋 요약의 행 수만 인용한다.
