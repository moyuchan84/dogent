// dogent eval pick의 기본 시험 문항과 방해 스킬.
//
// 문항은 클라이언트에 든 기본 스킬(skills/)을 대상으로 한다. 사내 스킬로 재려면 같은 모양의 JSON 파일을 만들어
// dogent eval pick --cases 파일.json 으로 준다.
// 방해 스킬은 목록이 커졌을 때를 흉내 낸다. 일부는 기본 스킬과 일부러 헷갈리게 만들었다 (홀드 등록 ↔ 홀드 해제 등).
import { fakeSkill, type PickCase } from '../src/core/pick-eval';

export const DEFAULT_PICK_CASES: PickCase[] = [
  { request: '7라인 재공 확인해줘', expect: 'wip-check', inputs: { line: '7라인' } },
  { request: '3라인 포토 공정 재공 보여줘', expect: 'wip-check', inputs: { line: '3라인', step: '포토' } },
  { request: '7라인에서 48시간 넘게 정체된 Lot 정리해줘', expect: 'wip-check', inputs: { line: '7라인', hold_hours: 48 } },
  { request: '7라인 재공을 엑셀 다운로드 버튼으로 전체 받아줘', expect: 'wip-download', inputs: { line: '7라인' } },
  { request: '5라인 재공 조회 결과 전체를 한 번에 내려받아서 정리해줘', expect: 'wip-download', inputs: { line: '5라인' } },
  { request: 'DR5 검색해서 정리해줘', expect: 'wip-search', inputs: { keyword: 'DR5' } },
  { request: 'NV2-1T 제품코드로 찾아서 수량 많은 공정 위주로 정리해줘', expect: 'wip-search', inputs: { keyword: 'NV2-1T' } },
  {
    request: '10.1.2.3에서 10.2.3.4로 443 포트 30일 열어줘. 사유는 배포 서버 연동',
    expect: 'firewall-request',
    inputs: { src_ip: '10.1.2.3', dst_ip: '10.2.3.4', port: 443, period_days: 30 },
  },
  {
    request: '방화벽 해제 신청해줘. 출발지 192.168.0.10, 목적지 10.0.0.5, UDP 53번 포트, 7일, 사유 DNS 점검',
    expect: 'firewall-request',
    inputs: { src_ip: '192.168.0.10', dst_ip: '10.0.0.5', port: 53, protocol: 'UDP', period_days: 7 },
  },
  { request: 'LOT1234 홀드 풀어줘. 사유는 재검사 통과', expect: 'hold-release', inputs: { lot: 'LOT1234' } },
  { request: 'P8-0042 Lot 홀드 해제 요청 올려줘, 원인 해소됨', expect: 'hold-release', inputs: { lot: 'P8-0042' } },
  { request: '엑셀로 정리한 Lot별 조정 수량을 재공 조정 화면에 일괄 입력해줘', expect: 'wip-adjust' },
  // 맞는 스킬이 없어야 하는 요청 (비슷한 말이 들어 있어도)
  { request: '오늘 점심 메뉴 추천해줘', expect: null },
  { request: '방화벽 신청한 거 취소해줘', expect: null },
  { request: '홀드 걸린 Lot에 메모 남겨줘', expect: null },
  // 방해 스킬을 섞으면 그쪽이 정답인 요청 (기본 목록에서는 고르지 않아야 한다)
  { request: 'LOT1234 홀드 걸어줘. 사유 외관 불량', expect: null, with_distractors: 'hold-register' },
  { request: 'LOT1234 공정 진행 이력 보여줘', expect: null, with_distractors: 'wip-history' },
  { request: '내가 낸 방화벽 신청 결재 어떻게 됐는지 확인해줘', expect: null, with_distractors: 'firewall-status' },
  { request: '내일 오후 2시에 6명 회의실 잡아줘', expect: null, with_distractors: 'meeting-room' },
  { request: '7라인 어제 수율 보고서로 정리해줘', expect: null, with_distractors: 'yield-report' },
];

const i = (name: string, label: string) => ({ name, label });

export const DISTRACTOR_SKILLS = [
  fakeSkill('wip-history', 'Lot 공정 이력 조회', 'Lot 하나의 공정별 투입·완료 시각과 설비 이력을 조회한다', [i('lot', 'Lot ID')]),
  fakeSkill('hold-register', 'Lot 홀드 등록', '문제가 있는 Lot을 홀드 상태로 등록 요청하고 사유를 남긴다', [i('lot', 'Lot ID'), i('reason', '사유')]),
  fakeSkill('firewall-status', '방화벽 신청 현황 조회', '내가 낸 방화벽 해제 신청의 결재 진행 상태를 조회한다'),
  fakeSkill('yield-report', '수율 보고', '라인별 일간 수율을 조회해 보고서 형식으로 정리한다', [i('line', '라인'), i('date', '날짜')]),
  fakeSkill('equipment-pm', '설비 PM 일정 조회', '설비별 예방 정비(PM) 일정과 지난 정비 기록을 조회한다', [i('equipment', '설비')]),
  fakeSkill('equipment-alarm', '설비 알람 이력', '설비에서 난 알람을 시간대별로 조회해 많이 난 순서로 정리한다', [i('equipment', '설비'), i('hours', '기간(시간)')]),
  fakeSkill('meeting-room', '회의실 예약', '날짜·시간·인원에 맞는 회의실을 찾아 예약한다', [i('date', '날짜'), i('time', '시간'), i('people', '인원')]),
  fakeSkill('business-trip', '출장 신청', '출장지와 기간을 넣어 출장 신청서를 작성한다', [i('dest', '출장지'), i('days', '기간')]),
  fakeSkill('vacation', '휴가 신청', '연차·반차 휴가 신청서를 작성해 상신한다', [i('start', '시작일'), i('days', '일수')]),
  fakeSkill('purchase-request', '구매 요청', '소모품·자재 구매 요청서를 작성한다', [i('item', '품목'), i('qty', '수량')]),
  fakeSkill('visitor-pass', '방문객 출입 신청', '외부 방문객의 출입증 발급을 신청한다', [i('name', '방문자'), i('date', '날짜')]),
  fakeSkill('account-request', '시스템 계정 신청', '사내 시스템의 사용 권한·계정을 신청한다', [i('system', '시스템')]),
  fakeSkill('vpn-request', 'VPN 사용 신청', '재택·외근용 VPN 사용 기간을 신청한다', [i('period_days', '기간(일)')]),
  fakeSkill('server-resource', '서버 자원 증설 요청', '서버의 CPU·메모리·디스크 증설을 요청한다', [i('server', '서버')]),
  fakeSkill('spec-search', '제품 사양 조회', '제품코드로 제품의 사양서와 주요 규격을 조회한다', [i('product', '제품코드')]),
  fakeSkill('recipe-check', '공정 레시피 조회', '공정과 설비별로 적용 중인 레시피 버전을 조회한다', [i('step', '공정'), i('equipment', '설비')]),
  fakeSkill('quality-issue', '품질 이슈 등록', 'Lot의 불량 현상을 품질 이슈로 등록한다', [i('lot', 'Lot ID'), i('defect', '불량 내용')]),
  fakeSkill('shipment', '출하 실적 조회', '일자별 제품 출하 실적을 조회해 정리한다', [i('date', '날짜')]),
  fakeSkill('inventory', '자재 재고 조회', '자재코드로 창고별 재고 수량을 조회한다', [i('material', '자재코드')]),
  fakeSkill('ecn-search', '설계 변경 검색', '설계 변경 통보(ECN)를 검색해 변경 내용을 요약한다', [i('keyword', '검색어')]),
  fakeSkill('doc-approval', '결재 현황 조회', '내가 상신한 결재 문서의 진행 상태를 조회한다'),
  fakeSkill('weekly-report', '주간 업무 보고', '이번 주 한 일을 주간 보고 양식에 맞춰 작성한다', [i('week', '주차')]),
  fakeSkill('training', '교육 이수 현황', '필수 교육의 이수 여부와 마감일을 조회한다'),
  fakeSkill('incident', '장애 신고', '사내 시스템 장애를 신고하고 접수 번호를 받는다', [i('system', '시스템'), i('symptom', '증상')]),
];
