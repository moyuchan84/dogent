---
id: table-to-excel
name: 화면 표를 엑셀로
description: 지금 화면의 표(목록, 그리드)를 끝 페이지까지 읽어 엑셀 파일로 저장한다. 어느 사이트에서나 쓴다. "이 목록 엑셀로 받아줘", "표 전체를 엑셀로 저장해줘" 같은 요청에 쓴다.
version: 0.1.0
owner: Dogent 기본
risk: R1
domains:
  - "*"
tags: ["기본", "엑셀", "표", "목록", "내보내기", "추출"]
inputs:
  - name: table
    label: 표
    description: 저장할 표의 이름이나 설명. 요청에 없으면 화면에서 가장 큰 표
    type: string
    default: 화면에서 가장 큰 표
  - name: filename
    label: 파일 이름
    type: string
    default: 화면표
outputs:
  - type: xlsx
    sheets: [표]
limits:
  max_steps: 30
  timeout_sec: 600
---

## 단계

1. 화면에서 "{table}"에 해당하는 표를 찾아 extract_table로 데이터셋 `table`에 담는다. 표 아래에 다음 페이지 버튼이 있으면 next_ref에 그 버튼을 주어 끝 페이지까지 담는다. 화면에 엑셀·CSV 내려받기 버튼이 있으면 download_table로 받아도 된다.
   - 검사: dataset("table")
2. write_excel로 엑셀 파일을 저장한다. args는 다음을 그대로 쓴다.
   `{"filename": "{filename}", "sheets": [{"name": "표", "dataset": "table"}]}`
   - 검사: did("write_excel")
3. finish로 결과를 보고한다. args는 다음을 그대로 쓴다.
   `{"summary": "표 {rows.table}행을 {filename}.xlsx로 저장했습니다"}`

## 예외

- 화면에 표가 없으면 abort로 그렇다고 알린다. 다른 화면으로 이동하지 않는다.
- 표가 여러 개인데 어느 것인지 알 수 없으면 ask_user로 표 이름을 묻는다.

## 결과

저장한 행 수와 파일 이름.
