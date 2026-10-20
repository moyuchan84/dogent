import { useEffect, useRef, useState } from 'react';
import type { ConnectPreview, DogentApi, Permission, ProbeResult, ServerRow } from '../ipc';

const api = (): DogentApi => window.dogent;

const PERMISSIONS: { value: Permission | 'default'; label: string }[] = [
  { value: 'default', label: '기본 (읽기는 바로, 바꾸는 건 묻기)' },
  { value: 'allow', label: '바로 부름' },
  { value: 'ask', label: '부르기 전에 묻기' },
  { value: 'deny', label: '쓰지 않음' },
];

type Probe = ProbeResult | 'loading';

/** 왼쪽 "커넥터" 탭: 연결한 MCP 서버 목록. 서버를 펼치면 연결을 시험하고 도구별 권한을 정한다. */
export function ConnectorsPanel({ servers, onChange, onAdd }: { servers: ServerRow[]; onChange: (rows: ServerRow[]) => void; onAdd: () => void }) {
  const [open, setOpen] = useState<string | null>(null);
  const [probes, setProbes] = useState<Record<string, Probe>>({});

  function probe(name: string) {
    setProbes((p) => ({ ...p, [name]: 'loading' }));
    api()
      .connectProbe(name)
      .then((r) => setProbes((p) => ({ ...p, [name]: r })))
      .catch((e: Error) => setProbes((p) => ({ ...p, [name]: { name, ok: false, error: e.message, tools: [] } })));
  }

  function toggle(name: string) {
    const next = open === name ? null : name;
    setOpen(next);
    if (next && !probes[next]) probe(next);
  }

  return (
    <>
      <div className="side-tools">
        <button className="compose" id="add-connector" onClick={onAdd} title="사내 마켓에서 복사한 설치 명령이나 설정을 붙여 넣어 커넥터를 더합니다">
          <span aria-hidden>＋</span> 커넥터 추가
        </button>
      </div>
      <div className="side-list" id="connector-list">
        {servers.length === 0 && (
          <div className="empty">
            연결한 커넥터가 없습니다. 사내 마켓에서 복사한 <code>claude mcp add …</code> 명령이나 MCP 설정 JSON을 붙여 넣으면 바로 더할 수 있습니다.
          </div>
        )}
        {servers.map((s) => (
          <ServerCard
            key={s.name}
            row={s}
            open={open === s.name}
            probe={probes[s.name]}
            onToggle={() => toggle(s.name)}
            onProbe={() => probe(s.name)}
            onChange={onChange}
            onRemoved={() => setOpen(null)}
          />
        ))}
      </div>
    </>
  );
}

function ServerCard(props: {
  row: ServerRow;
  open: boolean;
  probe?: Probe;
  onToggle: () => void;
  onProbe: () => void;
  onChange: (rows: ServerRow[]) => void;
  onRemoved: () => void;
}) {
  const { row, probe } = props;
  const [keywords, setKeywords] = useState(row.keywords.join(', '));
  const [confirmDelete, setConfirmDelete] = useState(false);
  const state = row.disabled ? 'off' : probe === undefined ? 'unknown' : probe === 'loading' ? 'loading' : probe.ok ? 'ok' : 'bad';
  const label = { off: '꺼짐', unknown: '확인 전', loading: '연결 중…', ok: '연결됨', bad: '연결 안 됨' }[state];
  const patch = (p: Parameters<DogentApi['connectPatch']>[1]) => api().connectPatch(row.name, p).then(props.onChange);

  return (
    <div className={`conn ${props.open ? 'open' : ''}`} data-connector={row.name}>
      <div className="conn-head">
        <button className="conn-main" onClick={props.onToggle} aria-expanded={props.open}>
          <span className="conn-title">
            <i className={`status ${state}`} title={label} />
            <b>{row.name}</b>
            <span className="chip">{row.where === 'remote' ? '원격' : '이 PC'}</span>
          </span>
          <small>
            {label}
            {probe && probe !== 'loading' && probe.ok ? ` · 도구 ${probe.tools.length}개` : ''} · {row.target}
          </small>
        </button>
        <label className="switch" title={row.disabled ? '켜기' : '끄기'}>
          <input type="checkbox" checked={!row.disabled} onChange={(e) => void patch({ disabled: !e.target.checked })} aria-label={`${row.name} 사용`} />
          <span />
        </label>
      </div>
      {props.open && (
        <div className="conn-body">
          {probe === 'loading' && <div className="hint">서버에 연결하고 도구 목록을 읽는 중…</div>}
          {probe && probe !== 'loading' && !probe.ok && (
            <div className="conn-error" role="alert">
              <b>연결하지 못했습니다</b>
              <span>{probe.error}</span>
            </div>
          )}
          {probe && probe !== 'loading' && probe.ok && (
            <div className="tool-list">
              {probe.tools.length === 0 && <div className="hint">이 서버는 도구를 내놓지 않았습니다.</div>}
              {probe.tools.map((t) => {
                const set = t.permission;
                return (
                  <div key={t.tool} className="tool-row" title={t.description}>
                    <div>
                      <code>{t.tool}</code>
                      <span className={`chip ${t.readOnly ? '' : 'bad'}`}>{t.readOnly ? '읽기' : '바꿈'}</span>
                      <small>{t.description.replace(/\s+/g, ' ')}</small>
                    </div>
                    <select
                      aria-label={`${t.tool} 권한`}
                      value={set}
                      onChange={(e) => {
                        const value = e.target.value as Permission;
                        void patch({ permission: { tool: t.tool, value } }).then(props.onProbe);
                      }}
                    >
                      {PERMISSIONS.filter((p) => p.value !== 'default').map((p) => (
                        <option key={p.value} value={p.value}>
                          {p.label}
                        </option>
                      ))}
                    </select>
                  </div>
                );
              })}
            </div>
          )}
          <label className="field-row">
            <span>이 말이 나오면 브라우저 없이 이 서버로 처리 (쉼표로 구분)</span>
            <input
              value={keywords}
              placeholder={`예: ${row.name}, 재공, 홀드`}
              onChange={(e) => setKeywords(e.target.value)}
              onBlur={() => void patch({ keywords: keywords.split(',').map((x) => x.trim()).filter(Boolean) })}
            />
          </label>
          <div className="conn-actions">
            <button className="secondary" onClick={props.onProbe} disabled={probe === 'loading'}>
              다시 시험
            </button>
            {confirmDelete ? (
              <>
                <button
                  className="danger"
                  onClick={() => void api().connectRemove(row.name).then((rows) => (props.onChange(rows), props.onRemoved()))}
                >
                  정말 빼기
                </button>
                <button className="ghost" onClick={() => setConfirmDelete(false)}>
                  취소
                </button>
              </>
            ) : (
              <button className="ghost" onClick={() => setConfirmDelete(true)}>
                빼기
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

const EXAMPLES = [
  { label: 'claude mcp add', text: 'claude mcp add --transport http --scope user github-mcp http://서버주소/mcp' },
  { label: 'MCP 설정 JSON', text: '{"mcpServers": {"mes": {"type": "http", "url": "http://서버주소/mcp"}}}' },
  { label: '서버 주소', text: 'http://서버주소/mcp' },
];

/** 연결 추가 창: 마켓에서 복사한 글을 붙이면 무엇을 더할지 먼저 보여 주고, 확인하면 더한 뒤 연결을 시험한다. */
export function ConnectDialog({ onClose, onDone }: { onClose: () => void; onDone: (rows: ServerRow[]) => void }) {
  const [text, setText] = useState('');
  const [preview, setPreview] = useState<ConnectPreview | null>(null);
  const [error, setError] = useState('');
  const [working, setWorking] = useState(false);
  const [results, setResults] = useState<ProbeResult[] | null>(null);
  const ref = useRef<HTMLTextAreaElement>(null);

  useEffect(() => ref.current?.focus(), []);
  useEffect(() => {
    if (!text.trim()) {
      setPreview(null);
      setError('');
      return;
    }
    const t = setTimeout(() => {
      api()
        .connectPreview(text)
        .then((p) => (setPreview(p), setError('')))
        .catch((e: Error) => (setPreview(null), setError(e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, ''))));
    }, 250);
    return () => clearTimeout(t);
  }, [text]);

  function add() {
    setWorking(true);
    api()
      .connectAdd(text)
      .then(async (r) => {
        setResults(r);
        onDone(await api().connectors());
      })
      .catch((e: Error) => setError(e.message))
      .finally(() => setWorking(false));
  }

  const local = preview?.kind === 'mcp' && preview.servers.some((s) => s.where === 'local');
  return (
    <div className="overlay center" onClick={onClose}>
      <div className="dialog" id="connect-dialog" role="dialog" aria-label="커넥터 추가" onClick={(e) => e.stopPropagation()}>
        <div className="dialog-head">
          <h2>커넥터 추가</h2>
          <button className="ghost" onClick={onClose}>
            {results ? '닫기' : '취소'}
          </button>
        </div>
        {results ? (
          <div className="dialog-body" id="connect-result">
            {results.map((r) => (
              <div key={r.name} className={`result ${r.ok ? 'ok' : 'bad'}`}>
                <div>
                  <i className={`status ${r.ok ? 'ok' : 'bad'}`} /> <b>{r.name}</b> {r.ok ? `연결됨 · 도구 ${r.tools.length}개` : '더했지만 연결하지 못했습니다'}
                </div>
                {r.ok ? <small>{r.tools.slice(0, 8).map((t) => t.tool).join(', ')}{r.tools.length > 8 ? ' 외' : ''}</small> : <small>{r.error}</small>}
              </div>
            ))}
            {results.some((r) => r.ok && r.tools.some((t) => !t.readOnly)) && (
              <div className="hint">바꾸는 도구는 부르기 전에 항상 묻습니다. 커넥터 목록에서 도구별로 바꿀 수 있습니다.</div>
            )}
            <div className="dialog-actions">
              <button onClick={onClose}>완료</button>
            </div>
          </div>
        ) : (
          <div className="dialog-body">
            <label className="field-row">
              <span>마켓에서 복사한 설치 명령이나 설정을 붙여 넣으세요</span>
              <textarea ref={ref} id="connect-text" rows={4} value={text} spellCheck={false} onChange={(e) => setText(e.target.value)} placeholder={EXAMPLES[0].text} />
            </label>
            {!text.trim() && (
              <div className="examples">
                <span>이런 것을 읽습니다</span>
                {EXAMPLES.map((x) => (
                  <button key={x.label} className="chip-button" onClick={() => setText(x.text)}>
                    {x.label}
                  </button>
                ))}
              </div>
            )}
            {error && (
              <div className="conn-error" role="alert">
                <span>{error}</span>
              </div>
            )}
            {preview?.kind === 'mcp' && (
              <div className="preview" id="connect-preview">
                {preview.servers.map((s) => (
                  <div key={s.name} className="preview-row">
                    <div>
                      <b>{s.name}</b> <span className="chip">{s.where === 'remote' ? '원격 서버' : '이 PC에서 실행'}</span>
                      {preview.replaces.includes(s.name) && <span className="chip bad">같은 이름을 바꿈</span>}
                    </div>
                    <code>{s.target}</code>
                  </div>
                ))}
                <div className={local ? 'warning' : 'hint'}>
                  {local
                    ? '이 명령은 서버를 쓸 때마다 이 PC에서 실행됩니다. 아는 서버만 더하세요.'
                    : '요청을 처리하면서 쓴 값이 이 주소로 전송됩니다. 사내 서버가 맞는지 확인하세요.'}
                </div>
              </div>
            )}
            {preview?.kind === 'skill' && (
              <div className="preview" id="connect-preview">
                <div className="preview-row">
                  <b>스킬 주소</b>
                  <code>{preview.url}</code>
                </div>
                <div className="warning">주소로 스킬을 받아 오는 기능은 아직 준비 중입니다. 지금은 설정의 팀 스킬 저장소 주소를 쓰거나, 스킬 탭의 「말로 스킬 만들기」를 쓰세요.</div>
              </div>
            )}
            <div className="dialog-actions">
              <button id="connect-submit" disabled={preview?.kind !== 'mcp' || working} onClick={add}>
                {working ? '연결을 시험하는 중…' : preview?.kind === 'mcp' && preview.servers.length > 1 ? `${preview.servers.length}개 더하기` : '더하기'}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
