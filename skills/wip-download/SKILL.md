---
id: wip-download
name: 재공 내려받기
description: 재공 조회 화면의 엑셀 다운로드 버튼으로 조회 결과 전체를 한 번에 받아 정체 Lot과 함께 엑셀로 정리한다
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
  - name: hold_hours
    label: 정체 기준(시간)
    type: number
    default: 24
outputs:
  - type: xlsx
    sheets: [원본, 정체Lot]
schedulable: true
limits:
  max_steps: 30
  timeout_sec: 300
---

## 단계

1. navigate로 재공 현황 조회 화면으로 이동한다. args는 다음을 그대로 쓴다. 현재 화면에 "재공 현황 조회" 제목이 이미 보이면 이동하지 않는다.
   `{"url": "http://localhost:4173/wip.html"}`
   - 확인: 화면에 "재공 현황 조회" 제목이 보인다.
   - 검사: text("재공 현황 조회")
2. select로 "라인" 선택 상자에서 {line}을 선택한다. args는 다음을 그대로 쓴다.
   `{"ref": "라인", "value": "{line}"}`
   - 확인: "라인" 선택 상자의 value가 {line}이다.
   - 검사: value("라인") == "{line}"
3. click으로 "조회" 버튼을 한 번 누른다. args는 다음을 그대로 쓴다.
   `{"ref": "조회"}`
   - 확인: "조회 중" 표시가 없고 "총 N건"이 보인다.
   - 검사: did("click") and no_text("조회 중") and text("총")
4. download_table로 "엑셀 다운로드" 버튼을 눌러 받은 파일을 데이터셋 `wip`에 담는다. args는 다음을 그대로 쓴다.
   `{"ref": "엑셀 다운로드", "dataset": "wip"}`
   - 확인: `wip`의 행 수가 화면의 "총 N건"과 같다.
   - 검사: rows("wip") == page_number("총 ([\d,]+)건")
5. transform으로 정체 Lot 데이터셋 `hold`를 만든다 (정체시간이 {hold_hours} 이상이거나 상태가 HOLD인 행, 정체시간 내림차순). args는 다음을 그대로 쓴다.
   `{"source": "wip", "target": "hold", "steps": [{"op": "filter", "match": "any", "where": [{"col": "정체시간", "cmp": ">=", "value": {hold_hours}}, {"col": "상태", "cmp": "==", "value": "HOLD"}]}, {"op": "sort", "by": "정체시간", "desc": true}]}`
   - 확인: 데이터셋 `hold`가 있다.
   - 검사: dataset("hold")
6. write_excel로 엑셀 파일을 저장한다. args는 다음을 그대로 쓴다.
   `{"filename": "재공내려받기_{line}", "sheets": [{"name": "원본", "dataset": "wip"}, {"name": "정체Lot", "dataset": "hold"}]}`
   - 확인: 동작 기록에 write_excel 성공이 있다.
   - 검사: did("write_excel")
7. finish로 결과를 보고한다. args는 다음을 그대로 쓴다.
   `{"summary": "총 재공 {rows.wip} Lot, 정체 Lot {rows.hold}건. 파일: 재공내려받기_{line}.xlsx"}`

## 판단 기준

- 정체시간 컬럼의 단위는 시간이다.
- 상태가 HOLD인 Lot은 정체시간과 무관하게 정체 Lot으로 본다.

## 예외

- 조회 결과가 0건이면 abort로 조건을 그대로 알린다. 조건을 바꿔 다시 조회하지 않는다.
- 선택하려는 라인이 옵션에 없으면 abort하고 가능한 옵션을 알려준다.
- 내려받은 파일의 행 수가 화면의 총 건수와 다르면 abort하고 두 숫자를 알려준다. 표를 직접 추출해 맞추지 않는다.

## 결과

총 재공 Lot 수, 정체 Lot 수, 저장한 파일 이름. 숫자는 데이터셋 요약의 행 수만 인용한다.
