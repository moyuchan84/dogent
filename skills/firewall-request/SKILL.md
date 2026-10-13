---
id: firewall-request
name: IP 방화벽 해제 신청
description: 방화벽 정책 신청 화면에 해제 신청서를 작성하고, 사용자 승인을 받아 상신한다
version: 0.1.0
owner: 인프라운영
risk: R3
domains:
  - localhost:4173
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
submit_steps: [8]
submit_labels: [상신]
schedulable: false
limits:
  max_steps: 30
  timeout_sec: 300
---

## 단계

1. navigate로 방화벽 정책 신청 화면으로 이동한다. args는 다음을 그대로 쓴다. 화면에 "방화벽 정책 신청" 제목이 이미 보이면 이동하지 않는다.
   `{"url": "http://localhost:4173/fw.html"}`
   - 확인: 화면에 "방화벽 정책 신청" 제목이 보인다.
   - 검사: text("방화벽 정책 신청")
2. type으로 "출발지 IP"를 입력한다. args는 다음을 그대로 쓴다.
   `{"ref": "출발지 IP", "text": "{src_ip}"}`
   - 검사: value("출발지 IP") == "{src_ip}"
3. type으로 "목적지 IP"를 입력한다. args는 다음을 그대로 쓴다.
   `{"ref": "목적지 IP", "text": "{dst_ip}"}`
   - 검사: value("목적지 IP") == "{dst_ip}"
4. type으로 "포트"를 입력한다. args는 다음을 그대로 쓴다.
   `{"ref": "포트", "text": "{port}"}`
   - 검사: value("포트") == "{port}"
5. select로 "프로토콜"을 선택한다. args는 다음을 그대로 쓴다.
   `{"ref": "프로토콜", "value": "{protocol}"}`
   - 검사: value("프로토콜") == "{protocol}"
6. type으로 "기간(일)"을 입력한다. args는 다음을 그대로 쓴다.
   `{"ref": "기간(일)", "text": "{period_days}"}`
   - 검사: value("기간(일)") == "{period_days}"
7. type으로 "사유"를 입력한다. args는 다음을 그대로 쓴다.
   `{"ref": "사유", "text": "{reason}"}`
   - 검사: value("사유") == "{reason}"
8. click으로 "상신" 버튼을 한 번 누른다. args는 다음을 그대로 쓴다. 누르기 전에 사용자 승인을 받는다.
   `{"ref": "상신"}`
   - 확인: 화면에 "신청 번호"가 보인다.
   - 검사: did("click") and text("신청 번호")
   - 기록: request_id = page_text("신청 번호: (\S+)")
9. finish로 결과를 보고한다. args는 다음을 그대로 쓴다.
   `{"summary": "신청 번호 {out.request_id}로 접수되었습니다. 결재 대기 중입니다."}`

## 예외

- 화면에 오류 메시지가 나오면 abort로 메시지 원문을 그대로 알린다. 다시 상신하지 않는다.
- 사유를 고쳐 쓰거나 지어내지 않는다. 입력값에 있는 그대로 넣는다.
- "임시 저장" 등 "상신"이 아닌 버튼은 누르지 않는다.

## 결과

신청 번호와 결재 대기 중이라는 안내.
