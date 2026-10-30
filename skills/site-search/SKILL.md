---
id: site-search
name: 사이트 안에서 검색
description: 지금 열려 있는 사이트의 검색 칸에 검색어를 넣어 검색하고, 나온 결과를 읽어 정리한다. 어느 사이트에서나 쓴다. "여기서 OO 검색해서 결과 알려줘" 같은 요청에 쓴다.
version: 0.1.0
owner: Dogent 기본
risk: R1
domains:
  - "*"
tags: ["기본", "검색", "찾기", "조회", "결과 정리"]
inputs:
  - name: query
    label: 검색어
    type: string
    required: true
  - name: focus
    label: 정리 기준
    description: 결과를 무엇을 중심으로 정리할지
    type: string
    default: 검색어와 관련 있는 결과
limits:
  max_steps: 20
  timeout_sec: 300
---

## 단계

1. 화면의 검색 칸을 찾아(보이지 않으면 find로 "검색"을 찾는다) type으로 {query}를 넣는다.
   - 검사: did("type")
2. 검색(또는 조회) 버튼을 click으로 누른다. 버튼이 없으면 검색 칸에서 press_key로 Enter를 누른다. 결과가 나올 때까지 기다린다.
3. summarize로 검색 결과를 정리한다. args는 다음을 그대로 쓴다.
   `{"instruction": "'{query}' 검색 결과 화면이다. '{focus}'을(를) 중심으로 결과를 다섯 개 이내로 골라 제목과 핵심을 한 줄씩 정리한다. 결과가 없으면 없다고 쓴다.", "source": "page", "name": "result"}`
   - 검사: did("summarize")
4. finish로 결과를 보고한다. args는 다음을 그대로 쓴다.
   `{"summary": "'{query}' 검색 결과\n{out.result}"}`

## 예외

- 화면에 검색 칸이 없으면 abort로 그렇다고 알린다. 다른 사이트로 가서 검색하지 않는다.
- 검색 결과가 0건이면 그대로 보고한다. 검색어를 바꿔 다시 검색하지 않는다.

## 결과

검색어와, 정리 기준에 맞춘 결과 다섯 개 이내.
