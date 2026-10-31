---
id: wip-search
name: 재공 검색 정리
description: 재공 현황 화면에서 제품코드를 검색해 나온 결과를 공정별로 집계하고, 원하는 기준으로 정리해 보고한다. "DR5 검색해서 결과 정리해줘" 같은 요청에 쓴다.
version: 0.1.0
owner: 생산관리
risk: R1
domains:
  - localhost:4173
tags: ["재공", "WIP", "제품코드", "검색", "생산"]
inputs:
  - name: keyword
    label: 검색어
    description: 제품코드 검색창에 넣을 값. 일부만 넣어도 된다. 예 "DR5", "NV2-1T"
    type: string
    required: true
  - name: line
    label: 라인
    description: 조회할 라인. 요청에 없으면 기본값을 쓴다
    type: string
    default: 7라인
  - name: focus
    label: 정리 기준
    description: 결과를 무엇을 중심으로 정리할지. 예 "수량이 많은 공정", "정체가 긴 Lot"
    type: string
    default: 공정별 Lot 수와 수량
schedulable: true
limits:
  max_steps: 30
  timeout_sec: 300
---

## 단계

1. navigate로 재공 현황 조회 화면으로 이동한다. args는 다음을 그대로 쓴다. 이미 열려 있으면 이동하지 않는다.
   `{"url": "http://localhost:4173/wip.html"}`
   - 검사: text("재공 현황 조회")
2. select로 "라인"에서 {line}을 선택한다. args는 다음을 그대로 쓴다.
   `{"ref": "라인", "value": "{line}"}`
   - 검사: value("라인") == "{line}"
3. type으로 "제품코드" 검색창에 {keyword}를 넣는다. args는 다음을 그대로 쓴다.
   `{"ref": "제품코드", "text": "{keyword}"}`
   - 검사: value("제품코드") == "{keyword}"
4. click으로 "조회" 버튼을 눌러 검색한다. args는 다음을 그대로 쓴다.
   `{"ref": "조회"}`
   - 검사: did("click") and no_text("조회 중") and text("총")
5. extract_table로 검색 결과 표를 끝 페이지까지 데이터셋 `result`에 읽는다. args는 다음을 그대로 쓴다.
   `{"ref": "재공 목록", "dataset": "result", "next_ref": "다음"}`
   - 검사: rows("result") == page_number("총 ([\d,]+)건")
6. transform으로 공정별 집계 `by_step`을 만든다 (Lot 수, 수량 합계, 가장 긴 정체시간). args는 다음을 그대로 쓴다.
   `{"source": "result", "target": "by_step", "steps": [{"op": "group", "by": ["공정"], "agg": [{"fn": "count", "as": "Lot수"}, {"fn": "sum", "col": "수량", "as": "수량합계"}, {"fn": "max", "col": "정체시간", "as": "최장정체"}]}, {"op": "sort", "by": "수량합계", "desc": true}]}`
   - 검사: dataset("by_step")
7. summarize로 공정별 집계를 정리 기준에 맞게 정리한다. args는 다음을 그대로 쓴다.
   `{"instruction": "제품코드 '{keyword}' 검색 결과의 공정별 집계다. '{focus}'을(를) 중심으로 세 줄 이내로 정리한다.", "source": "by_step", "name": "report"}`
   - 검사: did("summarize")
8. finish로 결과를 보고한다. args는 다음을 그대로 쓴다.
   `{"summary": "'{keyword}' 검색 결과 {rows.result}건 ({line}).\n{out.report}"}`

## 예외

- 검색 결과가 0건이면 abort로 검색어와 라인을 그대로 알린다. 검색어를 바꿔 다시 찾지 않는다.
- 선택하려는 라인이 옵션에 없으면 abort하고 가능한 라인을 알려준다.

## 결과

검색 건수와, 정리 기준에 맞춘 공정별 정리.
