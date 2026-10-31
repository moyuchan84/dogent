---
id: hold-release
name: Lot 홀드 해제 요청
description: 홀드 Lot 찾기 팝업에서 Lot을 골라 홀드 해제 요청서를 작성하고, 사용자 승인을 받아 상신한다
version: 0.1.0
owner: 생산관리
risk: R3
domains:
  - localhost:4173
tags: ["홀드", "HOLD", "Lot", "해제 요청", "생산"]
inputs:
  - name: lot
    label: Lot ID
    type: string
    required: true
  - name: reason
    label: 해제 사유
    type: text
    required: true
submit_steps: [5]
submit_labels: [상신]
schedulable: false
limits:
  max_steps: 20
  timeout_sec: 300
---

## 단계

1. navigate로 Lot 홀드 해제 요청 화면으로 이동한다. args는 다음을 그대로 쓴다. 화면에 "Lot 홀드 해제 요청" 제목이 이미 보이면 이동하지 않는다.
   `{"url": "http://localhost:4173/hold.html"}`
   - 확인: 화면에 "Lot 홀드 해제 요청" 제목이 보인다.
   - 검사: text("Lot 홀드 해제 요청")
2. click으로 "Lot 찾기" 버튼을 한 번 누른다. args는 다음을 그대로 쓴다. 홀드 Lot 찾기 창이 새로 열린다.
   `{"ref": "Lot 찾기"}`
   - 확인: "홀드 Lot 찾기" 창이 열려 있다.
   - 검사: url("lot-popup.html") and text("홀드 Lot 찾기")
3. click으로 표에서 {lot} 행의 "선택" 버튼을 한 번 누른다. args는 다음을 그대로 쓴다. 누르면 창이 닫히고 요청 화면으로 돌아온다.
   `{"ref": "선택", "row": "{lot}"}`
   - 확인: 요청 화면의 "Lot ID" 값이 {lot}이다.
   - 검사: value("Lot ID") == "{lot}"
4. type으로 "해제 사유"를 입력한다. args는 다음을 그대로 쓴다.
   `{"ref": "해제 사유", "text": "{reason}"}`
   - 검사: value("해제 사유") == "{reason}"
5. click으로 "상신" 버튼을 한 번 누른다. args는 다음을 그대로 쓴다. 누르기 전에 사용자 승인을 받는다.
   `{"ref": "상신"}`
   - 확인: "접수되었습니다" 알림 창이 뜬다.
   - 검사: did("click") and dialog("접수되었습니다")
   - 기록: receipt = dialog_text("접수 번호: (\S+)")
6. finish로 결과를 보고한다. args는 다음을 그대로 쓴다.
   `{"summary": "접수 번호 {out.receipt}로 홀드 해제를 요청했습니다."}`

## 예외

- 홀드 Lot 찾기 창의 표에 {lot}이 없으면 close_tab으로 창을 닫고 abort로 알린다. 다른 Lot을 고르지 않는다.
- 알림 창에 "접수되었습니다"가 아닌 내용이 나오면 abort로 그 내용을 그대로 알린다. 다시 상신하지 않는다.
- 해제 사유를 고쳐 쓰거나 지어내지 않는다. 입력값에 있는 그대로 넣는다.

## 결과

접수 번호.
