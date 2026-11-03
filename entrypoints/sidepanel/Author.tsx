import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import { browser } from 'wxt/browser';
import {
  addRecorded,
  addRowButtons,
  composeStart,
  createFlowByWords,
  draftSkill,
  extractBlock,
  fillableColumns,
  firstHeading,
  insertBlock,
  insertBlocks,
  isStartBlock,
  lintSkill,
  literalObject,
  moveBlock,
  newHistory,
  pickAppeared,
  parseFlow,
  parseSkill,
  polishSkill,
  pushHistory,
  redoHistory,
  renderFlow,
  resolveInputs,
  reviseFlowByWords,
  setMeta,
  spliceFlow,
  summarizeBlocks,
  trialSource,
  undoHistory,
  type AuthorStep,
  type DraftMeta,
  type DraftStart,
  type Flow,
  type History,
  type LintReport,
  type LlmPort,
  type PageDialog,
  type PageSnapshot,
  type PolishResult,
  type RecordedEvent,
  type RunAsSkill,
  type RunResult,
  type Skill,
  type SkillInputs,
  renameParam,
  PARAM_NAME,
} from '@/src/core';
import { ChromeBrowser } from '@/src/ext/browser';
import { deleteDraft, saveDraft, type DraftSkill } from '@/src/ext/storage';
import { ChatBox, InputsPanel, InsertPoint, StepCard, type AddKind, type ChatEntry, type Edit, type TrialState } from './Flow';
import { PLACEHOLDER, describeRun, findingIndex, infoProblem, rememberOwner, rememberedOwner, suggestId, type TrialOptions } from './flow-ui';
import { download, targetTab } from './util';

const GRADE_LABEL: Record<LintReport['grade'], string> = {
  A: 'A · 배포 기준 충족',
  B: 'B · 배포 기준 충족',
  C: 'C · 보완 필요',
  F: 'F · 실행 불가',
};
/** 가져올 수 있는 SKILL.md의 최대 크기. 스킬은 보통 몇 KB다. */
const MAX_IMPORT_BYTES = 200_000;
/** 화면 정리를 처음 열 때의 지시 */
const DEFAULT_SUMMARY = '이 화면의 주요 내용을 다섯 줄 이내로 정리한다';
/** 녹화 중 새로 열린 화면에도 녹화를 거는 주기 */
const REARM_MS = 500;

function describeStep(s: AuthorStep): string {
  const text = describeAction(s);
  return s.note ? `${text} · 목적: ${s.note}` : text;
}

function describeAction(s: AuthorStep): string {
  if (s.kind === 'goal') return `말로 적은 단계: ${s.text}`;
  if (s.kind === 'summarize') {
    const what = s.source === 'page' ? '화면의 글' : `"${s.source.table}" 표${s.source.next ? ` ("${s.source.next}" 버튼으로 끝 페이지까지)` : ''}`;
    return `${what} 정리: ${s.instruction}`;
  }
  if (s.kind === 'click') {
    const shown = (s.dialogs ?? []).map((d) => (d.kind === 'alert' ? `알림 "${d.message}"` : `"${d.message}"에 ${d.accepted ? '확인' : '취소'}`));
    return `"${s.name || '(이름 없음)'}"${s.row ? ` (${s.row} 행)` : ''} 누름${s.expect ? ` → "${s.expect}" 나타남` : ''}${shown.length ? ` → ${shown.join(', ')}` : ''}`;
  }
  if (s.kind === 'fill') return '"' + s.name + '" 표에 엑셀 채우기 (' + s.columns.join(', ') + ')' + (s.add ? ', 모자라면 "' + s.add + '"' : '');
  if (s.kind === 'extract') return `"${s.name}" 표 읽기${s.next ? ` ("${s.next}" 버튼으로 끝 페이지까지)` : ''}`;
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

const tablesOf = (snap: PageSnapshot) => snap.items.flatMap((i) => (i.kind === 'el' && i.role === 'table' ? [i.name] : []));

/** 단계 카드 편집기에서 단계를 더하는 중인 폼 */
type Adder = { at: number; kind: Exclude<AddKind, 'record'>; tables?: string[]; next?: string[]; picked?: string; loading?: boolean; error?: string };

/**
 * 스킬 만들기. 말로 설명하거나, 업무를 한 번 해 보이면 초안이 만들어지고, 어느 쪽이든 같은 단계 카드 편집기에서 고친다.
 * 문서(SKILL.md)가 정본이고 카드는 그 문서의 "## 단계" 절을 보여 주는 뷰다 (src/core/flow.ts).
 * 품질 검사를 통과하면 초안으로 저장해 시험 실행한다. 누가 만들어도 같은 기준으로 검사된다.
 */
export function Author(props: {
  bundledIds: string[];
  drafts: DraftSkill[];
  onChange: () => void;
  llm: () => LlmPort;
  /** 카드의 "여기까지 실행". 저장하지 않고 시험 실행(dryRun)으로만 돌린다. */
  onTrial: (skill: Skill, values: SkillInputs, opts: TrialOptions) => Promise<RunResult>;
  /** 실행 탭에서 "이 실행을 스킬로 저장"을 누르면 그 실행에서 옮긴 단계가 온다. */
  seed?: RunAsSkill | null;
  onSeedTaken?: () => void;
}) {
  // review: 실행에서 옮긴 단계를 녹화 목록처럼 고치는 중 (화면 녹화는 하지 않음)
  const [state, setState] = useState<'idle' | 'recording' | 'review' | 'editing'>('idle');
  /** review의 시작 화면과 스킬 정보 */
  const reviewStart = useRef<DraftStart | null>(null);
  const reviewMeta = useRef<DraftMeta>(PLACEHOLDER_META());
  /** 고치기 시작할 때의 매개변수 이름. 다 고치면 말로 적은 단계의 자리표시자를 따라 바꾼다. */
  const nameAtFocus = useRef('');
  const [steps, setSteps] = useState<AuthorStep[]>([]);
  const [tables, setTables] = useState<string[] | null>(null);
  // 표 고르기가 읽기용인지 엑셀 채우기용인지
  const [tableUse, setTableUse] = useState<'extract' | 'fill'>('extract');
  // 채울 표를 고른 뒤, 행 추가 버튼으로 보이는 것들. 빈 행이 모자랄 때 누를 버튼을 묻는다.
  const [adding, setAdding] = useState<{ table: string; columns: string[]; buttons: string[] } | null>(null);
  // 녹화 중에 뜬 알림·확인 창. 창을 읽어 온 때에 그 창을 띄운 누름이 아직 목록에 없을 수 있으므로,
  // 조작과 따로 모아 두고 보여줄 때마다 뜬 시각으로 다시 맞춘다.
  const [seen, setSeen] = useState<PageDialog[]>([]);
  // 표를 고른 뒤, 다음 페이지 버튼으로 보이는 것들. 여러 페이지를 넘기며 읽을지 묻는다.
  const [paging, setPaging] = useState<{ table: string; buttons: string[] } | null>(null);
  // 목적을 적고 있는 조작의 번호
  const [noteOpen, setNoteOpen] = useState<number | null>(null);
  // 녹화 중에 끼워 넣는 단계: 말로 적은 단계, 화면 정리
  const [adder, setAdder] = useState<null | 'goal' | 'summarize'>(null);
  const [goalText, setGoalText] = useState('');
  const [sumText, setSumText] = useState(DEFAULT_SUMMARY);
  const [sumSource, setSumSource] = useState('page');
  const [sumTables, setSumTables] = useState<string[]>([]);
  const [sumNext, setSumNext] = useState<string | null>(null);
  const [sumAll, setSumAll] = useState(true);
  const [notes, setNotes] = useState<string[]>([]);
  const [notice, setNotice] = useState('');
  /** 카드 편집기에서 끼워 넣을 자리를 녹화하는 중이면 그 자리 (0부터) */
  const [splice, setSplice] = useState<{ at: number } | null>(null);
  const session = useRef<{ browser: ChromeBrowser; tabId: number; start: DraftStart; last: PageSnapshot; stop: () => void } | null>(null);

  // 카드 편집기
  const [hist, setHist] = useState<History<Flow> | null>(null);
  /** 문서 원문. 원문 편집 칸의 내용이고, 카드를 고치면 문서에서 다시 쓴다. */
  const [src, setSrc] = useState('');
  /** 문서를 단계로 열 수 없을 때의 이유 (원문만 고칠 수 있다) */
  const [broken, setBroken] = useState<string | null>(null);
  const [srcOpen, setSrcOpen] = useState(false);
  const [infoOpen, setInfoOpen] = useState(false);
  const [openKey, setOpenKey] = useState<string | null>(null);
  const [menuKey, setMenuKey] = useState<string | null>(null);
  const [insertAt, setInsertAt] = useState<number | null>(null);
  const [flash, setFlash] = useState<string | null>(null);
  const [dragFrom, setDragFrom] = useState<number | null>(null);
  const [dropOver, setDropOver] = useState<number | null>(null);
  const [live, setLive] = useState('');
  const [addForm, setAddForm] = useState<Adder | null>(null);
  const [addText, setAddText] = useState('');
  const [addSum, setAddSum] = useState(DEFAULT_SUMMARY);
  const [chat, setChat] = useState<ChatEntry[]>([]);
  const [chatDraft, setChatDraft] = useState('');
  const [chatBusy, setChatBusy] = useState(false);
  const chatInput = useRef<HTMLTextAreaElement>(null);
  const work = useRef<AbortController | null>(null);
  const [lastRun, setLastRun] = useState<string | null>(null);
  const [trial, setTrialState] = useState<TrialState | null>(null);
  const trialRef = useRef<TrialState | null>(null);
  const trialAbort = useRef<AbortController | null>(null);
  // 모델로 다듬은 결과와, 되돌릴 때 쓸 다듬기 전 원문
  const [polished, setPolished] = useState<(PolishResult & { before: string }) | null>(null);
  const [polishing, setPolishing] = useState(false);
  // 시작 화면
  const [request, setRequest] = useState('');
  const [creating, setCreating] = useState(false);

  const flow = hist?.present ?? null;
  const setTrial = (t: TrialState | null | ((cur: TrialState | null) => TrialState | null)) => {
    const next = typeof t === 'function' ? t(trialRef.current) : t;
    trialRef.current = next;
    setTrialState(next);
  };

  useEffect(
    () => () => {
      session.current?.stop();
      work.current?.abort();
      trialAbort.current?.abort();
    },
    [],
  );

  // 실행에서 옮긴 단계를 받으면 녹화를 마친 것처럼 목록을 보여 주고 고치게 한다.
  useEffect(() => {
    const seed = props.seed;
    if (!seed) return;
    session.current?.stop();
    session.current = null;
    reviewStart.current = seed.start;
    reviewMeta.current = { ...seed.meta, id: seed.meta.id || PLACEHOLDER.id, owner: seed.meta.owner || rememberedOwner() || PLACEHOLDER.owner };
    setSplice(null);
    setSteps(seed.steps);
    setSeen([]);
    setTables(null);
    setAdder(null);
    setNotes(seed.notes);
    setNotice('');
    setState('review');
    props.onSeedTaken?.();
  }, [props.seed]);

  const report = useMemo(() => {
    if (state !== 'editing') return null;
    const r = lintSkill(src);
    // 번들된 스킬과 같은 id를 쓰면 어느 쪽이 실행되는지 알 수 없다.
    if (r.skill && props.bundledIds.includes(r.skill.id)) {
      return { ...r, grade: 'F' as const, deployable: false, findings: [{ level: 'error' as const, rule: 'E07', message: `id "${r.skill.id}"는 이미 배포된 스킬이 쓰고 있습니다` }, ...r.findings] };
    }
    return r;
  }, [state, src, props.bundledIds]);

  // ---------------------------------------------------------------------------
  // 카드 편집기: 문서가 정본이고 Flow는 그 뷰다

  /** 새 문서를 카드 편집기로 연다. 열 수 없으면 원문만 고칠 수 있게 이유를 보인다. */
  function openSource(source: string, info: string[] = [], opts: { remember?: boolean } = { remember: true }) {
    let text = source;
    let parsed = parseFlow(text);
    // 새로 만든 초안의 담당 부서는 기억해 둔 것으로 채운다
    if (opts.remember && parsed.ok && (!parsed.meta.owner || parsed.meta.owner === PLACEHOLDER.owner) && rememberedOwner()) {
      parsed = setMeta(parsed, { owner: rememberedOwner() });
      text = renderFlow(parsed);
    }
    setSrc(text);
    setNotes(info);
    setPolished(null);
    setNotice('');
    setChat([]);
    setChatDraft('');
    setLastRun(null);
    setTrial(null);
    setOpenKey(null);
    setMenuKey(null);
    setInsertAt(null);
    setAddForm(null);
    setSplice(null);
    if (parsed.ok) {
      setHist(newHistory(parsed));
      setBroken(null);
      setSrcOpen(false);
    } else {
      setHist(null);
      setBroken(parsed.reason);
      setSrcOpen(true);
    }
    setInfoOpen(false);
    setState('editing');
  }

  /** 카드 편집 한 번. 되돌리기에 쌓고 문서를 다시 쓴다. */
  const edit: Edit = (fn, key) => {
    if (!hist) return;
    const next = fn(hist.present);
    if (next === hist.present) return;
    setHist(pushHistory(hist, next, { coalesceKey: key }));
    setSrc(renderFlow(next));
    setPolished(null);
    if (next.notices.length) setLive(next.notices.join(' '));
  };

  function commitFlow(next: Flow, key?: string) {
    edit(() => next, key);
  }

  function undo() {
    if (!hist || hist.past.length === 0) return;
    const h = undoHistory(hist);
    setHist(h);
    setSrc(renderFlow(h.present));
    setBroken(null);
    setLive('되돌렸습니다');
  }

  function redo() {
    if (!hist || hist.future.length === 0) return;
    const h = redoHistory(hist);
    setHist(h);
    setSrc(renderFlow(h.present));
    setBroken(null);
    setLive('다시 적용했습니다');
  }

  /** 원문을 직접 고친다. 읽을 수 있으면 카드가 다시 만들어지고, 아니면 이유를 보인다. */
  function editSource(text: string) {
    setSrc(text);
    setPolished(null);
    const parsed = parseFlow(text);
    if (parsed.ok) {
      setBroken(null);
      setHist((h) => (h ? pushHistory(h, parsed, { coalesceKey: 'raw' }) : newHistory(parsed)));
    } else setBroken(parsed.reason);
  }

  function scrollToCard(key: string) {
    setFlash(key);
    setOpenKey(key);
    requestAnimationFrame(() => document.querySelector(`[data-key="${key}"]`)?.scrollIntoView?.({ block: 'center', behavior: 'smooth' }));
    setTimeout(() => setFlash((k) => (k === key ? null : k)), 1800);
  }

  function onEditorKey(e: React.KeyboardEvent) {
    if (!(e.ctrlKey || e.metaKey) || e.key.toLowerCase() !== 'z') return;
    // 대화 입력창의 글자 되돌리기는 브라우저가 한다
    if ((e.target as HTMLElement).id === 'flow-chat-input') return;
    e.preventDefault();
    if (e.shiftKey) redo();
    else undo();
  }

  /** 지금 탭 화면을 읽는다. 읽을 수 없으면 null (말로 고치기는 화면 없이도 된다). */
  async function readScreen(): Promise<{ snap: PageSnapshot; browser: ChromeBrowser } | null> {
    try {
      const tab = await targetTab();
      const chrome = new ChromeBrowser(tab.id);
      return { snap: await chrome.snapshot(), browser: chrome };
    } catch {
      return null;
    }
  }

  // --- 시작 화면: 세 입구 -------------------------------------------------

  async function createByWords() {
    const text = request.trim();
    if (!text) return;
    setCreating(true);
    setNotice('');
    const abort = new AbortController();
    work.current = abort;
    try {
      const tab = await targetTab();
      const chrome = new ChromeBrowser(tab.id);
      const snap = await chrome.snapshot();
      if (snap.hasPassword) throw new Error('로그인 화면에서는 만들지 않습니다. 로그인한 뒤 업무 화면에서 시작해 주세요');
      if (!/^https?:/.test(snap.url) || snap.items.length <= 1) throw new Error('이 탭은 Dogent가 읽을 수 없는 화면입니다. 업무 화면이 열린 탭에서 시작해 주세요');
      const owner = rememberedOwner();
      const { flow: made, draft } = await createFlowByWords(text, props.llm(), {
        start: composeStart(snap.url, snap.title, snap, owner || undefined),
        snap,
        takenIds: new Set([...props.bundledIds, ...props.drafts.map((d) => d.id)]),
        signal: abort.signal,
      });
      openSource(renderFlow(made), draft.notes);
      setChat([{ id: Date.now(), role: 'bot', text: '말씀하신 업무로 초안을 만들었습니다. 카드를 눌러 고치거나, 아래에 말로 바꿔 달라고 하세요.' }]);
    } catch (e) {
      setNotice(abort.signal.aborted ? '만들기를 취소했습니다' : `초안을 만들지 못했습니다: ${(e as Error).message}`);
    } finally {
      setCreating(false);
      work.current = null;
    }
  }

  async function createBlank() {
    try {
      const tab = await targetTab();
      const snap = await new ChromeBrowser(tab.id).snapshot();
      if (!/^https?:/.test(snap.url)) throw new Error('이 탭은 Dogent가 읽을 수 없는 화면입니다. 업무 화면이 열린 탭에서 시작해 주세요');
      const draft = draftSkill(newMeta(), { url: snap.url, heading: firstHeading(snap) }, []);
      openSource(draft.source, ['시작 화면과 보고 단계만 있는 빈 흐름입니다. 카드 사이의 ＋로 단계를 넣으세요.']);
    } catch (e) {
      setNotice((e as Error).message);
    }
  }

  // --- 녹화 ------------------------------------------------------------------

  async function startRecording(at?: number) {
    try {
      const tab = await targetTab();
      const chrome = new ChromeBrowser(tab.id);
      const first = await chrome.snapshot();
      if (first.hasPassword) throw new Error('로그인 화면에서는 녹화하지 않습니다. 로그인한 뒤 업무 화면에서 시작해 주세요');
      if (!/^https?:/.test(first.url) || first.items.length <= 1) throw new Error('이 탭은 Dogent가 읽을 수 없는 화면입니다. 업무 화면이 열린 탭에서 시작해 주세요');
      // 끼워 넣는 녹화는 이 스킬의 사이트에서만 한다 (사이트는 편집기에서 바꾸지 않는다)
      if (at !== undefined && flow && flow.meta.domains.length > 0 && !flow.meta.domains.includes(new URL(first.url).host)) {
        throw new Error(`이 탭(${new URL(first.url).host})은 스킬의 사이트(${flow.meta.domains.join(', ')})가 아닙니다. 그 사이트의 탭에서 녹화해 주세요`);
      }

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
      setSplice(at === undefined ? null : { at });
      setSteps([]);
      setSeen([]);
      setTables(null);
      setAdder(null);
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
    setTables(tablesOf(snap));
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

  /** 녹화한 조작 하나를 고친다 (입력받기, 이름, 설명, 목적). */
  function update(i: number, patch: Partial<AuthorStep> & Record<string, unknown>) {
    let next = steps.map((x, j) => (j === i ? ({ ...x, ...patch } as AuthorStep) : x));
    const was = steps[i];
    if (patch.variable === false && (was.kind === 'type' || was.kind === 'select') && was.param?.name) {
      next = renameParam(next, was.param.name, { value: was.value });
    }
    setSteps(next);
  }

  /** 매개변수 이름을 다 고쳤으면 말로 적은 단계·정리 기준의 {이름}을 따라 바꾼다. */
  function renamed(to: string) {
    const from = nameAtFocus.current;
    if (from && from !== to && PARAM_NAME.test(from)) setSteps((prev) => renameParam(prev, from, to));
  }

  /** 실행에서 옮긴 단계로 초안을 만들어 카드 편집기로 연다. */
  function draftFromReview() {
    if (!reviewStart.current) return;
    const draft = draftSkill(reviewMeta.current, reviewStart.current, steps);
    openSource(draft.source, draft.notes);
  }

  function addGoal() {
    if (!goalText.trim()) return;
    const goal: AuthorStep = { kind: 'goal', text: goalText.trim() };
    const closing = state === 'review' && steps.at(-1)?.kind === 'goal';
    setSteps(closing ? [...steps.slice(0, -1), goal, steps.at(-1)!] : [...steps, goal]);
    setGoalText('');
    setAdder(null);
  }

  /** 화면 정리: 지금 화면의 표를 골라 정리하거나, 화면의 글을 정리한다. */
  async function openSummarize() {
    const s = session.current;
    if (!s) return;
    const snap = await s.browser.snapshot();
    s.last = snap;
    setSumTables(tablesOf(snap));
    setSumNext(nextButtons(snap)[0] ?? null);
    setSumSource('page');
    setTables(null);
    setAdder('summarize');
  }

  function addSummarize() {
    if (!sumText.trim()) return;
    const source = sumSource === 'page' ? ('page' as const) : { table: sumSource, ...(sumNext && sumAll ? { next: sumNext } : {}) };
    setSteps([...steps, { kind: 'summarize', instruction: sumText.trim(), source }]);
    setSumText(DEFAULT_SUMMARY);
    setAdder(null);
  }

  /** 녹화를 끝낸다. 새 녹화면 카드 편집기로, 끼워 넣는 녹화면 그 자리에 조각을 끼워 넣는다. */
  async function stopRecording() {
    const s = session.current;
    if (!s) return;
    const late = await s.browser.recordedDialogs().catch(() => []);
    const recorded = withDialogs(steps, [...seen, ...late]);
    s.stop();
    session.current = null;
    const draft = draftSkill(newMeta(), s.start, recorded);
    if (splice && hist) {
      const fragment = parseFlow(draft.source);
      if (fragment.ok) {
        const next = spliceFlow(hist.present, fragment, splice.at);
        setHist(pushHistory(hist, next));
        setSrc(renderFlow(next));
        setSplice(null);
        setState('editing');
        setNotes([...next.notices, ...draft.notes]);
        setLive(`${splice.at + 1}번 자리에 녹화한 단계를 끼워 넣었습니다`);
        return;
      }
      setSplice(null);
    }
    openSource(draft.source, draft.notes);
  }

  function cancelRecording() {
    session.current?.stop();
    session.current = null;
    setSplice(null);
    setState(hist || broken ? 'editing' : 'idle');
  }

  // --- 말로 고치기 ---------------------------------------------------------

  async function sendChat() {
    const text = chatDraft.trim();
    if (!text || !flow || chatBusy) return;
    setChat((c) => [...c, { id: Date.now(), role: 'user', text }]);
    setChatDraft('');
    setChatBusy(true);
    const abort = new AbortController();
    work.current = abort;
    try {
      const screen = await readScreen();
      const startUrl = String(literalObject(flow.blocks[0])?.url ?? '');
      const r = await reviseFlowByWords(flow, text, props.llm(), { url: screen?.snap.url ?? startUrl, title: screen?.snap.title ?? '', snap: screen?.snap }, { lastRun: lastRun ?? undefined, signal: abort.signal });
      commitFlow(r.flow);
      const none = r.changes.length === 0 && r.skipped.length === 0;
      setChat((c) => [
        ...c,
        {
          id: Date.now() + 1,
          role: 'bot',
          text: none ? '바꿀 것이 없다고 판단했습니다. 어느 단계를 어떻게 바꿀지 조금 더 구체적으로 말해 주세요.' : r.changes.length ? `${r.changes.length}가지를 바꿨습니다. 되돌리려면 위의 되돌리기(Ctrl+Z)를 누르세요.` : '바꾼 것이 없습니다.',
          changes: r.changes,
          skipped: r.skipped,
        },
      ]);
      setLive(r.changes.length ? `${r.changes.length}가지를 바꿨습니다` : '바꾼 것이 없습니다');
    } catch (e) {
      setChat((c) => [...c, { id: Date.now() + 1, role: 'error', text: abort.signal.aborted ? '취소했습니다.' : `고치지 못했습니다: ${(e as Error).message}` }]);
    } finally {
      setChatBusy(false);
      work.current = null;
    }
  }

  function fixByWords(i: number) {
    setMenuKey(null);
    setChatDraft((d) => (d.trim() ? d : `${i + 1}번 단계: `));
    requestAnimationFrame(() => {
      chatInput.current?.focus();
      chatInput.current?.scrollIntoView?.({ block: 'nearest' });
    });
  }

  // --- 단계 더하기 -----------------------------------------------------------

  async function onAdd(at: number, kind: AddKind) {
    setMenuKey(null);
    setInsertAt(null);
    if (kind === 'record') {
      await startRecording(at);
      return;
    }
    setAddForm({ at, kind, loading: kind !== 'words' });
    setAddText('');
    if (kind === 'words') return;
    const screen = await readScreen();
    if (!screen) {
      setAddForm({ at, kind, error: '지금 탭의 화면을 읽지 못했습니다. 업무 화면이 열린 탭에서 다시 해 주세요' });
      return;
    }
    setAddForm({ at, kind, tables: tablesOf(screen.snap), next: nextButtons(screen.snap) });
  }

  function submitAdder(pick?: { table?: string; next?: string }) {
    if (!addForm || !flow) return;
    const { at, kind } = addForm;
    if (kind === 'words') {
      if (!addText.trim()) return;
      edit((f) => insertBlock(f, at, { head: addText.trim() }));
    } else if (kind === 'summarize') {
      const table = pick?.table ?? addForm.picked;
      if (!addSum.trim()) return;
      edit((f) => insertBlocks(f, at, summarizeBlocks(f, addSum, table ? { table, ...(pick?.next ? { next: pick.next } : {}) } : 'page')));
    } else if (kind === 'table' && pick?.table) {
      const table = pick.table;
      edit((f) => insertBlocks(f, at, [extractBlock(f, table, pick.next)]));
    }
    setAddForm(null);
  }

  // --- 여기까지 시험 -----------------------------------------------------------

  function startTrial(i: number) {
    if (!flow) return;
    setMenuKey(null);
    const key = flow.blocks[i].key;
    try {
      const parsed = parseSkill(trialSource(flow, i));
      // 이 시험에 들어간 단계가 쓰는 입력만 받는다
      const text = renderFlow({ ...flow, blocks: flow.blocks.slice(0, i + 1) });
      const used = parsed.inputs.filter((s) => text.includes(`{${s.name}}`) || (s.dataset && text.includes(`"${s.dataset}"`)));
      const skill: Skill = { ...parsed, inputs: used };
      const values = Object.fromEntries(used.map((s) => [s.name, s.default !== undefined ? String(s.default) : '']));
      const t: TrialState = { key, upTo: i, phase: 'form', skill, values, files: {} };
      setTrial(t);
      setOpenKey(key);
      if (used.length === 0) void runTrial(t);
    } catch (e) {
      setTrial({ key, upTo: i, phase: 'form', values: {}, files: {}, error: `시험할 수 없습니다: ${(e as Error).message}` });
    }
  }

  async function runTrial(from?: TrialState) {
    const t = from ?? trialRef.current;
    if (!t?.skill) return;
    const { values, errors } = resolveInputs(t.skill, t.values);
    if (errors.length) return setTrial({ ...t, error: errors.join(' / ') });
    const abort = new AbortController();
    trialAbort.current = abort;
    setTrial({ ...t, phase: 'running', error: undefined, result: undefined, question: undefined });
    let res: RunResult;
    try {
      res = await props.onTrial(t.skill, values, {
        signal: abort.signal,
        files: t.files,
        ask: (text) =>
          new Promise<string>((resolve) => {
            setTrial((cur) => cur && { ...cur, question: { text, answer: (a) => (resolve(a), setTrial((c) => c && { ...c, question: undefined })) } });
          }),
      });
    } catch (e) {
      res = { status: 'error', message: (e as Error).message, lastStep: 0, actions: 0, files: [], datasets: [], outputs: {}, elapsedMs: 0 };
    }
    trialAbort.current = null;
    setLastRun(describeRun(t.upTo, res));
    setTrial((cur) => (cur && cur.key === t.key ? { ...cur, phase: 'done', result: res, question: undefined } : cur));
    setLive(res.status === 'done' || res.status === 'dryrun' ? '시험 실행이 끝났습니다' : '시험 실행이 실패했습니다');
  }

  function trialToChat() {
    const t = trialRef.current;
    if (!t) return;
    setChatDraft(`${t.upTo + 1}번 단계까지 시험해 보니 안 됩니다. 고쳐 주세요.`);
    requestAnimationFrame(() => chatInput.current?.focus());
  }

  // --- 저장·다듬기·가져오기 -------------------------------------------------------

  /** 글만 모델에 맡긴다. 도구·인자·검사가 달라지는 제안은 core가 버린다. */
  async function polish() {
    setPolishing(true);
    setNotice('');
    try {
      const before = src;
      const r = await polishSkill(src, props.llm());
      editSource(r.source);
      setPolished({ ...r, before });
    } catch (e) {
      setNotice(`다듬지 못했습니다: ${(e as Error).message}`);
    } finally {
      setPolishing(false);
    }
  }

  /** 받은 SKILL.md 파일을 편집 화면으로 연다. 저장하기 전까지는 아무것도 바뀌지 않는다. */
  async function importFile(file: File | undefined) {
    if (!file) return;
    if (file.size > MAX_IMPORT_BYTES) return setNotice('파일이 너무 큽니다. SKILL.md 파일인지 확인해 주세요');
    openSource(await file.text(), ['"' + file.name + '" 파일에서 가져왔습니다. 품질 검사 결과를 확인하고, 저장한 뒤 이 PC에서 시험 실행해 보세요.'], { remember: false });
  }

  async function save() {
    if (!report?.skill || report.grade === 'F') return;
    const problem = flow ? infoProblem(flow.meta) : null;
    if (problem) {
      setInfoOpen(true);
      setNotice(problem);
      return;
    }
    await saveDraft(report.skill.id, src);
    rememberOwner(report.skill.owner);
    props.onChange();
    setNotice(`초안 "${report.skill.name}"을(를) 저장했습니다. 실행 탭의 스킬 목록에서 골라 시험 실행하세요.`);
    setHist(null);
    setState('idle');
  }

  function discard() {
    work.current?.abort();
    trialAbort.current?.abort();
    setHist(null);
    setBroken(null);
    setState('idle');
  }

  // ---------------------------------------------------------------------------
  // 화면

  const metaPatch = (patch: Parameters<typeof setMeta>[1], key: string) => edit((f) => setMeta(f, patch), key);
  const risk = flow?.meta.risk ?? report?.skill?.risk ?? '';
  const recording = state === 'recording';

  return (
    <>
      <section className="card">
        <h2>스킬 만들기</h2>
        {state === 'idle' && <p className="hint">말로 설명하거나 직접 해 보이면 단계 카드로 된 초안이 만들어집니다. 카드를 고치고, 말로 바꿔 달라고 하고, 여기까지 시험해 본 뒤 초안으로 저장하세요.</p>}
        {notice && (
          <p className="notice" role="status" id="author-notice">
            {notice}
          </p>
        )}

        {state === 'idle' && (
          <div className="idle" id="idle">
            <label>
              <span className="sr-only">무엇을 자동화할까요?</span>
              <textarea
                id="idle-request"
                rows={4}
                value={request}
                disabled={creating}
                placeholder="무엇을 자동화할까요? 말로 설명하거나, 직접 해 보이세요"
                onChange={(e) => setRequest(e.target.value)}
              />
            </label>
            <div className="entry-grid">
              <button id="create-words" disabled={creating || !request.trim()} onClick={() => void createByWords()} title="지금 탭의 화면을 읽고 모델이 초안을 씁니다">
                {creating ? '만드는 중…' : '말로 만들기'}
              </button>
              <button id="rec-start" className="secondary" disabled={creating} onClick={() => void startRecording()} title="업무를 한 번 해 보이면 그대로 단계가 됩니다">
                해 보이기 (녹화)
              </button>
              <button id="create-blank" className="secondary" disabled={creating} onClick={() => void createBlank()} title="시작 화면과 보고 단계만 있는 흐름에서 직접 채웁니다">
                빈 흐름으로 시작
              </button>
            </div>
            {creating && (
              <div className="row">
                <span className="hint">지금 탭의 화면을 읽고 초안을 쓰는 중입니다…</span>
                <button className="ghost" onClick={() => work.current?.abort()}>
                  취소
                </button>
              </div>
            )}
            <p className="hint">업무의 첫 화면을 연 상태에서 시작하세요. 비밀번호 칸은 녹화하지 않습니다. 스킬 이름·ID·담당 부서는 저장할 때 정합니다. 실행 탭에서 말로 시켜 잘 된 일은 결과 아래 "이 실행을 스킬로 저장"으로도 만들 수 있습니다.</p>
          </div>
        )}

        {(state === 'idle' || state === 'editing') && (
          <label className="hint import-skill">
            SKILL.md 가져오기 — 다른 사람이 만든 파일을 열어 검사하고 시험 실행할 수 있습니다.
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

        {state === 'review' && (
          <>
            <p className="notice ok" id="review-intro">
              방금 실행한 동작을 단계로 옮겼습니다. 실행할 때마다 받을 값의 이름·설명을 확인한 뒤 초안을 만드세요. 스킬 이름·담당 부서는 저장할 때 정합니다.
            </p>
          </>
        )}

        {(recording || state === 'review') && (
          <div id="rec" data-count={steps.length} data-state={state}>
            {recording && !splice && <p className="notice rec">녹화 중 — 업무 화면에서 평소대로 한 번 해 보이세요.</p>}
            {recording && splice && (
              <p className="notice rec" id="splice-banner">
                녹화 중 — {splice.at + 1}번 자리에 끼워 넣을 조작을 해 보이세요. 앞 단계까지의 화면이 이 탭에 열려 있어야 합니다.
              </p>
            )}
            {state === 'review' && notes.length > 0 && (
              <ul className="hint" id="review-notes">
                {notes.map((n) => (
                  <li key={n}>{n}</li>
                ))}
              </ul>
            )}
            <ol className="rec-list">
              <li className="minor">
                시작 화면: {(session.current?.start ?? reviewStart.current)?.heading ?? (session.current?.start ?? reviewStart.current)?.url}
              </li>
              {steps.map((s, i) => (
                <li key={i} data-step={i}>
                  <span>{describeStep(withDialogs(steps, seen)[i])}</span>
                  {(s.kind === 'type' || s.kind === 'select') && (
                    <label className="check">
                      <input type="checkbox" data-variable={i} checked={s.variable} onChange={(e) => update(i, { variable: e.target.checked })} />
                      실행할 때마다 입력받기
                    </label>
                  )}
                  {(s.kind === 'type' || s.kind === 'select') && s.variable && (
                    <div className="param">
                      <input
                        data-param-name={i}
                        value={s.param?.name ?? ''}
                        placeholder="이름 (영문, 예: keyword)"
                        onFocus={(e) => (nameAtFocus.current = e.target.value)}
                        onBlur={(e) => renamed(e.target.value.trim())}
                        onChange={(e) => update(i, { param: { ...s.param, name: e.target.value.trim() } })}
                      />
                      <input
                        data-param-desc={i}
                        value={s.param?.description ?? ''}
                        placeholder="설명 (예: 검색창에 넣을 값)"
                        onChange={(e) => update(i, { param: { ...s.param, description: e.target.value } })}
                      />
                    </div>
                  )}
                  {noteOpen === i && (
                    <input
                      className="note-input"
                      data-note={i}
                      autoFocus
                      value={s.note ?? ''}
                      placeholder="이 조작의 목적 (예: 검색 결과를 띄운다)"
                      onChange={(e) => update(i, { note: e.target.value })}
                      onKeyDown={(e) => e.key === 'Enter' && setNoteOpen(null)}
                      onBlur={() => setNoteOpen(null)}
                    />
                  )}
                  <span className="rec-actions">
                    {s.kind !== 'goal' && (
                      <button className="ghost" data-note-open={i} title="이 조작이 무엇을 하려는 것인지 적습니다" onClick={() => setNoteOpen(noteOpen === i ? null : i)}>
                        목적
                      </button>
                    )}
                    <button className="ghost" title="이 조작을 뺀다" onClick={() => setSteps(steps.filter((_, j) => j !== i))}>
                      빼기
                    </button>
                  </span>
                </li>
              ))}
            </ol>
            <div className="row wrap">
              {recording && (
                <>
                  <button id="rec-table" className="secondary" onClick={() => (setAdder(null), findTables('extract'))}>
                    화면의 표 읽기 추가
                  </button>
                  <button id="rec-fill" className="secondary" title="실행할 때 받은 엑셀 파일의 행을 화면의 표에 채웁니다" onClick={() => (setAdder(null), findTables('fill'))}>
                    엑셀로 표 채우기 추가
                  </button>
                </>
              )}
              <button id="rec-goal" className="secondary" title="클릭 대신 할 일을 문장으로 넣습니다. 실행할 때 모델이 화면을 보고 수행합니다" onClick={() => (setTables(null), setAdder(adder === 'goal' ? null : 'goal'))}>
                말로 단계 추가
              </button>
              {recording ? (
                <>
                  <button id="rec-sum" className="secondary" title="지금 화면의 글이나 표를 정리해 결과 보고에 넣습니다" onClick={() => void openSummarize()}>
                    화면 정리 추가
                  </button>
                  <button className="ghost" id="rec-cancel" onClick={cancelRecording}>
                    녹화 취소
                  </button>
                  <button id="rec-stop" onClick={stopRecording}>
                    녹화 끝
                  </button>
                </>
              ) : (
                <>
                  <button className="ghost" onClick={() => setState('idle')}>
                    취소
                  </button>
                  <button id="review-draft" onClick={draftFromReview}>
                    초안 만들기
                  </button>
                </>
              )}
            </div>
            {adder === 'goal' && (
              <div className="adder" id="goal-form">
                <textarea
                  id="goal-text"
                  rows={2}
                  value={goalText}
                  placeholder="예: 결과 중 상태가 HOLD인 Lot을 열어 사유를 확인한다. 마지막에 넣으면 그 단계가 결과를 정리해 보고합니다"
                  onChange={(e) => setGoalText(e.target.value)}
                />
                <div className="row">
                  <button id="goal-add" disabled={!goalText.trim()} onClick={addGoal}>
                    단계로 넣기
                  </button>
                  <button className="ghost" onClick={() => setAdder(null)}>
                    취소
                  </button>
                </div>
              </div>
            )}
            {adder === 'summarize' && (
              <div className="adder" id="sum-form">
                <label>
                  무엇을 정리할까요?
                  <select id="sum-source" value={sumSource} onChange={(e) => setSumSource(e.target.value)}>
                    <option value="page">화면의 글</option>
                    {sumTables.map((t) => (
                      <option key={t} value={t}>
                        "{t}" 표
                      </option>
                    ))}
                  </select>
                </label>
                {sumSource !== 'page' && sumNext && (
                  <label className="check">
                    <input id="sum-all" type="checkbox" checked={sumAll} onChange={(e) => setSumAll(e.target.checked)} />"{sumNext}" 버튼으로 끝 페이지까지 읽어서 정리
                  </label>
                )}
                <label>
                  정리 기준
                  <textarea id="sum-text" rows={2} value={sumText} onChange={(e) => setSumText(e.target.value)} />
                </label>
                <p className="hint">정리할 자료(화면 글 12,000자, 표 앞 200행까지)를 사내 모델에 보냅니다. 정리 기준에 {'{'}입력 이름{'}'}을 쓰면 실행할 때 값이 들어갑니다.</p>
                <div className="row">
                  <button id="sum-add" disabled={!sumText.trim()} onClick={addSummarize}>
                    정리 단계로 넣기
                  </button>
                  <button className="ghost" onClick={() => setAdder(null)}>
                    취소
                  </button>
                </div>
              </div>
            )}
            {tables &&
              (tables.length === 0 ? (
                <p className="hint">이 화면에서 읽을 수 있는 표를 찾지 못했습니다.</p>
              ) : (
                <div className="row wrap">
                  {tables.map((name) => (
                    <button key={name} className="secondary" data-table={name} onClick={() => pickTable(name)}>
                      "{name}" 표
                    </button>
                  ))}
                </div>
              ))}
          </div>
        )}

        {recording && adding && (
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

        {recording && paging && (
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
          <div className="flow-editor" id="flow-editor" onKeyDown={onEditorKey}>
            <div className="sr-only" aria-live="polite" id="flow-live">
              {live}
            </div>
            <div className="flow-top">
              <div id="lint" className={`lint grade-${report.grade}`} data-grade={report.grade}>
                <b>품질 검사: {GRADE_LABEL[report.grade]}</b>
                <span>
                  {report.score}점 · 모델 없이 실행되는 단계 {report.direct.count}/{report.direct.total}
                </span>
              </div>
              {risk && (
                <span className={`chip risk-${risk}`} id="risk-chip" data-risk={risk} title="위험 등급 (R3은 저장·상신 버튼이 있어 실행할 때 승인을 받습니다)">
                  {risk}
                </span>
              )}
              <span className="undo-bar">
                <button className="icon-btn" id="flow-undo" aria-label="되돌리기 (Ctrl+Z)" title="되돌리기 (Ctrl+Z)" disabled={!hist || hist.past.length === 0} onClick={undo}>
                  ↶
                </button>
                <button className="icon-btn" id="flow-redo" aria-label="다시 하기 (Ctrl+Shift+Z)" title="다시 하기 (Ctrl+Shift+Z)" disabled={!hist || hist.future.length === 0} onClick={redo}>
                  ↷
                </button>
              </span>
            </div>
            {report.findings.length > 0 && (
              <details className="panel" id="lint-details">
                <summary>
                  품질 검사 상세 ({report.findings.filter((f) => f.level !== 'info').length}건{report.findings.some((f) => f.level === 'info') ? ` · 안내 ${report.findings.filter((f) => f.level === 'info').length}` : ''})
                </summary>
                <ul className="findings">
                  {report.findings.map((f, i) => {
                    const at = flow ? findingIndex(f, flow) : undefined;
                    return (
                      <li key={i} className={f.level}>
                        <b>
                          {f.rule}
                          {f.step ? ` · ${f.step}단계` : ''}
                        </b>{' '}
                        {f.message}
                        {at !== undefined && flow && (
                          <>
                            {' '}
                            <button className="ghost" data-goto={at} onClick={() => scrollToCard(flow.blocks[at].key)}>
                              그 단계 보기
                            </button>
                          </>
                        )}
                      </li>
                    );
                  })}
                </ul>
              </details>
            )}
            {flow && flow.warnings.length > 0 && (
              <ul className="findings" id="flow-warnings">
                {flow.warnings.map((w) => (
                  <li key={w.message} className="warn">
                    {w.message}
                    {w.key && (
                      <>
                        {' '}
                        <button className="ghost" onClick={() => scrollToCard(w.key!)}>
                          그 단계 보기
                        </button>
                      </>
                    )}
                  </li>
                ))}
              </ul>
            )}
            {notes.map((n) => (
              <p key={n} className="hint">
                {n}
              </p>
            ))}

            {broken && (
              <p className="notice error" id="flow-broken" role="alert">
                이 문서는 단계 카드로 열 수 없습니다: {broken}. 아래 "원문(SKILL.md)"에서 고치면 카드가 다시 만들어집니다.
              </p>
            )}

            {flow && !broken && (
              <ol className="step-list" id="step-list" aria-label="단계 목록">
                {flow.blocks.map((b, i) => (
                  <Fragment key={b.key}>
                    {(i > 0 || !isStartBlock(b)) && (
                      <InsertPoint at={i} open={insertAt === i} onToggle={() => setInsertAt(insertAt === i ? null : i)} onAdd={(k) => void onAdd(i, k)} />
                    )}
                    {addForm?.at === i && <AdderForm {...adderProps(i)} />}
                    <StepCard
                      i={i}
                      flow={flow}
                      open={openKey === b.key}
                      menuOpen={menuKey === b.key}
                      highlighted={flash === b.key}
                      trial={trial}
                      busy={chatBusy}
                      dropOver={dropOver === i && dragFrom !== null && dragFrom !== i}
                      onToggle={() => setOpenKey(openKey === b.key ? null : b.key)}
                      onMenu={() => setMenuKey(menuKey === b.key ? null : b.key)}
                      onEdit={edit}
                      onAdd={(at, k) => void onAdd(at, k)}
                      onFixByWords={fixByWords}
                      onTrial={startTrial}
                      onTrialChange={setTrial}
                      onTrialRun={() => void runTrial()}
                      onTrialStop={() => trialAbort.current?.abort()}
                      onTrialFix={trialToChat}
                      onDragStart={setDragFrom}
                      onDragOver={setDropOver}
                      onDrop={(to) => {
                        if (dragFrom !== null && dragFrom !== to) edit((f) => moveBlock(f, dragFrom, to));
                        setDragFrom(null);
                        setDropOver(null);
                      }}
                      onDragEnd={() => (setDragFrom(null), setDropOver(null))}
                    />
                  </Fragment>
                ))}
                {addForm?.at === flow.blocks.length && <AdderForm {...adderProps(flow.blocks.length)} />}
                <InsertPoint at={flow.blocks.length} open={insertAt === flow.blocks.length} onToggle={() => setInsertAt(insertAt === flow.blocks.length ? null : flow.blocks.length)} onAdd={(k) => void onAdd(flow.blocks.length, k)} />
              </ol>
            )}

            {flow && !broken && <InputsPanel flow={flow} onEdit={edit} onScroll={scrollToCard} />}

            <details
              className="panel"
              id="info-panel"
              open={infoOpen}
              onToggle={(e) => setInfoOpen((e.target as HTMLDetailsElement).open)}
            >
              <summary>
                스킬 정보 {flow && infoProblem(flow.meta) ? <span className="badge-warn">· 저장하기 전에 채워 주세요</span> : flow ? `· ${flow.meta.name}` : ''}
              </summary>
              {flow && !broken ? (
                <div className="info-fields">
                  <label>
                    이름
                    <input
                      id="a-name"
                      value={flow.meta.name === PLACEHOLDER.name ? '' : flow.meta.name}
                      placeholder="예: 재공 확인"
                      onChange={(e) => {
                        const name = e.target.value;
                        const auto = !flow.meta.id || flow.meta.id === PLACEHOLDER.id || flow.meta.id === suggestId(flow.meta.name);
                        const id = suggestId(name);
                        metaPatch({ name: name || PLACEHOLDER.name, ...(auto && id ? { id } : {}) }, 'meta:name');
                      }}
                    />
                  </label>
                  <label>
                    스킬 ID
                    <input id="a-id" value={flow.meta.id === PLACEHOLDER.id ? '' : flow.meta.id} placeholder="예: wip-check (영문 소문자·숫자·하이픈)" onChange={(e) => metaPatch({ id: e.target.value.trim() || PLACEHOLDER.id }, 'meta:id')} />
                  </label>
                  <label>
                    설명
                    <input
                      id="a-desc"
                      value={flow.meta.description === PLACEHOLDER.description ? '' : flow.meta.description}
                      placeholder="무엇을 조회하거나 입력하는 업무인지 한 문장"
                      onChange={(e) => metaPatch({ description: e.target.value || PLACEHOLDER.description }, 'meta:desc')}
                    />
                  </label>
                  <label>
                    담당 부서
                    <input id="a-owner" value={flow.meta.owner === PLACEHOLDER.owner ? '' : flow.meta.owner} placeholder="화면이 바뀌면 고칠 책임이 있는 부서" onChange={(e) => metaPatch({ owner: e.target.value || PLACEHOLDER.owner }, 'meta:owner')} />
                  </label>
                  <label>
                    위험 등급
                    <select id="a-risk" value={flow.meta.risk} onChange={(e) => metaPatch({ risk: e.target.value }, 'meta:risk')}>
                      <option value="R1">R1 · 읽기만</option>
                      <option value="R2">R2 · 값 입력 (저장 안 함)</option>
                      <option value="R3">R3 · 저장·상신 (승인 필요)</option>
                    </select>
                  </label>
                  <p className="hint">사이트: {flow.meta.domains.join(', ') || '(없음)'} — 편집기에서는 바꾸지 않습니다. 위험 등급은 자동으로 바뀌지 않습니다.</p>
                </div>
              ) : (
                <p className="hint">문서를 단계로 열 수 있게 되면 여기서 고칩니다.</p>
              )}
            </details>

            <details className="panel" id="src-panel" open={srcOpen} onToggle={(e) => setSrcOpen((e.target as HTMLDetailsElement).open)}>
              <summary>원문(SKILL.md) 보기·직접 고치기</summary>
              <label>
                SKILL.md (직접 고칠 수 있습니다. 고치면 바로 다시 검사하고 카드가 다시 만들어집니다)
                <textarea id="draft-src" className="code" rows={18} spellCheck={false} value={src} onChange={(e) => editSource(e.target.value)} />
              </label>
            </details>

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
                      editSource(polished.before);
                      setPolished(null);
                    }}
                  >
                    다듬기 전으로 되돌리기
                  </button>
                )}
              </div>
            )}
            {report.skill && props.drafts.some((d) => d.id === report.skill!.id && d.source !== src) && (
              <p className="hint" id="overwrite-warning">
                같은 ID의 초안 "{report.skill.id}"이(가) 이미 있습니다. 저장하면 그 초안이 이 내용으로 바뀌고 시험 실행을 다시 해야 합니다.
              </p>
            )}
            <div className="row">
              <button className="secondary" id="flow-discard" onClick={discard}>
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

            {flow && !broken && (
              <ChatBox
                entries={chat}
                busy={chatBusy}
                draft={chatDraft}
                onDraft={setChatDraft}
                onSend={() => void sendChat()}
                onCancel={() => work.current?.abort()}
                hasRun={!!lastRun}
                inputRef={chatInput}
              />
            )}
          </div>
        )}
      </section>

      {state === 'idle' && (
        <section className="card">
          <h2>내 초안</h2>
          {props.drafts.length === 0 && <p className="hint">저장한 초안이 없습니다. 위에서 말로 만들거나, 해 보이거나, 빈 흐름으로 시작해 보세요.</p>}
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
                  <button className="secondary" data-edit={d.id} onClick={() => openSource(d.source, [], { remember: false })}>
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
      )}
    </>
  );

  /** 카드 목록에 끼우는 단계 추가 폼에 넘길 값 */
  function adderProps(at: number) {
    return {
      form: addForm!,
      text: addText,
      sum: addSum,
      onText: setAddText,
      onSum: setAddSum,
      onSubmit: submitAdder,
      onCancel: () => setAddForm(null),
      onPick: (table: string) => setAddForm((f) => f && { ...f, picked: table }),
      at,
    };
  }
}

function PLACEHOLDER_META(): DraftMeta {
  return { id: PLACEHOLDER.id, name: PLACEHOLDER.name, description: PLACEHOLDER.description, owner: PLACEHOLDER.owner };
}

/** 녹화·빈 흐름으로 처음 만드는 초안의 스킬 정보. 이름·설명·담당 부서는 저장할 때 정한다. */
function newMeta() {
  return { ...PLACEHOLDER_META(), owner: rememberedOwner() || PLACEHOLDER.owner };
}

/** 단계 하나를 카드 목록 안에서 더하는 폼 (말로 / 화면 정리 / 표 읽기) */
function AdderForm(props: {
  at: number;
  form: Adder;
  text: string;
  sum: string;
  onText: (v: string) => void;
  onSum: (v: string) => void;
  onSubmit: (pick?: { table?: string; next?: string }) => void;
  onCancel: () => void;
  onPick: (table: string) => void;
}) {
  const f = props.form;
  const n = props.at + 1;
  return (
    <li className="adder-li" data-adder={f.kind}>
      <div className="adder" role="group" aria-label={`${n}번 자리에 단계 추가`}>
        {f.kind === 'words' && (
          <>
            <textarea
              id="add-words-text"
              rows={2}
              autoFocus
              aria-label="추가할 단계 문장"
              value={props.text}
              placeholder="예: 결과 중 상태가 HOLD인 Lot만 남기고 사유를 확인한다. 표의 각 행마다 …처럼 반복도 말로 씁니다"
              onChange={(e) => props.onText(e.target.value)}
            />
            <div className="row">
              <button id="add-words-ok" disabled={!props.text.trim()} onClick={() => props.onSubmit()}>
                {n}번 자리에 넣기
              </button>
              <button className="ghost" onClick={props.onCancel}>
                취소
              </button>
            </div>
          </>
        )}
        {f.kind !== 'words' && f.loading && <p className="hint">지금 탭의 화면을 읽는 중…</p>}
        {f.kind !== 'words' && f.error && <p className="notice error">{f.error}</p>}
        {f.kind === 'summarize' && !f.loading && !f.error && (
          <>
            <label>
              정리 기준
              <textarea id="add-sum-text" rows={2} value={props.sum} onChange={(e) => props.onSum(e.target.value)} />
            </label>
            <div className="row wrap">
              <span className="hint">무엇을 정리할까요?</span>
              <button className={f.picked ? 'secondary' : ''} onClick={() => props.onPick('')} data-sum-source="page">
                화면의 글
              </button>
              {(f.tables ?? []).map((t) => (
                <button key={t} className={f.picked === t ? '' : 'secondary'} data-sum-source={t} onClick={() => props.onPick(t)}>
                  "{t}" 표
                </button>
              ))}
            </div>
            {f.picked && f.next && f.next.length > 0 && (
              <div className="row wrap">
                <span className="hint">"{f.picked}" 표가 여러 페이지인가요?</span>
                {f.next.map((b) => (
                  <button key={b} className="secondary" onClick={() => props.onSubmit({ table: f.picked, next: b })}>
                    "{b}" 버튼으로 끝까지 읽어 정리
                  </button>
                ))}
              </div>
            )}
            <div className="row">
              <button id="add-sum-ok" disabled={!props.sum.trim()} onClick={() => props.onSubmit()}>
                {f.picked ? `"${f.picked}" 표 정리 단계 넣기` : '화면 글 정리 단계 넣기'}
              </button>
              <button className="ghost" onClick={props.onCancel}>
                취소
              </button>
            </div>
            <p className="hint">정리할 자료(화면 글 12,000자, 표 앞 200행까지)를 사내 모델에 보냅니다. 정리한 내용을 보고에 넣으려면 마지막 단계 문장에 {'{out.reportN}'}을 쓰세요.</p>
          </>
        )}
        {f.kind === 'table' && !f.loading && !f.error && (
          <>
            {(f.tables ?? []).length === 0 ? (
              <p className="hint">이 화면에서 읽을 수 있는 표를 찾지 못했습니다.</p>
            ) : (
              <div className="row wrap">
                <span className="hint">읽을 표</span>
                {(f.tables ?? []).map((t) => (
                  <button key={t} className={f.picked === t ? '' : 'secondary'} data-pick-table={t} onClick={() => ((f.next ?? []).length === 0 ? props.onSubmit({ table: t }) : props.onPick(t))}>
                    "{t}" 표
                  </button>
                ))}
              </div>
            )}
            {f.picked && (
              <div className="row wrap">
                <span className="hint">"{f.picked}" 표가 여러 페이지인가요?</span>
                <button className="secondary" onClick={() => props.onSubmit({ table: f.picked })}>
                  지금 보이는 페이지만
                </button>
                {(f.next ?? []).map((b) => (
                  <button key={b} className="secondary" onClick={() => props.onSubmit({ table: f.picked, next: b })}>
                    "{b}" 버튼으로 끝까지
                  </button>
                ))}
              </div>
            )}
            <div className="row">
              <button className="ghost" onClick={props.onCancel}>
                취소
              </button>
            </div>
          </>
        )}
        {(f.error || f.loading) && f.kind !== 'words' && (
          <div className="row">
            <button className="ghost" onClick={props.onCancel}>
              닫기
            </button>
          </div>
        )}
      </div>
    </li>
  );
}
