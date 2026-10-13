---
id: wip-adjust
name: 재공 수량 조정 입력
description: 엑셀로 정리한 Lot별 조정 수량을 재공 수량 조정 화면의 표에 일괄 입력하고, 사용자 승인을 받아 저장한다
version: 0.1.0
owner: 생산관리
risk: R3
domains:
  - localhost:4173
inputs:
  - name: source
    label: 엑셀 파일 (Lot ID, 공정, 조정수량, 사유)
    type: file
    dataset: src
    required: true
submit_steps: [3]
submit_labels: [저장]
schedulable: false
limits:
  max_steps: 20
  timeout_sec: 300
---

## 단계

1. 재공 수량 조정 화면 http://localhost:4173/adjust.html 로 이동한다. 화면에 "재공 수량 조정" 제목이 이미 보이면 이동하지 않는다.
   - 확인: 화면에 "재공 수량 조정" 제목이 보인다.
   - 검사: text("재공 수량 조정")
2. fill_table로 엑셀 데이터 `src`를 "조정 목록" 표에 채운다. args는 다음을 그대로 쓴다.
   `{"ref": "조정 목록", "dataset": "src", "add_ref": "행 추가"}`
   - 확인: 동작 기록에 fill_table 성공이 있다.
   - 검사: did("fill_table")
3. click으로 "저장" 버튼을 한 번 누른다. args는 다음을 그대로 쓴다. 누르기 전에 사용자 승인을 받는다.
   `{"ref": "저장"}`
   - 확인: 화면에 "저장되었습니다"가 보인다.
   - 검사: did("click") and text("저장되었습니다")
   - 기록: saved = page_text("저장되었습니다. (\d+)건")
4. finish로 결과를 보고한다. args는 다음을 그대로 쓴다.
   `{"summary": "{out.saved}건을 저장했습니다."}`

## 예외

- fill_table이 실패하면 abort로 오류 메시지를 그대로 알린다. 값을 고치거나 일부만 넣지 않는다.
- 화면에 오류 메시지가 나오면 abort로 메시지 원문을 그대로 알린다. 다시 저장하지 않는다.

## 결과

저장한 건수.
