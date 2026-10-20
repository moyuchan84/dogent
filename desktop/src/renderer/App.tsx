import { useEffect, useRef, useState } from 'react';
import type { ApprovalRequest, RunEvent, RunResult } from '../../../src/core';
import { searchSkills, skillCoversUrl } from '../../../src/core/catalog';
import type { BrowserLink } from '../../../bridge/hub.mjs';
import type { DogentApi, ExtensionStatus, InitInfo, ServerRow, SkillSummary, SystemSummary, UiMessage } from '../ipc';
import { ConnectDialog, ConnectorsPanel } from './Connectors';

declare global {
  interface Window {
    dogent: DogentApi;
  }
}
const api = window.dogent;

/** 대화에 쌓이는 것들 */
type Item =
  | { type: 'user'; text: string }
  | { type: 'text'; text: string }
  | { type: 'ask'; id: number; mode: 'text' | 'confirm'; question: string; fallback: string; answer?: string | null }
  | { type: 'run'; skill: string; page: string; events: RunEvent[]; approval?: ApprovalRequest; result?: { result: RunResult; saved: string[] } }
  | { type: 'form'; skill: SkillSummary };

const STATUS: Record<RunResult['status'], string> = {
  done: '완료',
  aborted: '중단',
  stopped: '멈춤',
  error: '오류',
  dryrun: '시험 실행 (제출 전 멈춤)',
};

/** 왼쪽 목록의 너비. 끌어서 바꾸고, 다시 열면 그대로 쓴다. */
const SIDE_KEY = 'dogent.sideWidth';
const SIDE_DEFAULT = 280;
const SIDE_MIN = 200;
const sideMax = () => Math.max(SIDE_MIN, Math.min(640, Math.round(window.innerWidth * 0.6)));
const clampSide = (w: number) => Math.min(sideMax(), Math.max(SIDE_MIN, Math.round(w)));

function useSideWidth() {
  const [width, setWidth] = useState(() => {
    try {
      const saved = Number(localStorage.getItem(SIDE_KEY));
      return saved ? clampSide(saved) : SIDE_DEFAULT;
    } catch {
      return SIDE_DEFAULT;
    }
  });
  const set = (w: number, keep = true) => {
    const next = clampSide(w);
    setWidth(next);
    if (!keep) return;
    try {
      localStorage.setItem(SIDE_KEY, String(next));
    } catch {
      /* 저장 못 해도 이번 실행에서는 그대로 쓴다 */
    }
  };
  // 창을 줄이면 목록이 화면을 다 차지하지 않게 맞춘다
  useEffect(() => {
    const onResize = () => setWidth((w) => clampSide(w));
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  return [width, set] as const;
}

const EXAMPLES = ['7라인 재공 확인해줘', '8라인을 선택하고 조회해서 총 몇 건인지 알려줘', 'skills', 'browsers'];

export function App() {
  const [info, setInfo] = useState<InitInfo | null>(null);
  const [items, setItems] = useState<Item[]>([]);
  const [busy, setBusy] = useState(false);
  const [browsers, setBrowsers] = useState<BrowserLink[]>([]);
  const [skills, setSkills] = useState<SkillSummary[]>([]);
  const [systems, setSystems] = useState<SystemSummary[]>([]);
  const [text, setText] = useState('');
  const [side, setSide] = useState<'skills' | 'systems' | 'connectors' | 'excel'>('skills');
  const [servers, setServers] = useState<ServerRow[]>([]);
  const [showConnect, setShowConnect] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [opts, setOpts] = useState({ allowWrite: false, dryRun: false });
  const [query, setQuery] = useState('');
  const [sideWidth, setSideWidth] = useSideWidth();
  const [page, setPage] = useState<{ url: string; title: string } | null>(null);
  const feedEnd = useRef<HTMLDivElement>(null);

  // 지금 브라우저 탭을 몇 초마다 읽어 그 사이트를 다루는 스킬을 위에 둔다
  useEffect(() => {
    const read = () => void api.page().then(setPage, () => setPage(null));
    read();
    const t = setInterval(read, 4000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    void api.init().then((i) => {
      setInfo(i);
      setSkills(i.skills);
      void api.systems().then(setSystems);
      void api.connectors().then(setServers);
      setBrowsers(i.browsers);
      setOpts(i.options);
    });
    return api.onUi((m) => apply(m));
  }, []);

  useEffect(() => {
    feedEnd.current?.scrollIntoView({ block: 'end' });
  }, [items]);

  /** 메인 프로세스에서 온 메시지를 대화에 반영한다. */
  function apply(m: UiMessage) {
    if (m.kind === 'busy') {
      setBusy(m.busy);
      if (!m.busy) {
        void api.skills().then(setSkills); // 자유 요청을 스킬로 저장했을 수 있다
        void api.systems().then(setSystems);
      }
      return;
    }
    if (m.kind === 'browsers') return setBrowsers(m.browsers);
    if (m.kind === 'skills') {
      void api.systems().then(setSystems);
      return void api.skills().then(setSkills);
    }
    setItems((prev) => {
      const next = [...prev];
      const lastRun = () => {
        for (let i = next.length - 1; i >= 0; i--) {
          const it = next[i];
          if (it.type === 'run') return { i, it };
        }
        return null;
      };
      switch (m.kind) {
        case 'print': {
          const last = next.at(-1);
          // 이어지는 글은 한 덩어리로 보인다.
          if (last?.type === 'text') next[next.length - 1] = { type: 'text', text: `${last.text}\n${m.text}` };
          else next.push({ type: 'text', text: m.text.replace(/^\n+/, '') });
          break;
        }
        case 'ask':
          next.push({ type: 'ask', id: m.id, mode: m.mode, question: m.question, fallback: m.fallback });
          break;
        case 'ask-closed': {
          const i = next.findIndex((it) => it.type === 'ask' && it.id === m.id);
          if (i >= 0) next[i] = { ...(next[i] as Extract<Item, { type: 'ask' }>), answer: null };
          break;
        }
        case 'started':
          next.push({ type: 'run', skill: m.skill, page: m.page, events: [] });
          break;
        case 'run': {
          const r = lastRun();
          if (r) next[r.i] = { ...r.it, events: [...r.it.events, m.event] };
          break;
        }
        case 'approval': {
          const r = lastRun();
          if (r) next[r.i] = { ...r.it, approval: m.request };
          break;
        }
        case 'result': {
          const r = lastRun();
          if (r) next[r.i] = { ...r.it, result: { result: m.result, saved: m.saved } };
          break;
        }
      }
      return next;
    });
  }

  function send(value = text) {
    const t = value.trim();
    if (!t || busy) return;
    setItems((prev) => [...prev, { type: 'user', text: t }]);
    setText('');
    void api.send(t);
  }

  function answer(id: number, value: string | null) {
    setItems((prev) => prev.map((it) => (it.type === 'ask' && it.id === id ? { ...it, answer: value } : it)));
    void api.answer(id, value);
  }

  function openForm(skill: SkillSummary) {
    setItems((prev) => [...prev, { type: 'form', skill }]);
  }

  function runForm(skill: SkillSummary, values: Record<string, string>) {
    setItems((prev) => [...prev, { type: 'user', text: `${skill.name} 실행` }]);
    void api.run(skill.id, values);
  }

  function setOption(patch: Partial<typeof opts>) {
    const next = { ...opts, ...patch };
    setOpts(next);
    void api.options(next);
  }

  const current = browsers.find((b) => b.selected);
  // 검색어가 있으면 맞는 순서로 한 줄, 없으면 "지금 화면"(이 탭의 사이트를 다루는 스킬) 다음에 출처별로
  const hits = query.trim() ? searchSkills(skills, (s) => s, query, { url: page?.url }) : [];
  const here = query.trim() ? [] : skills.filter((s) => skillCoversUrl(s, page?.url));
  const hereHost = (() => {
    try {
      return page ? new URL(page.url).host : '';
    } catch {
      return '';
    }
  })();
  const grouped = [
    ...(here.length ? [{ source: `지금 화면 · ${hereHost}`, list: here }] : []),
    ...(['개인', '팀', '기본'] as const).map((source) => ({ source, list: skills.filter((s) => s.source === source && !here.includes(s)) })),
  ].filter((g) => g.list.length);

  return (
    <div className="app">
      <div className="body" style={{ gridTemplateColumns: `${sideWidth}px 6px minmax(0, 1fr)` }}>
        <aside className="side">
          <div className="side-head">
            <div className="brand">
              <img src="./icon.svg" alt="" width={22} height={22} />
              Dogent
              {info && <span className="mode">{info.mode === 'production' ? '기본' : info.mode} · {info.version}</span>}
            </div>
          </div>
          <nav className="side-tabs">
            <button className={side === 'skills' ? 'on' : ''} onClick={() => setSide('skills')}>
              스킬 {skills.length}
            </button>
            <button className={side === 'systems' ? 'on' : ''} id="tab-systems" onClick={() => setSide('systems')} title="사내 시스템 사전: 요청에 시스템 이름이 나오면 모델에 함께 보여 줍니다">
              시스템 {systems.length}
            </button>
            <button className={side === 'connectors' ? 'on' : ''} id="tab-connectors" onClick={() => setSide('connectors')} title="MCP 서버: 사내 시스템의 도구를 브라우저 없이 부릅니다">
              커넥터 {servers.length}
            </button>
            <button className={side === 'excel' ? 'on' : ''} id="tab-excel" onClick={() => setSide('excel')}>
              엑셀 문서
            </button>
          </nav>
          {side === 'skills' ? (
            <>
            <div className="side-tools">
              <button className="compose" id="compose-skill" disabled={busy} onClick={() => send('스킬 만들기')} title="지금 브라우저 화면에서 하는 업무를 말로 설명하면 스킬 초안을 씁니다">
                <span aria-hidden>＋</span> 말로 스킬 만들기
              </button>
              <input
                id="skill-search"
                type="search"
                value={query}
                placeholder="스킬 찾기"
                aria-label="스킬 찾기"
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => e.key === 'Escape' && setQuery('')}
              />
            </div>
            <div className="side-list" id="skill-list">
              {query.trim() ? (
                <div style={{ display: 'grid', gap: 4 }} id="skill-hits">
                  <div className="group">찾은 스킬 {hits.length}</div>
                  {hits.map((h) => (
                    <SkillButton key={h.item.id} skill={h.item} here={h.site} showSource busy={busy} onOpen={openForm} />
                  ))}
                  {hits.length === 0 && (
                    <div className="hint">
                      맞는 스킬이 없습니다.{' '}
                      <button className="link" disabled={busy} onClick={() => send(`스킬 만들기 ${query}`)}>
                        "{query}" 말로 만들기
                      </button>
                    </div>
                  )}
                </div>
              ) : (
                grouped.map((g) => (
                  <div key={g.source} style={{ display: 'grid', gap: 4 }} data-group={g.source.startsWith('지금 화면') ? 'here' : g.source}>
                    <div className="group">{g.source}</div>
                    {g.list.map((s) => (
                      <SkillButton key={s.id} skill={s} showSource={g.source.startsWith('지금 화면')} busy={busy} onOpen={openForm} />
                    ))}
                  </div>
                ))
              )}
            </div>
            </>
          ) : side === 'systems' ? (
            <div className="side-list" id="system-list">
              {systems.length === 0 && <div className="empty">시스템 사전이 비어 있습니다. 팀 저장소의 skills/systems/&lt;id&gt;/SYSTEM.md에 시스템을 적어 두면 여기에 나타납니다.</div>}
              {systems.map((x) => (
                <button key={x.id} className="skill" data-system={x.id} disabled={busy} onClick={() => send(`systems info ${x.id}`)} title={`${x.description}
${x.url}`}>
                  <span>
                    <b>{x.name}</b>
                    <span className="chip" data-source={x.source}>
                      {x.source}
                    </span>
                  </span>
                  <small>{x.aliases.length ? `${x.aliases.join(', ')} · ` : ''}스킬 {x.skills}개</small>
                </button>
              ))}
            </div>
          ) : side === 'connectors' ? (
            <ConnectorsPanel servers={servers} onChange={setServers} onAdd={() => setShowConnect(true)} />
          ) : (
            <ExcelDocs />
          )}
          <footer className="side-foot">
            <div className="browser-pick" id="browser-pick">
              <span className={`dot ${current ? 'on' : ''}`} />
              {browsers.length === 0 ? (
                <span id="browser-none">브라우저 연결을 기다리는 중</span>
              ) : (
                <select id="browser-select" value={current?.id ?? ''} disabled={busy} onChange={(e) => void api.selectBrowser(e.target.value)}>
                  {browsers.map((b) => (
                    <option key={b.id} value={b.id}>
                      {b.browser} ({b.via})
                    </option>
                  ))}
                </select>
              )}
            </div>
            <button className="ghost" id="open-settings" onClick={() => setShowSettings(true)} title="모델, 브라우저 확장 연결, 저장 폴더">
              설정
            </button>
          </footer>
        </aside>

        <div
          className="splitter"
          id="side-splitter"
          role="separator"
          aria-orientation="vertical"
          aria-label="목록 너비 조절"
          aria-valuemin={SIDE_MIN}
          aria-valuemax={sideMax()}
          aria-valuenow={sideWidth}
          tabIndex={0}
          title="끌어서 목록 너비를 바꿉니다 (두 번 누르면 처음 너비)"
          onPointerDown={(e) => {
            e.preventDefault();
            const el = e.currentTarget;
            el.setPointerCapture(e.pointerId);
            el.classList.add('drag');
            const left = el.parentElement!.getBoundingClientRect().left;
            const move = (ev: PointerEvent) => setSideWidth(ev.clientX - left, false);
            const up = (ev: PointerEvent) => {
              el.releasePointerCapture(ev.pointerId);
              el.classList.remove('drag');
              el.removeEventListener('pointermove', move);
              el.removeEventListener('pointerup', up);
              el.removeEventListener('pointercancel', up);
              setSideWidth(ev.clientX - left);
            };
            el.addEventListener('pointermove', move);
            el.addEventListener('pointerup', up);
            el.addEventListener('pointercancel', up);
          }}
          onDoubleClick={() => setSideWidth(SIDE_DEFAULT)}
          onKeyDown={(e) => {
            const step = e.shiftKey ? 48 : 16;
            if (e.key === 'ArrowLeft') setSideWidth(sideWidth - step);
            else if (e.key === 'ArrowRight') setSideWidth(sideWidth + step);
            else if (e.key === 'Home') setSideWidth(SIDE_DEFAULT);
            else return;
            e.preventDefault();
          }}
        />

        <main className="main">
          <div className="feed" id="feed">
            {items.length === 0 && (
              <div className="welcome">
                <h1>무엇을 할까요?</h1>
                <p>업무 화면 탭을 브라우저 앞에 두고 말로 시키세요. 맞는 스킬이 있으면 스킬로, 없으면 지금 화면에서 직접 합니다. 왼쪽에서 스킬을 골라 입력값을 넣어 실행할 수도 있습니다.</p>
                <div className="examples">
                  {EXAMPLES.map((e) => (
                    <button key={e} className="secondary" onClick={() => send(e)}>
                      {e}
                    </button>
                  ))}
                </div>
              </div>
            )}
            {items.map((it, i) => (
              <FeedItem key={i} item={it} onAnswer={answer} onRun={runForm} onEdit={(id) => send(`skill edit ${id}`)} busy={busy} />
            ))}
            <div ref={feedEnd} />
          </div>

          <div className="composer">
            <div className="composer-inner">
              <div className="composer-box">
                <textarea
                  id="composer"
                  rows={2}
                  value={text}
                  placeholder="무엇을 할까요?  예: 8라인 재공 확인해줘"
                  onChange={(e) => setText(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                      e.preventDefault();
                      send();
                    }
                  }}
                />
                <div className="composer-bar">
                  <div className="opts">
                    <label className="toggle" title="스킬 없이 하는 자유 요청에서도 저장·상신 버튼을 누를 수 있게 합니다. 누르기 전에 승인 창으로 묻습니다">
                      <input id="opt-write" type="checkbox" checked={opts.allowWrite} disabled={busy} onChange={(e) => setOption({ allowWrite: e.target.checked })} />
                      <span>저장·상신 허용</span>
                    </label>
                    <label className="toggle" title="입력까지만 하고 저장·상신 직전에 멈춥니다">
                      <input id="opt-dry" type="checkbox" checked={opts.dryRun} disabled={busy} onChange={(e) => setOption({ dryRun: e.target.checked })} />
                      <span>시험 실행</span>
                    </label>
                  </div>
                  {busy ? (
                    <button className="danger stop" id="stop" onClick={() => void api.stop()}>
                      <span aria-hidden>■</span> 중지
                    </button>
                  ) : (
                    <button className="send" id="send" aria-label="보내기" title="보내기 (Enter)" disabled={!text.trim()} onClick={() => send()}>
                      <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden>
                        <path d="M8 13V3M3.5 7.5 8 3l4.5 4.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                    </button>
                  )}
                </div>
              </div>
              <div className="composer-note">Enter로 보내고 Shift+Enter로 줄을 바꿉니다. 저장·상신은 승인 창을 거칩니다.</div>
            </div>
          </div>
        </main>
      </div>

      {showConnect && <ConnectDialog onClose={() => setShowConnect(false)} onDone={setServers} />}
      {showSettings && <Settings onClose={() => setShowSettings(false)} onChanged={(c) => setInfo((i) => i && { ...i, config: c })} config={info?.config ?? ''} />}
    </div>
  );
}

/** 왼쪽 목록의 스킬 하나. 이 PC에서 돌려 본 적이 있으면 성공률을, 최근 연달아 실패했으면 그것을 보여 준다 */
function SkillButton({
  skill: s,
  here,
  showSource,
  busy,
  onOpen,
}: {
  skill: SkillSummary;
  here?: boolean;
  /** 출처별 묶음 밖(지금 화면, 찾은 스킬)에서는 출처를 따로 보여 준다 */
  showSource?: boolean;
  busy: boolean;
  onOpen: (s: SkillSummary) => void;
}) {
  const st = s.stats;
  return (
    <button className="skill" data-skill={s.id} disabled={busy} onClick={() => onOpen(s)} title={`${s.description}\n담당 ${s.owner}${s.tags.length ? ` · ${s.tags.join(', ')}` : ''}`}>
      <span>
        <b>{s.name}</b>
        {showSource && (
          <span className="chip" data-source={s.source}>
            {s.source}
          </span>
        )}
        {here && <span className="chip here">지금 화면</span>}
        {st?.broken ? (
          <span className="chip bad" title="전에는 되다가 최근 연달아 실패했습니다. 화면이 바뀌었을 수 있습니다">최근 실패</span>
        ) : st && st.rate !== null ? (
          <span className="chip" title={`이 PC에서 ${st.runs}번 실행`}>
            성공 {Math.round(st.rate * 100)}%
          </span>
        ) : null}
        <span className={`risk ${s.risk}`} title={s.risk === 'R3' ? '저장·상신까지 하는 스킬 (승인 필요)' : s.risk === 'R2' ? '값을 바꾸는 스킬' : '읽기만 하는 스킬'}>
          {s.risk}
        </span>
      </span>
      <small>
        {s.description}
        {s.source === '팀' && <> · {s.owner}</>}
      </small>
    </button>
  );
}

function FeedItem(props: {
  item: Item;
  onAnswer: (id: number, v: string | null) => void;
  onRun: (s: SkillSummary, v: Record<string, string>) => void;
  onEdit: (id: string) => void;
  busy: boolean;
}) {
  const it = props.item;
  if (it.type === 'user') return <div className="msg-user">{it.text}</div>;
  if (it.type === 'text') return <div className={`msg-text ${/^오류/.test(it.text) ? 'error' : ''}`}>{it.text}</div>;
  if (it.type === 'ask') return <Ask item={it} onAnswer={props.onAnswer} />;
  if (it.type === 'form') return <SkillForm skill={it.skill} onRun={props.onRun} onEdit={props.onEdit} busy={props.busy} />;
  return <RunCard run={it} />;
}

function Ask({ item, onAnswer }: { item: Extract<Item, { type: 'ask' }>; onAnswer: (id: number, v: string | null) => void }) {
  const [value, setValue] = useState('');
  if (item.answer !== undefined) {
    const shown = item.answer === null ? '(그만둠)' : item.mode === 'confirm' ? (item.answer === 'y' ? '예' : '아니오') : item.answer || item.fallback || '(빈 값)';
    return (
      <div className="answered">
        {item.question} → <b>{shown}</b>
      </div>
    );
  }
  return (
    <div className="card ask" data-ask={item.id}>
      <p>{item.question}</p>
      {item.mode === 'confirm' ? (
        <div className="row">
          <button data-yes onClick={() => onAnswer(item.id, 'y')} autoFocus={item.fallback === 'y'}>
            예
          </button>
          <button className="secondary" data-no onClick={() => onAnswer(item.id, 'n')} autoFocus={item.fallback !== 'y'}>
            아니오
          </button>
        </div>
      ) : (
        <form
          className="row"
          onSubmit={(e) => {
            e.preventDefault();
            onAnswer(item.id, value);
          }}
        >
          {/* 말로 스킬 만들기의 명령은 눌러서도 고른다 */}
          {item.question.includes('시험 · 저장 · 보기 · 그만') && (
            <div className="row quick" style={{ width: '100%' }}>
              {['시험', '저장', '보기', '그만'].map((c) => (
                <button key={c} type="button" className="secondary" data-quick={c} onClick={() => onAnswer(item.id, c)}>
                  {c}
                </button>
              ))}
            </div>
          )}
          <input data-answer autoFocus value={value} placeholder={item.fallback ? `비우면 ${item.fallback}` : ''} onChange={(e) => setValue(e.target.value)} style={{ flex: 1, width: 'auto' }} />
          <button type="submit">확인</button>
          <button type="button" className="ghost" onClick={() => onAnswer(item.id, null)}>
            그만두기
          </button>
        </form>
      )}
    </div>
  );
}

function SkillForm({
  skill,
  onRun,
  onEdit,
  busy,
}: {
  skill: SkillSummary;
  onRun: (s: SkillSummary, v: Record<string, string>) => void;
  onEdit: (id: string) => void;
  busy: boolean;
}) {
  const [values, setValues] = useState<Record<string, string>>(() => Object.fromEntries(skill.inputs.map((i) => [i.name, i.default])));
  const [sent, setSent] = useState(false);
  return (
    <form
      className="card form"
      data-form={skill.id}
      onSubmit={(e) => {
        e.preventDefault();
        setSent(true);
        onRun(skill, values);
      }}
    >
      <h3>
        {skill.name} <span className={`risk ${skill.risk}`}>{skill.risk}</span>
        <small>{skill.source}</small>
      </h3>
      <div className="hint">{skill.description}</div>
      {skill.inputs.map((i) => (
        <label key={i.name}>
          {i.label}
          {i.required ? ' *' : ''}
          {i.values.length ? (
            <select data-input={i.name} value={values[i.name] ?? ''} disabled={sent} onChange={(e) => setValues({ ...values, [i.name]: e.target.value })}>
              {!i.default && <option value="">선택</option>}
              {i.values.map((v) => (
                <option key={v}>{v}</option>
              ))}
            </select>
          ) : (
            <input
              data-input={i.name}
              value={values[i.name] ?? ''}
              disabled={sent}
              placeholder={i.type === 'file' ? '엑셀 파일 전체 경로 (예: D:\\자료\\조정.xlsx)' : i.default ? `기본값 ${i.default}` : ''}
              onChange={(e) => setValues({ ...values, [i.name]: e.target.value })}
            />
          )}
          {i.description && <span className="hint">{i.description}</span>}
        </label>
      ))}
      {!sent && (
        <div className="row">
          <button type="submit" disabled={busy}>
            실행
          </button>
          <button type="button" className="ghost" data-edit={skill.id} disabled={busy} onClick={() => onEdit(skill.id)} title="SKILL.md를 편집기로 열고, 닫으면 품질 검사">
            파일로 고치기
          </button>
        </div>
      )}
    </form>
  );
}

function describe(e: RunEvent): { mark: string; cls: string; text: React.ReactNode } | null {
  switch (e.type) {
    case 'action': {
      const h = e.entry;
      return {
        mark: h.ok ? '✓' : '✗',
        cls: h.ok ? '' : 'fail',
        text: (
          <>
            단계 {h.step} · <b>{h.tool}</b>
            {h.by === 'skill' && <span className="chip">모델 호출 없음</span>}
            {h.by === 'cache' && <span className="chip">기억한 경로</span>}
            <div>{h.result}</div>
            <code>{JSON.stringify(h.args).slice(0, 120)}</code>
          </>
        ),
      };
    }
    case 'approval':
      return { mark: e.approved ? '✓' : '✗', cls: e.approved ? 'minor' : 'fail', text: `"${e.request.button}" ${e.dryRun ? '직전에 멈춤 (시험 실행)' : e.approved ? '승인됨' : '승인하지 않음'}` };
    case 'login_done':
      return { mark: '·', cls: 'minor', text: '로그인됨, 이어서 진행' };
    case 'llm_retry':
      return { mark: '·', cls: 'minor', text: `모델 응답 형식 오류, 다시 요청: ${e.reason.split('\n')[0].slice(0, 140)}` };
    case 'blocked':
      return { mark: '✗', cls: 'fail', text: `막힘: ${e.tool} — ${e.reason}` };
    default:
      return null;
  }
}

function RunCard({ run }: { run: Extract<Item, { type: 'run' }> }) {
  const waitingLogin = !run.result && run.events.at(-1)?.type === 'login_wait';
  const lines = run.events.map(describe).filter((x): x is NonNullable<typeof x> => x !== null);
  const r = run.result;
  return (
    <section className="card run" data-run={run.skill}>
      <h3>
        {run.skill} <small>{run.page}</small>
      </h3>
      <ol className="steps">
        {lines.map((l, i) => (
          <li key={i} className={l.cls}>
            <span className="mark">{l.mark}</span>
            <div>{l.text}</div>
          </li>
        ))}
        {!r && lines.length === 0 && <li className="minor">시작하는 중…</li>}
      </ol>
      {waitingLogin && (
        <div className="notice login">
          <b>로그인이 필요합니다.</b> 브라우저의 그 탭에서 직접 로그인해 주세요. 로그인되면 이어서 진행합니다 (Dogent는 비밀번호를 입력하지 않습니다).
        </div>
      )}
      {run.approval && !r && (
        <div className="notice approval" id="approval-notice">
          <b>"{run.approval.button}" 전에 확인이 필요합니다.</b> 브라우저에 뜬 Dogent 승인 창에서 승인하거나 취소하세요.
          <dl>
            {run.approval.fields.map((f) => (
              <div key={f.name} style={{ display: 'contents' }}>
                <dt>{f.name}</dt>
                <dd>{f.value || '(비어 있음)'}</dd>
              </div>
            ))}
          </dl>
        </div>
      )}
      {r && (
        <div className={`result ${r.result.status}`} id="result" data-status={r.result.status}>
          <div className="result-head">
            <b>{STATUS[r.result.status]}</b>
            <span>
              동작 {r.result.actions}회 · {(r.result.elapsedMs / 1000).toFixed(1)}초
            </span>
          </div>
          <p>{r.result.message}</p>
          {r.saved.length > 0 && (
            <div className="files">
              {r.saved.map((f) => (
                <div key={f}>
                  <span title={f}>{f}</span>
                  <button className="secondary" onClick={() => void api.show(f)}>
                    폴더에서 보기
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </section>
  );
}

function ExcelDocs() {
  const [docs, setDocs] = useState<{ name: string; full_name: string; read_only: boolean }[] | null>(null);
  const [error, setError] = useState('');
  const load = () => {
    setError('');
    api.excelDocs().then(setDocs, (e: Error) => setError(e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')));
  };
  useEffect(load, []);
  return (
    <div className="side-list" id="excel-docs">
      <div className="hint">문서 공유망(EDM)에서 읽기·편집으로 연 문서처럼, 지금 Excel에 열린 문서입니다.</div>
      <button className="secondary" onClick={load}>
        다시 보기
      </button>
      {error && <div className="empty">{error}</div>}
      {docs?.length === 0 && <div className="empty">Excel에 열린 문서가 없습니다</div>}
      {docs?.map((d) => (
        <div key={d.full_name} className="skill" title={d.full_name}>
          <b>{d.name}</b>
          <small>
            {d.read_only ? '읽기 전용 · ' : ''}
            {d.full_name}
          </small>
        </div>
      ))}
    </div>
  );
}

function Settings({ onClose, onChanged, config }: { onClose: () => void; onChanged: (config: string) => void; config: string }) {
  const [token, setToken] = useState('');
  const [copied, setCopied] = useState(false);
  const [link, setLink] = useState<ExtensionStatus | null>(null);
  const [extId, setExtId] = useState('');
  const [form, setForm] = useState({ userId: '', browser: '', outputDir: '', teamSkills: '' });
  const [message, setMessage] = useState('');
  useEffect(() => {
    void api.token().then(setToken);
    void api.extension().then(setLink);
  }, []);
  const save = async (key: string, value: string) => {
    try {
      onChanged(await api.setConfig(key, value));
      setMessage('저장했습니다');
    } catch (e) {
      setMessage((e as Error).message);
    }
  };
  type Field = { key: keyof typeof form; config: string; label: string; hint: string };
  const fields: Record<'account' | 'browser' | 'storage', Field[]> = {
    account: [{ key: 'userId', config: 'llm.userId', label: '사용자 ID (사내 SSO ID)', hint: '사내 모델 게이트웨이의 user-id 헤더' }],
    browser: [{ key: 'browser', config: 'browser', label: '쓸 브라우저', hint: '확장이 든 브라우저가 여럿일 때 이름 일부 (예: edge, chrome)' }],
    storage: [
      { key: 'outputDir', config: 'outputDir', label: '결과 엑셀 저장 폴더', hint: '비우면 내려받기 폴더' },
      { key: 'teamSkills', config: 'teamSkills', label: '팀 스킬 저장소 폴더', hint: '사내 GitHub의 dogent-skills를 받아 둔 폴더' },
    ],
  };
  const fieldRow = (f: Field) => (
    <label key={f.key}>
      {f.label}
      <div className="token">
        <input value={form[f.key]} placeholder={f.hint} onChange={(e) => setForm({ ...form, [f.key]: e.target.value })} />
        <button className="secondary" disabled={!form[f.key].trim()} onClick={() => void save(f.config, form[f.key].trim())}>
          저장
        </button>
      </div>
    </label>
  );
  return (
    <div className="overlay" onClick={onClose}>
      <div className="drawer" id="settings" onClick={(e) => e.stopPropagation()}>
        <div className="drawer-head">
          <h2>설정</h2>
          <button className="ghost" onClick={onClose}>
            닫기
          </button>
        </div>
        {message && <div className="toast">{message}</div>}

        <section className="set-section" id="extension-link">
          <h3>브라우저 확장 연결</h3>
          {link?.ids.length ? (
            <div className="hint ok-note">
              연결 준비됨 (확장 {link.ids.length}개 허용). 브라우저의 Dogent 사이드 패널 → 설정 → 클라이언트 연결에서 방식을 Native Messaging으로 하면 토큰 없이 붙습니다.
            </div>
          ) : (
            <div className="hint">
              설치된 Dogent 확장을 찾지 못했습니다. 크롬·엣지에 확장을 설치하고 아래 다시 찾기를 누르거나, 확장 ID를 직접 넣으세요.
            </div>
          )}
          {link?.error && <div className="hint">오류: {link.error}</div>}
          <div className="token">
            <input value={extId} placeholder="확장 ID (32글자, 확장 관리 화면에 나옴)" onChange={(e) => setExtId(e.target.value)} />
            <button className="secondary" onClick={() => void api.extension(extId.trim() || undefined).then(setLink)}>
              {extId.trim() ? '등록' : '다시 찾기'}
            </button>
          </div>
          <label>
            WebSocket으로 붙을 때만 쓰는 토큰
            <div className="token">
              <input readOnly value={token} id="token" />
              <button
                className="secondary"
                onClick={() => {
                  navigator.clipboard.writeText(token).then(() => setCopied(true), () => {});
                }}
              >
                {copied ? '복사됨' : '복사'}
              </button>
            </div>
            <span className="hint">회사 정책으로 Native Messaging이 막혔을 때: 사이드 패널 → 설정 → 클라이언트 연결에서 WebSocket을 고르고 이 토큰을 넣으세요.</span>
          </label>
          {fields.browser.map(fieldRow)}
        </section>

        <section className="set-section">
          <h3>계정</h3>
          {fields.account.map(fieldRow)}
        </section>

        <section className="set-section">
          <h3>저장 위치</h3>
          {fields.storage.map(fieldRow)}
        </section>

        <section className="set-section">
          <h3>지금 설정</h3>
          <pre id="config">{config}</pre>
        </section>
      </div>
    </div>
  );
}
