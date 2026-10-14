import { useEffect, useMemo, useRef, useState } from 'react';
import { browser } from 'wxt/browser';
import {
  addRecorded,
  addRowButtons,
  draftSkill,
  fillableColumns,
  firstHeading,
  lintSkill,
  pickAppeared,
  polishSkill,
  type AuthorStep,
  type DraftStart,
  type LintReport,
  type LlmPort,
  type PageDialog,
  type PageSnapshot,
  type PolishResult,
  type RecordedEvent,
} from '@/src/core';
import { ChromeBrowser } from '@/src/ext/browser';
import { deleteDraft, saveDraft, type DraftSkill } from '@/src/ext/storage';
import { download, targetTab } from './util';

const GRADE_LABEL: Record<LintReport['grade'], string> = {
  A: 'A · 배포 기준 충족',
  B: 'B · 배포 기준 충족',
  C: 'C · 보완 필요',
  F: 'F · 실행 불가',
};
/** 가져올 수 있는 SKILL.md의 최대 크기. 스킬은 보통 몇 KB다. */
const MAX_IMPORT_BYTES = 200_000;
/** 녹화 중 새로 열린 화면에도 녹화를 거는 주기 */
const REARM_MS = 500;

function describeStep(s: AuthorStep): string {
  if (s.kind === 'click') {
    const shown = (s.dialogs ?? []).map((d) => (d.kind === 'alert' ? `알림 "${d.message}"` : `"${d.message}"에 ${d.accepted ? '확인' : '취소'}`));
    return `"${s.name || '(이름 없음)'}"${s.row ? ` (${s.row} 행)` : ''} 누름${s.expect ? ` → "${s.expect}" 나타남` : ''}${shown.length ? ` → ${shown.join(', ')}` : ''}`;
  }
  if (s.kind === 'fill') return '"' + s.name + '" 표에 엑셀 채우기 (' + s.columns.join(', ') + ')' + (s.add ? ', 모자라면 "' + s.add + '"' : '');
  if (s.kind === 'extract') return `"${s.name}" 표 읽기${s.next ? ` ("${s.next}"로 끝 페이지까지)` : ''}`;
  return `"${s.name || '(이름 없음)'}"에 ${s.kind === 'type' ? '입력' : '선택'}: ${s.value}`;
}

/** 알림·확인 창을, 그 창이 뜨기 직전에 누른 조작에 붙인다. 창은 누른 뒤 한참 있다 뜨기도 한다. */
function withDialogs(steps: AuthorStep[], dialogs: PageDialog[]): AuthorStep[] {
  const next = [...steps];
  for (const d of dialogs) {
    const i = next.findLastIndex((s) => s.kind === 'click' && (s.at ?? 0) <= (d.at ?? Infinity));
    const step = next[i];
    if (step?.kind === 'click') next[i] = { ...step, dialogs: [...(step.dialogs ?? []), d] };
  }
  return next;
}

/** 화면에서 다음 페이지 버튼으로 보이는 요소의 이름 (이름이 하나뿐인 것만) */
function nextButtons(snap: PageSnapshot | undefined): string[] {
  const names = (snap?.items ?? []).flatMap((i) =>
    i.kind === 'el' && (i.role === 'button' || i.role === 'link') && !i.row && /다음|next|^[>›»▶]+$/i.test(i.name.trim()) ? [i.name] : [],
  );
  return names.filter((n) => names.indexOf(n) === names.lastIndexOf(n));
}

/**
 * 스킬 만들기. 업무를 한 번 해 보이면 초안이 만들어지고, 품질 검사를 통과하면 초안으로 저장해 시험 실행한다.
 * 만든 사람이 형식을 외울 필요가 없고, 누가 만들어도 같은 기준으로 검사된다.
 */
export function Author(props: { bundledIds: string[]; drafts: DraftSkill[]; onChange: () => void; llm: () => LlmPort }) {
  const [meta, setMeta] = useState({ id: '', name: '', description: '', owner: '' });
  const [state, setState] = useState<'idle' | 'recording' | 'editing'>('idle');
  const [steps, setSteps] = useState<AuthorStep[]>([]);
  const [tables, setTables] = useState<string[] | null>(null);
  // 표 고르기가 읽기용인지 엑셀 채우기용인지
  const [tableUse, setTableUse] = useState<'extract' | 'fill'>('extract');
  // 채울 표를 고른 뒤, 행 추가 버튼으로 보이는 것들. 빈 행이 모자랄 때 누를 버튼을 묻는다.
  const [adding, setAdding] = useState<{ table: string; columns: string[]; buttons: string[] } | null>(null);
  // 표를 고른 뒤, 다음 페이지 버튼으로 보이는 것들. 여러 페이지를 넘기며 읽을지 묻는다.
  // 녹화 중에 뜬 알림·확인 창. 창을 읽어 온 때에 그 창을 띄운 누름이 아직 목록에 없을 수 있으므로,
  // 조작과 따로 모아 두고 보여줄 때마다 뜬 시각으로 다시 맞춘다.
  const [seen, setSeen] = useState<PageDialog[]>([]);
  const [paging, setPaging] = useState<{ table: string; buttons: string[] } | null>(null);
  const [source, setSource] = useState('');
  const [notes, setNotes] = useState<string[]>([]);
  const [notice, setNotice] = useState('');
  // 모델로 다듬은 결과와, 되돌릴 때 쓸 다듬기 전 원문
  const [polished, setPolished] = useState<(PolishResult & { before: string }) | null>(null);
  const [polishing, setPolishing] = useState(false);
  const session = useRef<{ browser: ChromeBrowser; tabId: number; start: DraftStart; last: PageSnapshot; stop: () => void } | null>(null);

  useEffect(() => () => session.current?.stop(), []);

  const report = useMemo(() => {
    if (state !== 'editing') return null;
    const r = lintSkill(source);
    // 번들된 스킬과 같은 id를 쓰면 어느 쪽이 실행되는지 알 수 없다.
    if (r.skill && props.bundledIds.includes(r.skill.id)) {
      return { ...r, grade: 'F' as const, deployable: false, findings: [{ level: 'error' as const, rule: 'E07', message: `id "${r.skill.id}"는 이미 배포된 스킬이 쓰고 있습니다` }, ...r.findings] };
    }
    return r;
  }, [state, source, props.bundledIds]);

  async function startRecording() {
    if (!/^[a-z][a-z0-9-]*$/.test(meta.id)) return setNotice('스킬 ID는 영문 소문자로 시작하고 소문자·숫자·하이픈만 씁니다 (예: wip-check)');
    if (!meta.name.trim() || !meta.description.trim() || !meta.owner.trim()) return setNotice('이름, 설명, 담당 부서를 모두 적어 주세요');
    try {
      const tab = await targetTab();
      const chrome = new ChromeBrowser(tab.id);
      const first = await chrome.snapshot();
      if (first.hasPassword) throw new Error('로그인 화면에서는 녹화하지 않습니다. 로그인한 뒤 업무 화면에서 시작해 주세요');
      if (!/^https?:/.test(first.url) || first.items.length <= 1) throw new Error('이 탭은 Dogent가 읽을 수 없는 화면입니다. 업무 화면이 열린 탭에서 시작해 주세요');

      // 조작은 온 순서대로 하나씩 처리한다. 누른 뒤의 화면을 읽는 동안 다음 조작이 끼어들지 않게 한다.
      let queue = Promise.resolve();
      const onMessage = (msg: unknown, sender: { tab?: { id?: number } }) => {
        const event = (msg as { dogentRecord?: RecordedEvent })?.dogentRecord;
        // 대상 탭과 거기서 열린 창의 조작만 받는다.
        if (!event || sender.tab?.id === undefined || !chrome.owns(sender.tab.id)) return;
        queue = queue
          .then(async () => {
            const s = session.current;
            if (!s) return;
            let expect: string | undefined;
            if (event.kind === 'click') {
              // 확인 창이 떠 있으면 사람이 답할 때까지 여기서 기다린다. 새 창이 열렸으면 그 창을 읽는다.
              // 앞의 누름 뒤에 늦게 뜬 창도 여기서 함께 읽히며, 뜬 시각으로 제 누름에 붙는다.
              const after = await chrome.settledSnapshot();
              expect = pickAppeared(s.last, after);
              s.last = after;
              const dialogs = await chrome.recordedDialogs();
              if (dialogs.length) setSeen((prev) => [...prev, ...dialogs]);
            }
            setSteps((prev) => {
              const next = addRecorded(prev, event);
              if (expect) next[next.length - 1] = { ...next[next.length - 1], expect } as AuthorStep;
              return next;
            });
          })
          // 한 조작을 읽다 실패해도 그 뒤의 녹화는 이어 간다.
          .catch(() => {});
      };
      browser.runtime.onMessage.addListener(onMessage);
      await chrome.record(true);
      const timer = setInterval(() => void chrome.record(true), REARM_MS);
      session.current = {
        browser: chrome,
        tabId: tab.id,
        start: { url: first.url, heading: firstHeading(first) },
        last: first,
        stop() {
          clearInterval(timer);
          browser.runtime.onMessage.removeListener(onMessage);
          void chrome.record(false);
        },
      };
      setSteps([]);
      setSeen([]);
      setTables(null);
      setNotice('');
      setState('recording');
    } catch (e) {
      setNotice((e as Error).message);
    }
  }

  async function findTables(use: 'extract' | 'fill') {
    const s = session.current;
    if (!s) return;
    const snap = await s.browser.snapshot();
    s.last = snap;
    setPaging(null);
    setAdding(null);
    setTableUse(use);
    setTables(snap.items.flatMap((i) => (i.kind === 'el' && i.role === 'table' ? [i.name] : [])));
  }

  /** 표를 고르면, 화면에 다음 페이지 버튼이 있을 때 끝까지 넘기며 읽을지 묻는다. */
  async function pickTable(name: string) {
    setTables(null);
    if (tableUse === 'fill') return pickFillTable(name);
    const buttons = nextButtons(session.current?.last);
    if (buttons.length === 0) setSteps([...steps, { kind: 'extract', name }]);
    else setPaging({ table: name, buttons });
  }

  /** 엑셀로 채울 표를 고르면, 값을 넣을 수 있는 컬럼을 읽고 행 추가 버튼을 묻는다. */
  async function pickFillTable(name: string) {
    const s = session.current;
    if (!s) return;
    try {
      const table = s.last.items.find((i) => i.kind === 'el' && i.role === 'table' && i.name === name);
      if (table?.kind !== 'el') throw new Error('표를 다시 찾지 못했습니다');
      const columns = fillableColumns(s.last, (await s.browser.extractTable(table.ref)).columns);
      const buttons = addRowButtons(s.last);
      if (buttons.length === 0) setSteps((prev) => [...prev, { kind: 'fill', name, columns }]);
      else setAdding({ table: name, columns, buttons });
    } catch (e) {
      setNotice((e as Error).message);
    }
  }

  async function stopRecording() {
    const s = session.current;
    if (!s) return;
    const late = await s.browser.recordedDialogs().catch(() => []);
    const recorded = withDialogs(steps, [...seen, ...late]);
    s.stop();
    session.current = null;
    const draft = draftSkill(meta, s.start, recorded);
    edit(draft.source);
    setNotes(draft.notes);
  }

  /** 글만 모델에 맡긴다. 도구·인자·검사가 달라지는 제안은 core가 버린다. */
  async function polish() {
    setPolishing(true);
    setNotice('');
    try {
      const r = await polishSkill(source, props.llm());
      setPolished({ ...r, before: source });
      setSource(r.source);
    } catch (e) {
      setNotice(`다듬지 못했습니다: ${(e as Error).message}`);
    } finally {
      setPolishing(false);
    }
  }

  function edit(next: string) {
    setSource(next);
    setNotes([]);
    setPolished(null);
    setNotice('');
    setState('editing');
  }

  /** 받은 SKILL.md 파일을 초안 편집 화면으로 연다. 저장하기 전까지는 아무것도 바뀌지 않는다. */
  async function importFile(file: File | undefined) {
    if (!file) return;
    if (file.size > MAX_IMPORT_BYTES) return setNotice('파일이 너무 큽니다. SKILL.md 파일인지 확인해 주세요');
    edit(await file.text());
    setNotes(['"' + file.name + '" 파일에서 가져왔습니다. 품질 검사 결과를 확인하고, 저장한 뒤 이 PC에서 시험 실행해 보세요.']);
  }

  async function save() {
    if (!report?.skill || report.grade === 'F') return;
    await saveDraft(report.skill.id, source);
    props.onChange();
    setNotice(`초안 "${report.skill.name}"을(를) 저장했습니다. 실행 탭의 스킬 목록에서 골라 시험 실행하세요.`);
    setState('idle');
  }

  return (
    <>
      <section className="card">
        <h2>스킬 만들기</h2>
        <p className="hint">업무를 한 번 해 보이면 절차서 초안이 만들어집니다. 품질 검사를 통과하면 초안으로 저장해 시험 실행합니다.</p>
        {notice && <p className="notice">{notice}</p>}

        {state === 'idle' && (
          <>
            <label>
              스킬 ID
              <input id="a-id" value={meta.id} placeholder="예: wip-check" onChange={(e) => setMeta({ ...meta, id: e.target.value.trim() })} />
            </label>
            <label>
              이름
              <input id="a-name" value={meta.name} placeholder="예: 재공 확인" onChange={(e) => setMeta({ ...meta, name: e.target.value })} />
            </label>
            <label>
              설명
              <input id="a-desc" value={meta.description} placeholder="무엇을 조회하거나 입력하는 업무인지 한 문장" onChange={(e) => setMeta({ ...meta, description: e.target.value })} />
            </label>
            <label>
              담당 부서
              <input id="a-owner" value={meta.owner} placeholder="화면이 바뀌면 고칠 책임이 있는 부서" onChange={(e) => setMeta({ ...meta, owner: e.target.value })} />
            </label>
            <div className="row">
              <button id="rec-start" onClick={startRecording}>
                녹화 시작
              </button>
            </div>
            <p className="hint">업무의 첫 화면을 연 상태에서 시작하세요. 비밀번호 칸은 녹화하지 않습니다.</p>
          </>
        )}

        {state === 'recording' && (
          <div id="rec" data-count={steps.length}>
            <p className="notice rec">녹화 중 — 업무 화면에서 평소대로 한 번 해 보이세요.</p>
            <ol className="rec-list">
              <li className="minor">시작 화면: {session.current?.start.heading ?? session.current?.start.url}</li>
              {steps.map((s, i) => (
                <li key={i}>
                  <span>{describeStep(withDialogs(steps, seen)[i])}</span>
                  {(s.kind === 'type' || s.kind === 'select') && (
                    <label className="check">
                      <input
                        type="checkbox"
                        data-variable={i}
                        checked={s.variable}
                        onChange={(e) => setSteps(steps.map((x, j) => (j === i ? ({ ...x, variable: e.target.checked } as AuthorStep) : x)))}
                      />
                      실행할 때마다 입력받기
                    </label>
                  )}
                  <button className="ghost" title="이 조작을 뺀다" onClick={() => setSteps(steps.filter((_, j) => j !== i))}>
                    빼기
                  </button>
                </li>
              ))}
            </ol>
            <div className="row">
              <button id="rec-table" className="secondary" onClick={() => findTables('extract')}>
                화면의 표 읽기 추가
              </button>
              <button id="rec-fill" className="secondary" title="실행할 때 받은 엑셀 파일의 행을 화면의 표에 채웁니다" onClick={() => findTables('fill')}>
                엑셀로 표 채우기 추가
              </button>
              <button id="rec-stop" onClick={stopRecording}>
                녹화 끝
              </button>
            </div>
            {tables &&
              (tables.length === 0 ? (
                <p className="hint">이 화면에서 읽을 수 있는 표를 찾지 못했습니다.</p>
              ) : (
                <div className="row wrap">
                  {tables.map((name) => (
                    <button
                      key={name}
                      className="secondary"
                      data-table={name}
                      onClick={() => pickTable(name)}
                    >
                      "{name}" 표
                    </button>
                  ))}
                </div>
              ))}
          </div>
        )}

        {state === 'recording' && adding && (
          <div className="row wrap" id="rec-add">
            <span className="hint">엑셀의 행이 "{adding.table}" 표의 빈 행보다 많으면 누를 버튼이 있나요?</span>
            {['', ...adding.buttons].map((b) => (
              <button
                key={b}
                className="secondary"
                data-add={b}
                onClick={() => {
                  setSteps([...steps, { kind: 'fill', name: adding.table, columns: adding.columns, ...(b ? { add: b } : {}) }]);
                  setAdding(null);
                }}
              >
                {b ? '"' + b + '" 버튼' : '없음'}
              </button>
            ))}
          </div>
        )}

        {state === 'recording' && paging && (
          <div className="row wrap" id="rec-paging">
            <span className="hint">"{paging.table}" 표가 여러 페이지인가요?</span>
            <button
              className="secondary"
              data-next=""
              onClick={() => {
                setSteps([...steps, { kind: 'extract', name: paging.table }]);
                setPaging(null);
              }}
            >
              지금 보이는 페이지만
            </button>
            {paging.buttons.map((b) => (
              <button
                key={b}
                className="secondary"
                data-next={b}
                onClick={() => {
                  setSteps([...steps, { kind: 'extract', name: paging.table, next: b }]);
                  setPaging(null);
                }}
              >
                "{b}" 버튼으로 끝까지
              </button>
            ))}
          </div>
        )}

        {state === 'editing' && report && (
          <>
            <div id="lint" className={`lint grade-${report.grade}`} data-grade={report.grade}>
              <b>품질 검사: {GRADE_LABEL[report.grade]}</b>
              <span>
                {report.score}점 · 모델 없이 실행되는 단계 {report.direct.count}/{report.direct.total}
              </span>
            </div>
            {report.findings.length > 0 && (
              <ul className="findings">
                {report.findings.map((f, i) => (
                  <li key={i} className={f.level}>
                    <b>
                      {f.rule}
                      {f.step ? ` · ${f.step}단계` : ''}
                    </b>{' '}
                    {f.message}
                  </li>
                ))}
              </ul>
            )}
            {notes.map((n) => (
              <p key={n} className="hint">
                {n}
              </p>
            ))}
            <label>
              SKILL.md (직접 고칠 수 있습니다. 고치면 바로 다시 검사합니다)
              <textarea id="draft-src" className="code" rows={18} spellCheck={false} value={source} onChange={(e) => setSource(e.target.value)} />
            </label>
            {polished && (
              <div id="polish-result" className="polish" data-applied={polished.applied.length} data-rejected={polished.rejected.length}>
                <b>
                  {polished.applied.length > 0
                    ? `모델이 다듬은 곳 ${polished.applied.length}군데. 도구, 인자, 검사 식은 그대로입니다.`
                    : '모델의 제안 중 넣을 것이 없었습니다.'}
                </b>
                <ul>
                  {polished.applied.map((a) => (
                    <li key={a}>{a}</li>
                  ))}
                  {polished.rejected.map((a) => (
                    <li key={a} className="minor">
                      넣지 않음 — {a}
                    </li>
                  ))}
                  {polished.review.map((a) => (
                    <li key={a} className="minor">
                      모델의 의견 — {a}
                    </li>
                  ))}
                </ul>
                {polished.applied.length > 0 && (
                  <button
                    className="ghost"
                    id="polish-undo"
                    onClick={() => {
                      setSource(polished.before);
                      setPolished(null);
                    }}
                  >
                    다듬기 전으로 되돌리기
                  </button>
                )}
              </div>
            )}
            {report.skill && props.drafts.some((d) => d.id === report.skill!.id && d.source !== source) && (
              <p className="hint" id="overwrite-warning">
                같은 ID의 초안 "{report.skill.id}"이(가) 이미 있습니다. 저장하면 그 초안이 이 내용으로 바뀌고 시험 실행을 다시 해야 합니다.
              </p>
            )}
            <div className="row">
              <button className="secondary" onClick={() => setState('idle')}>
                버리기
              </button>
              <button
                className="secondary"
                id="polish"
                onClick={polish}
                disabled={polishing || !report.skill}
                title="스킬 설명, 입력 이름, 단계 설명, 예외 문구를 모델이 제안합니다. 동작은 바뀌지 않습니다"
              >
                {polishing ? '다듬는 중…' : '모델로 다듬기'}
              </button>
              <button id="draft-save" onClick={save} disabled={report.grade === 'F'}>
                초안으로 저장
              </button>
            </div>
          </>
        )}
      </section>

      <section className="card">
        <h2>내 초안</h2>
        {props.drafts.length === 0 && <p className="hint">저장한 초안이 없습니다.</p>}
        {state !== 'recording' && (
          <label className="hint">
            다른 사람이 만든 SKILL.md 파일을 가져와 검사하고 시험 실행할 수 있습니다.
            <input
              id="import-skill"
              type="file"
              accept=".md,text/markdown,text/plain"
              onChange={(e) => {
                void importFile(e.target.files?.[0]);
                e.target.value = '';
              }}
            />
          </label>
        )}
        {props.drafts.map((d) => {
          const r = lintSkill(d.source);
          const trialOk = d.trial?.status === 'done' || d.trial?.status === 'dryrun';
          const ready = r.deployable && trialOk;
          return (
            <div key={d.id} className="draft" data-id={d.id} data-trial={trialOk ? 'pass' : 'none'} data-ready={ready}>
              <div className="draft-head">
                <b>{r.skill?.name ?? d.id}</b>
                <span className="chip">{d.id}</span>
              </div>
              <ul className="gate">
                <li className={r.grade !== 'F' ? 'ok' : ''}>형식·통제 오류 없음</li>
                <li className={r.deployable ? 'ok' : ''}>품질 등급 B 이상 (지금 {r.grade})</li>
                <li className={trialOk ? 'ok' : ''}>지금 내용으로 시험 실행 통과</li>
              </ul>
              <p className="hint">
                {ready
                  ? '배포를 요청할 수 있습니다. SKILL.md를 내려받아 skills/' + d.id + '/ 에 넣고 검토를 올리세요.'
                  : '세 가지를 모두 채워야 배포를 요청할 수 있습니다. 그 전에는 이 PC에서만 쓸 수 있습니다.'}
              </p>
              <div className="row">
                <button
                  className="ghost"
                  onClick={async () => {
                    await deleteDraft(d.id);
                    props.onChange();
                  }}
                >
                  삭제
                </button>
                <button
                  className="secondary"
                  data-edit={d.id}
                  onClick={() => edit(d.source)}
                >
                  고치기
                </button>
                <button className="secondary" onClick={() => download('SKILL.md', d.source, 'text/markdown')}>
                  SKILL.md 내려받기
                </button>
              </div>
            </div>
          );
        })}
      </section>
    </>
  );
}
