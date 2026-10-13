import { JSDOM } from 'jsdom';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  mergeFrames,
  parseAction,
  pathKey,
  resolveInputs,
  runSkill,
  toCached,
  type ChatMessage,
  type HistoryEntry,
  type LlmPort,
  type PathStore,
  type RunEvent,
  type SkillPaths,
} from '../src/core';
import { createPageAgent } from '../src/page/agent';
import { JsdomBrowser, fwLog, fwSkill, memoryFiles, mockLlm } from './helpers';

const RAW = {
  src_ip: '10.10.1.15',
  dst_ip: '10.20.3.7',
  port: '1521',
  protocol: 'TCP',
  period_days: '90',
  reason: '개발 서버에서 운영 DB 조회 배치를 실행하기 위함',
};

function memoryPaths(): PathStore & { all: Map<string, SkillPaths> } {
  const all = new Map<string, SkillPaths>();
  return {
    all,
    load: async (key) => structuredClone(all.get(key) ?? null),
    save: async (key, paths) => void all.set(key, structuredClone(paths)),
  };
}

/** 모의 모델을 감싸 호출 횟수를 센다. */
function counted(): LlmPort & { calls: number } {
  const llm = {
    calls: 0,
    complete(messages: ChatMessage[], signal?: AbortSignal) {
      llm.calls++;
      return mockLlm.complete(messages, signal);
    },
  };
  return llm;
}

async function request(paths: PathStore, overrides: Record<string, string> = {}) {
  const { values, errors } = resolveInputs(fwSkill(), { ...RAW, ...overrides });
  expect(errors).toEqual([]);
  const llm = counted();
  const actions: HistoryEntry[] = [];
  const approvals: string[] = [];
  const result = await runSkill(fwSkill(), values, {
    llm,
    browser: new JsdomBrowser(),
    ui: { ask: async () => '', approve: async (r) => (approvals.push(r.button), true) },
    files: memoryFiles(),
    paths,
    onEvent: (e: RunEvent) => {
      if (e.type === 'action') actions.push(e.entry);
    },
  });
  return { result, llm, actions, approvals };
}

beforeEach(() => {
  fwLog.length = 0;
});

describe('성공한 경로의 기억', () => {
  it('두 번째 실행은 기억한 경로로 가고, 입력값이 달라도 그 값을 넣는다', async () => {
    const paths = memoryPaths();
    const first = await request(paths);
    expect(first.result.status, first.result.message).toBe('done');
    expect(first.actions.every((a) => a.by === 'model')).toBe(true);

    const saved = paths.all.get(pathKey(fwSkill()))!;
    expect(saved[2]).toEqual({ actions: [{ tool: 'type', args: { ref: '출발지 IP', text: '{src_ip}' } }], hits: 0 });
    expect(saved[8].actions).toEqual([{ tool: 'click', args: { ref: '상신' } }]);

    const second = await request(paths, { src_ip: '10.10.9.9', port: '8443', protocol: 'UDP' });
    expect(second.result.status, second.result.message).toBe('done');
    expect(second.llm.calls).toBeLessThan(first.llm.calls / 2);
    expect(second.actions.filter((a) => a.by === 'cache').length).toBeGreaterThanOrEqual(7);
    // 기억한 경로로 눌러도 상신 전에는 승인을 받는다.
    expect(second.approvals).toEqual(['상신']);
    expect(fwLog).toHaveLength(2);
    expect(fwLog[1]).toMatchObject({ src: '10.10.9.9', port: '8443', protocol: 'UDP', dst: RAW.dst_ip });
    expect(paths.all.get(pathKey(fwSkill()))![2].hits).toBe(1);
  });

  it('기억한 경로가 통하지 않으면 모델이 그 단계를 맡고 새 경로로 바꿔 저장한다', async () => {
    const paths = memoryPaths();
    await request(paths, { protocol: 'UDP' });
    const key = pathKey(fwSkill());
    const broken = paths.all.get(key)!;
    // 화면이 바뀌어 예전 이름의 칸이 없어진 상황
    broken[3] = { actions: [{ tool: 'type', args: { ref: '도착지 주소', text: '{dst_ip}' } }], hits: 4 };
    // 요소는 있지만 동작이 실패하는 상황
    broken[5] = { actions: [{ tool: 'select', args: { ref: '프로토콜', value: 'ICMP' } }], hits: 2 };

    const again = await request(paths, { protocol: 'UDP' });
    expect(again.result.status, again.result.message).toBe('done');
    expect(again.actions.filter((a) => a.step === 3).map((a) => a.by)).toEqual(['model']);
    expect(again.actions.filter((a) => a.step === 5).map((a) => [a.by, a.ok])).toEqual([
      ['cache', false],
      ['model', true],
    ]);
    const healed = paths.all.get(key)!;
    expect(healed[3]).toEqual({ actions: [{ tool: 'type', args: { ref: '목적지 IP', text: '{dst_ip}' } }], hits: 0 });
    expect(healed[5]).toEqual({ actions: [{ tool: 'select', args: { ref: '프로토콜', value: '{protocol}' } }], hits: 0 });
    expect(fwLog).toHaveLength(2);
  });

  it('스킬 내용이 바뀌면 예전 경로를 쓰지 않는다', () => {
    const skill = fwSkill();
    expect(pathKey({ ...skill, body: `${skill.body}\n` })).not.toBe(pathKey(skill));
    expect(pathKey({ ...skill, version: '9.9.9' })).not.toBe(pathKey(skill));
  });
});

describe('동작을 저장할 모양으로 바꾸기', () => {
  const dom = new JSDOM(
    `<!doctype html><body>
      <label>사유 <input></label>
      <button>조회</button><button>삭제</button>
      <table><thead><tr><th>Lot</th><th>공정</th><th></th></tr></thead><tbody>
        <tr><td>P7-00012</td><td>PHOTO</td><td><button>선택</button><button>삭제</button></td></tr>
        <tr><td>P7-00031</td><td>ETCH</td><td><button>선택</button></td></tr>
      </tbody></table>
      <div role="tab"></div>
    </body>`,
    { url: 'http://localhost:4173/t' },
  );
  const snap = mergeFrames([{ frame: 0, snap: createPageAgent(dom.window as any).snapshot() }]).snapshot;
  /** 이름과 행으로 요소 번호를 찾는다. row를 비우면 표 밖의 요소다. */
  const refOf = (name: string, row = '') => {
    const el = snap.items.find(
      (i) => i.kind === 'el' && i.name === name && (row === '' ? !i.row : (i.row ?? '').includes(row)),
    );
    return (el as { ref: number }).ref;
  };
  const action = (tool: string, args: object) => {
    const parsed = parseAction(JSON.stringify({ tool, args }), snap);
    if (!parsed.ok) throw new Error(parsed.error);
    return parsed.action;
  };

  it('요소는 이름으로, 입력값과 같은 글자는 자리표시자로 적는다', () => {
    const typed = toCached(action('type', { ref: refOf('사유'), text: '점검 완료' }), snap, { reason: '점검 완료', lot: 'P7-00031' });
    expect(typed).toEqual({ cached: { tool: 'type', args: { ref: '사유', text: '{reason}' } }, free: false });
    // 입력값에서 나왔는지 알 수 없는 글자는 그대로 두고 표시해 둔다.
    const literal = toCached(action('type', { ref: refOf('사유'), text: '점검 완료함' }), snap, { reason: '점검 완료' });
    expect(literal).toEqual({ cached: { tool: 'type', args: { ref: '사유', text: '점검 완료함' } }, free: true });
    expect(toCached(action('click', { ref: refOf('조회') }), snap, {})).toEqual({
      cached: { tool: 'click', args: { ref: '조회' } },
      free: false,
    });
    // 스킬 본문에 적힌 글자는 입력값과 무관하다.
    const go = action('navigate', { url: 'http://localhost:4173/fw.html' });
    expect(toCached(go, snap, {})?.free).toBe(true);
    expect(toCached(go, snap, {}, '1. `{"url": "http://localhost:4173/fw.html"}`')?.free).toBe(false);
  });

  it('행마다 있는 버튼은 그 행을 가리는 글자와 함께 적는다', () => {
    const picked = toCached(action('click', { ref: refOf('선택', 'P7-00031') }), snap, { lot: 'P7-00031' });
    expect(picked?.cached).toEqual({ tool: 'click', args: { ref: '선택', row: '{lot}' } });
    const fixed = toCached(action('click', { ref: refOf('선택', 'P7-00012') }), snap, {});
    expect(fixed?.cached).toEqual({ tool: 'click', args: { ref: '선택', row: 'P7-00012' } });
  });

  it('다시 찾을 수 없는 요소나 끝내는 동작은 저장하지 않는다', () => {
    expect(toCached(action('click', { ref: refOf('') }), snap, {})).toBeNull();
    // 표 밖과 표 안에 같은 이름이 있으면 표 밖의 것은 가릴 방법이 없다.
    expect(toCached(action('click', { ref: refOf('삭제') }), snap, {})).toBeNull();
    expect(toCached(action('finish', { summary: '끝' }), snap, {})).toBeNull();
  });
});
