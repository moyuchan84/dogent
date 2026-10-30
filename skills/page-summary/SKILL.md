---
id: page-summary
name: 화면 요약
description: 지금 열려 있는 화면(게시글, 공지, 상세 화면, 보고서 등)의 글을 읽고 요청한 기준으로 요약한다. 어느 사이트에서나 쓴다. "이 화면 요약해줘", "공지 내용 정리해줘" 같은 요청에 쓴다.
version: 0.1.0
owner: Dogent 기본
risk: R1
domains:
  - "*"
tags: ["기본", "요약", "정리", "읽기", "공지", "게시글"]
inputs:
  - name: focus
    label: 요약 기준
    description: 무엇을 중심으로 요약할지. 예 "일정과 할 일", "변경된 점"
    type: string
    default: 핵심 내용
limits:
  max_steps: 10
  timeout_sec: 180
---

## 단계

1. read_text로 화면에 보이는 글을 읽는다. args는 다음을 그대로 쓴다.
   `{}`
   - 검사: did("read_text")
2. summarize로 화면의 글을 요약 기준에 맞게 정리한다. args는 다음을 그대로 쓴다.
   `{"instruction": "화면의 글을 '{focus}'을(를) 중심으로 다섯 줄 이내로 요약한다. 화면에 없는 내용은 쓰지 않는다.", "source": "page", "name": "summary"}`
   - 검사: did("summarize")
3. finish로 결과를 보고한다. args는 다음을 그대로 쓴다.
   `{"summary": "{out.summary}"}`

## 예외

- 화면에 읽을 글이 없으면(로그인 화면, 빈 화면) abort로 그렇다고 알린다.

## 결과

요약 기준에 맞춘 다섯 줄 이내의 요약.
