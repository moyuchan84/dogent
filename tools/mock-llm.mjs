// 개발·테스트용 모의 모델 서버 (OpenAI 호환). 실행: node tools/mock-llm.mjs
//
// 실제 모델이 아니라 재공 확인 스킬 하나를 규칙으로 따라가는 스크립트다. Gemma 없이도
// 확장 → 화면 읽기 → 동작 → 엑셀 저장까지의 배관이 도는지 확인하는 용도이며,
// 모델의 판단 능력은 검증하지 못한다.
import { createServer } from 'node:http';
import { normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

function section(text, from, to) {
  const start = text.indexOf(from);
  if (start < 0) return '';
  const end = to ? text.indexOf(to, start + from.length) : -1;
  return text.slice(start + from.length, end < 0 ? undefined : end);
}

function planReply(user) {
  const request = section(user, '## 사용자 요청');
  if (request.includes('방화벽')) {
    const inputs = {};
    const ips = request.match(/\d+\.\d+\.\d+\.\d+(?:\/\d+)?/g) ?? [];
    const port = /(\d+)\s*(?:번\s*)?포트/.exec(request);
    const days = /(\d+)\s*일/.exec(request);
    const months = /(\d+)\s*개월/.exec(request);
    if (ips[0]) inputs.src_ip = ips[0];
    if (ips[1]) inputs.dst_ip = ips[1];
    if (port) inputs.port = port[1];
    if (/UDP/i.test(request)) inputs.protocol = 'UDP';
    if (days) inputs.period_days = Number(days[1]);
    else if (months) inputs.period_days = Number(months[1]) * 30;
    return { skill_id: 'firewall-request', inputs, reason: '방화벽 해제 신청 요청' };
  }
  if (!request.includes('재공')) {
    return { skill_id: null, inputs: {}, reason: '재공 관련 요청이 아닙니다' };
  }
  const inputs = {};
  const line = /(\d+)\s*라인/.exec(request);
  const step = /(PHOTO|ETCH|DIFF|CMP|IMP)/i.exec(request);
  const hours = /(\d+)\s*시간/.exec(request);
  if (line) inputs.line = `${line[1]}라인`;
  if (step) inputs.step = step[1].toUpperCase();
  if (hours) inputs.hold_hours = Number(hours[1]);
  return { skill_id: 'wip-check', inputs, reason: '재공 확인 요청' };
}

const TOOL_WORD = /\b(navigate|select|type|click|close_tab|extract_table|download_table|fill_table|transform|write_excel|finish)\b/;

/**
 * 인자가 스킬에 그대로 적힌 단계를 따라가는 범용 규칙. "지금 할 단계"의 `...` 안 JSON을 그대로 낸다.
 */
function followStep(user) {
  const stepText = section(user, '## 지금 할 단계').split('\n\n')[0];
  const history = section(user, '## 지금까지의 동작', '## 데이터셋').trim().split('\n');
  const page = section(user, '<page>', '</page>');
  const failed = history.slice(-2).filter((h) => h.includes('→ 실패'));
  if (failed.length === 2) {
    return { thought: '두 번 연속 실패', tool: 'abort', args: { reason: failed[1].split('→ 실패: ')[1] ?? '동작 실패' } };
  }
  const literal = /`(\{.*\})`/.exec(stepText)?.[1];
  const tool = TOOL_WORD.exec(stepText)?.[1];
  if (literal && tool) return { thought: '스킬에 적힌 인자 그대로', tool, args: JSON.parse(literal) };
  const url = /https?:\/\/[^\s"`]+/.exec(stepText)?.[0];
  if (url) return { thought: '화면 이동', tool: 'navigate', args: { url } };
  if (stepText.includes('finish')) {
    const id = /신청 번호: (\S+)/.exec(page)?.[1];
    return {
      thought: '보고',
      tool: 'finish',
      args: { summary: id ? `신청 번호 ${id}, 결재 대기 중입니다` : '모든 단계를 마쳤습니다' },
    };
  }
  return { thought: '할 일 없음', tool: 'next_step', args: {} };
}

/**
 * 자유 요청용 규칙. 실제 모델처럼 요청을 이해하는 것이 아니라, 시험에 쓰는 요청 형태
 * ("N라인 선택", "조회", "저장")만 화면에서 찾아 수행한다.
 */
function freeReply(user) {
  const request = /수행한다: (.*)$/m.exec(section(user, '## 지금 할 단계'))?.[1] ?? '';
  const history = section(user, '## 지금까지의 동작', '## 데이터셋').trim().split('\n');
  const page = section(user, '<page>', '</page>');
  const ref = (role, name) => {
    const m = new RegExp(`^\\[(\\d+)\\] ${role} "${name}"(.*)$`, 'm').exec(page);
    return m ? { ref: Number(m[1]), value: /value="([^"]*)"/.exec(m[2])?.[1] } : null;
  };
  const did = (pattern) => history.some((h) => pattern.test(h));
  if (history.slice(-2).filter((h) => h.includes('→ 실패')).length === 2) {
    return { thought: '두 번 연속 실패', tool: 'abort', args: { reason: history.at(-1).split('→ 실패: ')[1] ?? '실패' } };
  }
  const line = /(\d+라인)/.exec(request)?.[1];
  const lineSel = ref('combobox', '라인');
  if (line && lineSel && lineSel.value !== line) {
    return { thought: '라인 선택', tool: 'select', args: { ref: lineSel.ref, value: line } };
  }
  if (request.includes('저장') && !did(/click .*→ (성공|실패)/)) {
    return { thought: '저장', tool: 'click', args: { ref: '조건 저장' } };
  }
  if (request.includes('조회') && !did(/click .*→ 성공/)) {
    return { thought: '조회', tool: 'click', args: { ref: ref('button', '조회').ref } };
  }
  if (page.includes('조회 중')) return { thought: '대기', tool: 'wait_for', args: { text: '건', timeout_sec: 10 } };
  const total = /총 (\d+)건/.exec(page)?.[1];
  const saved = page.includes('조회 조건을 저장했습니다');
  return {
    thought: '보고',
    tool: 'finish',
    args: { summary: saved ? '조회 조건을 저장했습니다.' : total ? `조회 결과는 총 ${total}건입니다.` : '요청한 일을 마쳤습니다.' },
  };
}

function agentReply(user) {
  if (user.includes('(free v')) return freeReply(user);
  if (!user.includes('(wip-check v')) return followStep(user);
  const planned = planAction(user);
  const current = Number(/^## 지금 할 단계 \((\d+)\//m.exec(user)?.[1] ?? planned.step);
  if (planned.step > current && planned.tool !== 'abort') {
    return { thought: `${current}단계 완료`, tool: 'next_step', args: {} };
  }
  return planned;
}

function planAction(user) {
  const inputs = JSON.parse(/^입력값: (.*)$/m.exec(user)?.[1] ?? '{}');
  const skillBody = section(user, '입력값:', '## 지금까지의 동작');
  const history = section(user, '## 지금까지의 동작', '## 데이터셋').trim().split('\n');
  const datasets = section(user, '## 데이터셋', '## 현재 화면');
  const page = section(user, '<page>', '</page>');

  const el = (role, name) => {
    const m = new RegExp(`^\\[(\\d+)\\] ${role} "${name}"(.*)$`, 'm').exec(page);
    if (!m) return null;
    return {
      ref: Number(m[1]),
      value: /value="([^"]*)"/.exec(m[2])?.[1],
      disabled: m[2].includes('(비활성)'),
    };
  };
  const rowsOf = (name) => {
    const m = new RegExp(`^- ${name}: (\\d+)행`, 'm').exec(datasets);
    return m ? Number(m[1]) : undefined;
  };
  const did = (pattern) => history.some((h) => pattern.test(h));
  const last = history[history.length - 1] ?? '';
  const act = (step, thought, tool, args) => ({ step, thought, tool, args });

  if (!page.includes('# 재공 현황 조회')) {
    const url = /https?:\/\/[^\s"`]+/.exec(skillBody)?.[0];
    if (did(/navigate .*→ 성공/)) return act(1, '이동했지만 조회 화면이 아님', 'abort', { reason: '재공 현황 조회 화면을 열지 못했습니다' });
    return act(1, '조회 화면으로 이동', 'navigate', { url });
  }

  const lineSel = el('combobox', '라인');
  const stepSel = el('combobox', '공정');
  if (!lineSel || !stepSel) return act(2, '조건 영역 없음', 'abort', { reason: '라인/공정 선택 상자를 찾지 못했습니다' });
  if (lineSel.value !== inputs.line) {
    if (did(/\[단계 2\] select .*"value":"[^"]*라인".*→ 실패/)) {
      return act(2, '라인 옵션 없음', 'abort', { reason: `라인 "${inputs.line}"을 선택할 수 없습니다. ${last.split('→')[1] ?? ''}` });
    }
    return act(2, '라인 선택', 'select', { ref: lineSel.ref, value: String(inputs.line) });
  }
  if (inputs.step && stepSel.value !== inputs.step) {
    if (/select .*→ 실패/.test(last)) return act(3, '공정 옵션 없음', 'abort', { reason: `공정 "${inputs.step}"을 선택할 수 없습니다` });
    return act(3, '공정 선택', 'select', { ref: stepSel.ref, value: String(inputs.step) });
  }

  if (!did(/\[단계 4\] click .*→ 성공/)) {
    return act(4, '조회 실행', 'click', { ref: el('button', '조회').ref });
  }
  if (page.includes('조회 중')) return act(4, '조회 완료 대기', 'wait_for', { text: '건', timeout_sec: 10 });

  const total = Number(/총 (\d+)건/.exec(page)?.[1] ?? NaN);
  if (Number.isNaN(total)) return act(4, '총 건수 없음', 'abort', { reason: '조회 결과의 총 건수를 찾지 못했습니다' });
  if (total === 0) {
    return act(5, '결과 0건', 'abort', { reason: `조회 결과가 0건입니다. 조건: ${JSON.stringify(inputs)}` });
  }

  const table = el('table', '재공 목록');
  const wip = rowsOf('wip');
  if (wip === undefined) {
    const pager = el('button', '다음');
    return act(5, '모든 페이지 추출', 'extract_table', {
      ref: table.ref,
      dataset: 'wip',
      append: false,
      ...(pager ? { next_ref: pager.ref } : {}),
    });
  }
  if (wip < total) {
    if (/\[단계 5\] click .*→ 성공/.test(last)) {
      return act(5, '다음 페이지 추출', 'extract_table', { ref: table.ref, dataset: 'wip', append: true });
    }
    const next = el('button', '다음');
    if (!next || next.disabled) {
      return act(5, '행 수 불일치', 'abort', { reason: `추출 ${wip}행, 화면 총 ${total}건으로 서로 다릅니다` });
    }
    return act(5, '다음 페이지로', 'click', { ref: next.ref });
  }
  if (wip > total) return act(5, '행 수 불일치', 'abort', { reason: `추출 ${wip}행, 화면 총 ${total}건으로 서로 다릅니다` });

  if (rowsOf('hold') === undefined) {
    return act(6, '정체 Lot 필터', 'transform', {
      source: 'wip',
      target: 'hold',
      steps: [
        {
          op: 'filter',
          match: 'any',
          where: [
            { col: '정체시간', cmp: '>=', value: inputs.hold_hours },
            { col: '상태', cmp: '==', value: 'HOLD' },
          ],
        },
        { op: 'sort', by: '정체시간', desc: true },
      ],
    });
  }
  if (rowsOf('by_step') === undefined) {
    return act(7, '공정별 집계', 'transform', {
      source: 'wip',
      target: 'by_step',
      steps: [
        { op: 'group', by: ['공정'], agg: [{ fn: 'count', as: 'Lot수' }, { fn: 'sum', col: '수량', as: '수량합계' }] },
        { op: 'sort', by: '수량합계', desc: true },
      ],
    });
  }
  const filename = `재공확인_${inputs.line}`;
  if (!did(/write_excel .*→ 성공/)) {
    return act(8, '엑셀 저장', 'write_excel', {
      filename,
      sheets: [
        { name: '원본', dataset: 'wip' },
        { name: '정체Lot', dataset: 'hold' },
        { name: '공정별집계', dataset: 'by_step' },
      ],
    });
  }
  return act(9, '보고', 'finish', {
    summary: `총 재공 ${wip} Lot, 정체 Lot ${rowsOf('hold')}건, 공정 ${rowsOf('by_step')}개. 파일: ${filename}.xlsx`,
  });
}

/** 메시지 배열을 받아 모델 응답 문자열을 돌려준다. 테스트에서 직접 불러 쓴다. */
/** 스킬 다듬기. 입력의 label로 이름을 짓고, 첫 단계와 예외·결과에 문구를 단다. 못 넣을 제안도 하나 섞는다. */
const INPUT_NAMES = { 라인: 'line', '출발지 IP': 'src_ip', '목적지 IP': 'dst_ip' };
function polishReply(user) {
  const draft = section(user, '## 스킬 초안', '## 품질 검사 결과');
  const name = /^name: "(.*)"$/m.exec(draft)?.[1] ?? '이 업무';
  const inputs = {};
  for (const m of draft.matchAll(/- name: (\w+)\n\s+label: "(.*)"/g)) if (INPUT_NAMES[m[2]]) inputs[m[1]] = INPUT_NAMES[m[2]];
  return {
    description: `${name} 업무를 화면에서 대신 한다.`,
    inputs,
    steps: { 1: '업무를 시작할 화면을 연다.', 99: '없는 단계에 대한 설명.' },
    exceptions: ['조회 결과가 0건이면 abort로 조건을 다시 확인해 달라고 알린다.'],
    result: '',
    review: ['검사 식이 화면 문구에 맞는지 시험 실행으로 확인하세요.'],
  };
}

export function mockComplete(messages) {
  const system = messages.find((m) => m.role === 'system')?.content ?? '';
  const user = messages.filter((m) => m.role === 'user').at(0)?.content ?? '';
  if (!system && user.includes('연결 확인')) return 'ok';
  if (system.includes('스킬 문서 편집자')) return JSON.stringify(polishReply(user));
  return JSON.stringify(system.includes('스킬 선택기') ? planReply(user) : agentReply(user));
}

/**
 * requireHeaders를 주면 사내 게이트웨이처럼 그 헤더가 모두 있어야 답한다. 없으면 401.
 * 실행할 때는 MOCK_LLM_REQUIRE_HEADERS=x-dep-ticket,User-Id 처럼 준다.
 */
export function createMockLlm({ requireHeaders = [], log = () => {} } = {}) {
  return createServer((req, res) => {
    const cors = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
    };
    if (req.method === 'OPTIONS') {
      res.writeHead(204, cors).end();
      return;
    }
    if (req.method !== 'POST' || !req.url?.endsWith('/chat/completions')) {
      res.writeHead(404, cors).end();
      return;
    }
    const missing = requireHeaders.filter((h) => !req.headers[h.toLowerCase()]);
    if (requireHeaders.length) log(`요청 헤더 ${requireHeaders.map((h) => `${h}=${req.headers[h.toLowerCase()] ? '있음' : '없음'}`).join(', ')}`);
    if (missing.length) {
      res.writeHead(401, { ...cors, 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(`missing headers: ${missing.join(', ')}`);
      return;
    }
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      try {
        const { messages } = JSON.parse(body);
        const content = mockComplete(messages);
        res.writeHead(200, { ...cors, 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content } }] }));
      } catch (e) {
        res.writeHead(500, { ...cors, 'Content-Type': 'text/plain; charset=utf-8' });
        res.end(String(e?.stack ?? e));
      }
    });
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === normalize(process.argv[1])) {
  const port = Number(process.env.PORT ?? 4174);
  const requireHeaders = (process.env.MOCK_LLM_REQUIRE_HEADERS ?? '').split(',').map((h) => h.trim()).filter(Boolean);
  createMockLlm({ requireHeaders, log: console.log }).listen(port, () =>
    console.log(`모의 모델 API: http://localhost:${port}/v1${requireHeaders.length ? ` (필수 헤더: ${requireHeaders.join(', ')})` : ''}`),
  );
}
