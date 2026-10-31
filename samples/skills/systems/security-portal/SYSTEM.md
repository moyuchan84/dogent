---
id: security-portal
name: 모의 보안 포털
description: 방화벽 정책 같은 보안 신청을 올리는 포털. 집에서 시험하는 모의 사이트다
aliases: [보안 포털, 방화벽 신청, 방화벽]
url: http://localhost:4173/fw.html
domains: [localhost:4173]
owner: 정보보안
screens:
  - name: 방화벽 정책 신청
    path: 신청 > 방화벽
    purpose: 출발지·목적지 IP와 포트를 적어 정책을 신청 (상신은 승인 필요)
    url: http://localhost:4173/fw.html
terms:
  출발지: 접속을 시작하는 서버의 IP
  목적지: 접속을 받는 서버의 IP
---

- IP 대역은 필요한 만큼만 좁게 신청한다.
