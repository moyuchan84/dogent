import { useEffect, useRef, useState, type ReactNode } from 'react';
import {
  blockInputName,
  blockValue,
  checkProblem,
  convertToFixed,
  convertToInput,
  describeBlock,
  duplicateBlock,
  isStartBlock,
  moveBlock,
  removeBlock,
  removeInput,
  addInput,
  setBlockValue,
  setInput,
  toolOf,
  undeclaredInputs,
  updateBlock,
  type Flow,
  type FlowBlock,
  type FlowInput,
  type RunResult,
  type Skill,
} from '@/src/core';
import { KIND_GLYPH, isRunOk, runLine } from './flow-ui';

/** 편집 연산 하나를 적용한다. key가 같은 연속 편집(글자 입력)은 되돌리기에서 한 번으로 합쳐진다. */
export type Edit = (fn: (f: Flow) => Flow, coalesceKey?: string) => void;

export type AddKind = 'words' | 'summarize' | 'table' | 'record';
const ADD_LABEL: Record<AddKind, string> = { words: '말로', summarize: '화면 정리', table: '표 읽기', record: '여기서부터 녹화' };

/** 카드 하나에서 돌리는 시험 실행의 상태 */
export interface TrialState {
  key: string;
  upTo: number;
  phase: 'form' | 'running' | 'done';
  skill?: Skill;
  values: Record<string, string>;
  files: Record<string, File | undefined>;
  result?: RunResult;
  error?: string;
  question?: { text: string; answer: (a: string) => void };
}

/** 칸을 벗어나거나 Enter를 누를 때 값을 반영하는 입력 (글자마다 이름이 바뀌는 것을 막는다) */
export function CommitInput(props: { value: string; onCommit: (v: string) => void; label: string; placeholder?: string; className?: string; data?: Record<string, string | number> }) {
  const [v, setV] = useState(props.value);
  useEffect(() => setV(props.value), [props.value]);
  const data = Object.fromEntries(Object.entries(props.data ?? {}).map(([k, x]) => [`data-${k}`, x]));
  return (
    <input
      {...data}
      className={props.className}
      aria-label={props.label}
      placeholder={props.placeholder}
      value={v}
      onChange={(e) => setV(e.target.value)}
      onBlur={() => v !== props.value && props.onCommit(v)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
        if (e.key === 'Escape') setV(props.value);
      }}
    />
  );
}

/** 단계를 더하는 길 네 가지 */
export function AddChips(props: { onAdd: (k: AddKind) => void; label: string }) {
  return (
    <span className="add-chips" role="group" aria-label={props.label}>
      {(Object.keys(ADD_LABEL) as AddKind[]).map((k) => (
        <button key={k} className="chip-btn" data-add-kind={k} onClick={() => props.onAdd(k)}>
          {ADD_LABEL[k]}
        </button>
      ))}
    </span>
  );
}

/** 카드 사이의 ＋ 삽입 지점 */
export function InsertPoint(props: { at: number; open: boolean; onToggle: () => void; onAdd: (k: AddKind) => void }) {
  return (
    <li className={`insert-point${props.open ? ' open' : ''}`} data-insert={props.at}>
      <button className="plus" aria-expanded={props.open} aria-label={`${props.at + 1}번 자리에 단계 추가`} title="여기에 단계 추가" onClick={props.onToggle}>
        ＋
      </button>
      {props.open && <AddChips label={`${props.at + 1}번 자리에 추가할 방법`} onAdd={props.onAdd} />}
    </li>
  );
}

function ArgsView({ block }: { block: FlowBlock }) {
  if (block.literal === null) return null;
  return (
    <p className="hint args-view">
      <span>도구 인자 (모델 없이 그대로 실행됩니다)</span>
      <code>{block.literal}</code>
    </p>
  );
}

export function StepCard(props: {
  i: number;
  flow: Flow;
  open: boolean;
  menuOpen: boolean;
  highlighted: boolean;
  trial: TrialState | null;
  busy: boolean;
  dropOver: boolean;
  onToggle: () => void;
  onMenu: () => void;
  onEdit: Edit;
  onAdd: (at: number, k: AddKind) => void;
  onFixByWords: (i: number) => void;
  onTrial: (i: number) => void;
  onTrialChange: (t: TrialState | null) => void;
  onTrialRun: () => void;
  onTrialStop: () => void;
  onTrialFix: () => void;
  onDragStart: (i: number) => void;
  onDragOver: (i: number) => void;
  onDrop: (i: number) => void;
  onDragEnd: () => void;
}) {
  const { flow, i } = props;
  const b = flow.blocks[i];
  const view = describeBlock(b);
  const locked = i === 0 && isStartBlock(b);
  const warns = flow.warnings.filter((w) => w.key === b.key);
  const n = i + 1;
  const last = flow.blocks.length - 1;
  const inputName = blockInputName(b);
  const decl = inputName ? flow.meta.inputs.find((x) => x.name === inputName) : undefined;
  const tool = toolOf(b);
  const isValueStep = tool === 'type' || tool === 'select';
  const problem = b.check ? checkProblem(b.check) : null;
  const trial = props.trial;
  const edit = props.onEdit;

  return (
    <li
      className={`step-card kind-${view.kind}${props.open ? ' open' : ''}${props.highlighted ? ' flash' : ''}${props.dropOver ? ' drop-over' : ''}${b.submit ? ' submit' : ''}${locked ? ' locked' : ''}`}
      data-card={i}
      data-key={b.key}
      data-kind={view.kind}
      onDragOver={(e) => {
        e.preventDefault();
        props.onDragOver(i);
      }}
      onDrop={(e) => {
        e.preventDefault();
        props.onDrop(i);
      }}
    >
      <div className="step-head">
        <span
          className={`grip${locked ? ' off' : ''}`}
          draggable={!locked}
          role="img"
          aria-label={locked ? '시작 화면 단계는 옮길 수 없습니다' : '끌어서 순서 바꾸기'}
          title={locked ? '시작 화면 단계는 옮길 수 없습니다' : '끌어서 순서 바꾸기'}
          onDragStart={(e) => {
            e.dataTransfer.effectAllowed = 'move';
            e.dataTransfer.setData('text/plain', String(i));
            props.onDragStart(i);
          }}
          onDragEnd={props.onDragEnd}
        >
          {locked ? '잠금' : '⋮⋮'}
        </span>
        <button className="step-toggle" aria-expanded={props.open} onClick={props.onToggle} data-toggle={i}>
          <span className="step-no">{n}</span>
          <span className="step-glyph" aria-hidden="true">
            {KIND_GLYPH[view.icon]}
          </span>
          <span className="step-title">
            <span className="step-kind">{view.label}</span>
            {view.title}
          </span>
        </button>
        {b.submit && (
          <span className="badge-submit" title="실행할 때 이 단계 직전에 사용자 승인을 받습니다">
            승인 필요
          </span>
        )}
        <button className="icon-btn" data-trial={i} aria-label={`${n}번 단계까지 시험 실행`} title="여기까지 실행 (저장·상신 직전에서 멈춤)" disabled={props.busy || (trial?.phase === 'running')} onClick={() => props.onTrial(i)}>
          ▶
        </button>
        <button className="icon-btn" data-menu={i} aria-label={`${n}번 단계 메뉴`} aria-expanded={props.menuOpen} onClick={props.onMenu}>
          ⋯
        </button>
      </div>

      {warns.map((w) => (
        <p key={w.message} className="card-warn" role="note">
          {w.message}
        </p>
      ))}

      {props.menuOpen && (
        <div className="step-menu" role="menu" aria-label={`${n}번 단계 메뉴`}>
          <div className="menu-row">
            <span>위에 추가</span>
            <AddChips label={`${n}번 위에 추가`} onAdd={(k) => props.onAdd(i, k)} />
          </div>
          <div className="menu-row">
            <span>아래에 추가</span>
            <AddChips label={`${n}번 아래에 추가`} onAdd={(k) => props.onAdd(i + 1, k)} />
          </div>
          <div className="row wrap">
            <button className="secondary" data-act="fix" onClick={() => props.onFixByWords(i)}>
              이 단계 말로 고치기
            </button>
            <button className="secondary" data-act="dup" disabled={locked} onClick={() => edit((f) => duplicateBlock(f, i))}>
              복제
            </button>
            <button className="secondary danger" data-act="del" disabled={locked} onClick={() => edit((f) => removeBlock(f, i))}>
              삭제
            </button>
          </div>
        </div>
      )}

      {props.open && (
        <div className="step-body">
          {locked && <p className="hint">시작 화면 단계입니다. 옮기거나 지울 수 없고, 사이트와 시작 주소는 여기서 바꾸지 않습니다.</p>}
          {b.submit && (
            <p className="card-warn" role="note">
              저장·상신 단계입니다. 실행할 때 이 버튼을 누르기 전에 화면에서 다시 읽은 값을 보여 주고 사용자 승인을 받습니다. 지우면 승인 표시도 함께 지워지고, 위험 등급(R3)은 그대로입니다.
            </p>
          )}
          <label>
            단계 문장
            <textarea
              rows={2}
              data-field="head"
              value={b.head}
              onChange={(e) => edit((f) => updateBlock(f, i, { head: e.target.value }), `head:${b.key}`)}
            />
          </label>
          <ArgsView block={b} />
          <label>
            목적 <span className="hint-inline">(빠른 경로가 실패하면 모델이 이 문장을 보고 같은 일을 합니다)</span>
            <input data-field="note" value={b.note ?? ''} placeholder="이 단계가 하려는 일" onChange={(e) => edit((f) => updateBlock(f, i, { note: e.target.value }), `note:${b.key}`)} />
          </label>
          <label>
            검사 <span className="hint-inline">(단계를 마쳤는지 규칙으로 확인)</span>
            <input data-field="check" value={b.check ?? ''} placeholder='예: text("총") and no_text("조회 중")' onChange={(e) => edit((f) => updateBlock(f, i, { check: e.target.value }), `check:${b.key}`)} />
          </label>
          {problem && <p className="card-warn">검사 식을 읽을 수 없습니다: {problem}</p>}
          {b.record && <p className="hint">기록: <code>{b.record}</code></p>}

          {isValueStep && (
            <div className="param-box">
              <label className="check">
                <input type="checkbox" data-variable={i} checked={!!inputName} onChange={(e) => edit((f) => (e.target.checked ? convertToInput(f, i) : convertToFixed(f, i)))} />
                실행할 때마다 입력받기
              </label>
              {inputName && decl && (
                <div className="param">
                  <CommitInput label="입력 이름 (영문)" placeholder="이름 (영문, 예: keyword)" value={decl.name} data={{ 'param-name': i }} onCommit={(v) => edit((f) => setInput(f, decl.name, { name: v.trim() }))} />
                  <CommitInput label="입력 설명" placeholder="설명 (예: 검색창에 넣을 값)" value={decl.description ?? ''} data={{ 'param-desc': i }} onCommit={(v) => edit((f) => setInput(f, decl.name, { description: v }))} />
                </div>
              )}
              {!inputName && (
                <label>
                  넣을 값 (늘 같은 값)
                  <input data-field="value" value={blockValue(b) ?? ''} onChange={(e) => edit((f) => setBlockValue(f, i, e.target.value), `value:${b.key}`)} />
                </label>
              )}
            </div>
          )}

          <div className="row wrap step-tools">
            <button className="ghost" aria-label={`${n}번 단계를 위로`} disabled={i <= (isStartBlock(flow.blocks[0]) ? 1 : 0) || locked} onClick={() => edit((f) => moveBlock(f, i, i - 1))}>
              ▲ 위로
            </button>
            <button className="ghost" aria-label={`${n}번 단계를 아래로`} disabled={i >= last || locked} onClick={() => edit((f) => moveBlock(f, i, i + 1))}>
              ▼ 아래로
            </button>
            <button className="ghost" disabled={locked} onClick={() => edit((f) => duplicateBlock(f, i))}>
              복제
            </button>
            <button className="ghost" disabled={locked} onClick={() => edit((f) => removeBlock(f, i))}>
              삭제
            </button>
            <button className="secondary" onClick={() => props.onFixByWords(i)}>
              말로 고치기
            </button>
          </div>
        </div>
      )}

      {trial && trial.key === b.key && <TrialPanel {...props} trial={trial} />}
    </li>
  );
}

function TrialPanel(props: {
  i: number;
  trial: TrialState;
  onTrialChange: (t: TrialState | null) => void;
  onTrialRun: () => void;
  onTrialStop: () => void;
  onTrialFix: () => void;
}) {
  const t = props.trial;
  const inputs = t.skill?.inputs ?? [];
  const [answer, setAnswer] = useState('');
  return (
    <div className="trial" data-trial-panel={props.i} data-trial-phase={t.phase} data-trial-status={t.result?.status ?? ''} role="region" aria-label={`${props.i + 1}번 단계까지 시험 실행`}>
      {t.error && <p className="notice error">{t.error}</p>}
      {t.phase === 'form' && (
        <>
          <p className="hint">1번부터 {props.i + 1}번 단계까지 실행합니다. 저장하지 않고, 저장·상신 버튼은 누르기 직전에 멈춥니다.</p>
          {inputs.map((spec) => (
            <label key={spec.name}>
              {spec.label ?? spec.name}
              {spec.required ? ' *' : ''}
              {spec.type === 'file' ? (
                <input type="file" data-trial-file={spec.name} accept=".xlsx,.csv" onChange={(e) => props.onTrialChange({ ...t, files: { ...t.files, [spec.name]: e.target.files?.[0] } })} />
              ) : (
                <input data-trial-input={spec.name} value={t.values[spec.name] ?? ''} placeholder={spec.description} onChange={(e) => props.onTrialChange({ ...t, values: { ...t.values, [spec.name]: e.target.value } })} />
              )}
            </label>
          ))}
          <div className="row">
            <button data-trial-run onClick={props.onTrialRun}>
              시험 실행
            </button>
            <button className="ghost" onClick={() => props.onTrialChange(null)}>
              닫기
            </button>
          </div>
        </>
      )}
      {t.phase === 'running' && (
        <>
          <p className="notice rec" role="status">
            {props.i + 1}번 단계까지 실행하는 중…
          </p>
          {t.question && (
            <div className="question">
              <p>{t.question.text}</p>
              <div className="row">
                <input aria-label="답" value={answer} onChange={(e) => setAnswer(e.target.value)} />
                <button
                  onClick={() => {
                    t.question?.answer(answer);
                    setAnswer('');
                  }}
                >
                  답하기
                </button>
              </div>
            </div>
          )}
          <button className="secondary" data-trial-stop onClick={props.onTrialStop}>
            중지
          </button>
        </>
      )}
      {t.phase === 'done' && t.result && (
        <>
          <p className={`notice ${isRunOk(t.result) ? 'ok' : 'error'}`} role="status">
            {runLine(t.result)}
          </p>
          <div className="row wrap">
            {!isRunOk(t.result) && (
              <button className="secondary" data-trial-fix onClick={props.onTrialFix}>
                이 결과로 말로 고치기
              </button>
            )}
            <button className="ghost" onClick={() => props.onTrialChange({ ...t, phase: 'form', result: undefined })}>
              다시 실행
            </button>
            <button className="ghost" onClick={() => props.onTrialChange(null)}>
              닫기
            </button>
          </div>
        </>
      )}
    </div>
  );
}

export interface ChatEntry {
  id: number;
  role: 'user' | 'bot' | 'error';
  text: string;
  changes?: string[];
  skipped?: string[];
}

/** 하단 고정 대화 입력과 기록 */
export function ChatBox(props: {
  entries: ChatEntry[];
  busy: boolean;
  draft: string;
  onDraft: (v: string) => void;
  onSend: () => void;
  onCancel: () => void;
  hasRun: boolean;
  inputRef: React.RefObject<HTMLTextAreaElement | null>;
}) {
  const logRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    logRef.current?.scrollTo?.({ top: logRef.current.scrollHeight });
  }, [props.entries.length]);
  return (
    <div className="flow-chat" id="flow-chat">
      {props.entries.length > 0 && (
        <div className="chat-log" ref={logRef} role="log" aria-live="polite" aria-label="말로 고친 기록">
          {props.entries.map((e) => (
            <div key={e.id} className={`chat-msg ${e.role}`}>
              <p>{e.text}</p>
              {e.changes && e.changes.length > 0 && (
                <ul className="chat-changes">
                  {e.changes.map((c) => (
                    <li key={c}>{c}</li>
                  ))}
                </ul>
              )}
              {e.skipped && e.skipped.length > 0 && (
                <ul className="chat-skipped">
                  {e.skipped.map((c) => (
                    <li key={c}>건너뜀 — {c}</li>
                  ))}
                </ul>
              )}
            </div>
          ))}
        </div>
      )}
      {props.hasRun && <p className="hint chat-run">방금 시험 결과를 함께 보냅니다.</p>}
      <div className="chat-input">
        <textarea
          id="flow-chat-input"
          ref={props.inputRef}
          rows={2}
          aria-label="이렇게 바꿔 달라고 말하기"
          value={props.draft}
          disabled={props.busy}
          placeholder="이렇게 바꿔 줘 — 예: 3번 앞에 HOLD만 거르는 단계 추가, 라인 기본값은 8라인"
          onChange={(e) => props.onDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              if (props.draft.trim()) props.onSend();
            }
          }}
        />
        {props.busy ? (
          <button className="secondary" id="flow-chat-cancel" onClick={props.onCancel}>
            취소
          </button>
        ) : (
          <button id="flow-chat-send" disabled={!props.draft.trim()} onClick={props.onSend}>
            보내기
          </button>
        )}
      </div>
    </div>
  );
}

/** 입력값 패널: 스킬 입력을 보고 고치고, 선언 안 된 이름을 알린다. */
export function InputsPanel(props: { flow: Flow; onEdit: Edit; onScroll: (key: string) => void }) {
  const { flow, onEdit: edit } = props;
  const missing = undeclaredInputs(flow);
  const set = (name: string, patch: Partial<FlowInput>, key?: string) => edit((f) => setInput(f, name, patch), key);
  return (
    <details className="panel" id="inputs-panel" open={missing.length > 0 || undefined}>
      <summary>
        입력값 ({flow.meta.inputs.length}){missing.length > 0 && <span className="badge-warn"> · 선언 안 된 {missing.length}</span>}
      </summary>
      {flow.meta.inputs.length === 0 && <p className="hint">실행할 때마다 달라지는 값이 없습니다. 단계 문장에 {'{이름}'}을 쓰고 여기서 입력으로 추가하면 실행 때 값을 받습니다.</p>}
      {missing.map((m) => (
        <p key={m.name} className="card-warn" data-missing={m.name}>
          {'{'}
          {m.name}
          {'}'}을(를) 쓰는 단계가 있지만 입력으로 선언되지 않았습니다. 실행하면 그 자리가 그대로 남습니다.{' '}
          <button className="secondary" onClick={() => edit((f) => addInput(f, { name: m.name, label: m.name, type: 'string', required: true }))}>
            입력으로 추가
          </button>{' '}
          <button className="ghost" onClick={() => props.onScroll(m.keys[0])}>
            쓰는 단계 보기
          </button>
        </p>
      ))}
      <div className="inputs-list">
        {flow.meta.inputs.map((inp) => (
          <div key={inp.name} className="input-row" data-input={inp.name}>
            <CommitInput label="이름" value={inp.name} placeholder="이름 (영문)" data={{ 'input-name': inp.name }} onCommit={(v) => edit((f) => setInput(f, inp.name, { name: v.trim() }))} />
            <input aria-label="화면에 보일 이름" placeholder="라벨" value={inp.label ?? ''} onChange={(e) => set(inp.name, { label: e.target.value }, `ilabel:${inp.name}`)} />
            <input aria-label="설명" placeholder="설명 (요청에서 값을 뽑는 근거)" className="wide" value={inp.description ?? ''} onChange={(e) => set(inp.name, { description: e.target.value }, `idesc:${inp.name}`)} />
            <input aria-label="기본값" placeholder="기본값" value={inp.default === undefined ? '' : String(inp.default)} onChange={(e) => set(inp.name, { default: e.target.value }, `idef:${inp.name}`)} />
            <select aria-label="형식" value={inp.type ?? 'string'} onChange={(e) => set(inp.name, { type: e.target.value })}>
              {['string', 'number', 'text', 'enum', 'ip', 'port', 'file'].map((t) => (
                <option key={t}>{t}</option>
              ))}
            </select>
            <label className="check">
              <input type="checkbox" checked={!!inp.required} onChange={(e) => set(inp.name, { required: e.target.checked })} />
              필수
            </label>
            <button className="ghost" aria-label={`입력 ${inp.name} 지우기`} onClick={() => edit((f) => removeInput(f, inp.name))}>
              지우기
            </button>
          </div>
        ))}
      </div>
      <button
        className="secondary"
        id="input-add"
        onClick={() => {
          const taken = new Set(flow.meta.inputs.map((i) => i.name));
          let k = 1;
          while (taken.has(`value${k}`)) k++;
          edit((f) => addInput(f, { name: `value${k}`, label: '', type: 'string', required: true }));
        }}
      >
        입력 추가
      </button>
    </details>
  );
}

/** 접이식 영역의 제목과 내용을 묶는다 */
export function Panel(props: { id?: string; title: ReactNode; open?: boolean; onToggle?: (open: boolean) => void; children: ReactNode }) {
  return (
    <details className="panel" id={props.id} open={props.open} onToggle={(e) => props.onToggle?.((e.target as HTMLDetailsElement).open)}>
      <summary>{props.title}</summary>
      {props.children}
    </details>
  );
}
