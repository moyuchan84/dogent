---
id: mes
name: 모의 MES (생산 관리)
description: 라인별 재공(WIP)과 Lot 홀드를 조회하고 처리하는 생산 관리 시스템. 집에서 시험하는 모의 사이트다
aliases: [MES, 재공 시스템, 재공, WIP, 홀드 시스템]
url: http://localhost:4173/portal.html
domains: [localhost:4173]
owner: 생산관리
login: 사내 로그인 화면이 뜨면 사용자가 직접 로그인한다. 로그인 전에는 조회 화면이 열리지 않는다
screens:
  - name: 재공 현황 조회
    path: 재공 > 재공 현황
    purpose: 라인·공정별 Lot과 수량 조회, 엑셀 내려받기
    url: http://localhost:4173/wip.html
  - name: Lot 홀드 해제 요청
    path: 홀드 > 해제 요청
    purpose: HOLD 걸린 Lot을 찾아 해제를 요청 (저장·상신은 승인 필요)
    url: http://localhost:4173/hold.html
  - name: 재공 수량 조정
    path: 재공 > 수량 조정
    purpose: Lot 수량을 고쳐 상신
    url: http://localhost:4173/adjust.html
terms:
  HOLD: 품질 문제 등으로 공정 진행을 멈춰 둔 Lot의 상태
  Lot: 같이 공정을 도는 웨이퍼 묶음. Lot ID로 찾는다
  재공: 공정 중간에 있는 제품 (WIP)
  정체 Lot: 한 공정에 기준 시간 넘게 머문 Lot
  라인: 생산 라인 번호 (예 7라인, 8라인)
---

- 조회는 자유롭게 할 수 있다. 저장·상신·해제 요청은 승인 창에서 사용자가 확인한 뒤에만 누른다.
- 라인은 "7라인"처럼 숫자와 "라인"을 함께 쓴다.
