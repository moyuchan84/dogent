import { useEffect, useMemo, useRef, useState } from 'react';
import { browser } from 'wxt/browser';
import {
  DatasetStore,
  OpenAiCompatClient,
  planRequest,
  resolveInputs,
  runSkill,
  type ApprovalRequest,
  type Dataset,
  type LlmSettings,
  type RunEvent,
  type RunResult,
} from '@/src/core';
import { ChromeBrowser } from '@/src/ext/browser';
import { loadBundledSkills } from '@/src/ext/skills';
import { appendRun, loadRuns, loadSettings, saveSettings } from '@/src/ext/storage';

const STATUS_LABEL: Record<RunResult['status'], string> = {
  done: '완료',
  aborted: '중단',
  stopped: '사용자 중지',
  error: '오류',
  dryrun: '시험 실행 완료',
};

function download(filename: string, data: BlobPart, type: string) {
  const url = URL.createObjectURL(new Blob([data], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** 테스트에서는 ?tabId= 로 대상 탭을 지정한다. 평소에는 현재 창의 활성 탭. */
async function targetTab(): Promise<{ id: number; url: string }> {
  const forced = new URLSearchParams(location.search).get('tabId');
  const tab = forced
    ? await browser.tabs.get(Number(forced))
    : (await browser.tabs.query({ active: true, currentWindow: true }))[0];
  if (tab?.id === undefined) throw new Error('대상 탭을 찾을 수 없습니다');
  return { id: tab.id, url: tab.url ?? '' };
}

export function App() {
  const { skills, errors: skillErrors } = useMemo(loadBundledSkills, []);
  const [settings, setSettings] = useState<LlmSettings | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [skillId, setSkillId] = useState(skills[0]?.id ?? '');
  const [form, setForm] = useState<Record<string, string>>({});
  const [request, setRequest] = useState('');
  const [notice, setNotice] = useState('');
  const [planning, setPlanning] = useState(false);
  const [running, setRunning] = useState(false);
  const [events, setEvents] = useState<RunEvent[]>([]);
  const [result, setResult] = useState<RunResult | null>(null);
  const [previews, setPreviews] = useState<Dataset[]>([]);
  const [question, setQuestion] = useState<{ text: string; answer: (a: string) => void } | null>(null);
  const [answer, setAnswer] = useState('');
  const [approval, setApproval] = useState<{ request: ApprovalRequest; decide: (ok: boolean) => void } | null>(null);
  const [dryRun, setDryRun] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const logEnd = useRef<HTMLDivElement>(null);

  const skill = skills.find((s) => s.id === skillId);

  useEffect(() => {
    loadSettings().then(setSettings);
  }, []);
  useEffect(() => {
    logEnd.current?.scrollIntoView({ block: 'end' });
  }, [events, result, question, approval]);

  async function plan() {
    if (!settings || !request.trim()) return;
    setPlanning(true);
    setNotice('');
    try {
      const p = await planRequest(request, skills, new OpenAiCompatClient(settings));
      if (!p.skill_id) {
        setNotice(`맞는 스킬을 찾지 못했습니다. ${p.reason}`);
        return;
      }
      setSkillId(p.skill_id);
      setForm(Object.fromEntries(Object.entries(p.inputs).map(([k, v]) => [k, String(v)])));
      setNotice('요청을 아래 입력값으로 읽었습니다. 확인하고 실행을 누르세요.');
    } catch (e) {
      setNotice(`요청을 해석하지 못했습니다: ${(e as Error).message}`);
    } finally {
      setPlanning(false);
    }
  }

  async function run() {
    if (!settings || !skill) return;
    const { values, errors } = resolveInputs(skill, form);
    if (errors.length) {
      setNotice(errors.join(' / '));
      return;
    }
    setNotice('');
    setEvents([]);
    setResult(null);
    setPreviews([]);
    setRunning(true);

    const abort = new AbortController();
    abortRef.current = abort;
    const collected: RunEvent[] = [];
    const datasets = new DatasetStore();
    const startedAt = new Date().toISOString();
    let tabUrl = '';
    let res: RunResult;
    try {
      const tab = await targetTab();
      tabUrl = tab.url;
      // 느린 모델용 배율은 스킬의 전체 제한 시간에도 같이 적용한다.
      const scale = Math.max(1, settings.timeoutScale || 1);
      const scaled = { ...skill, limits: { ...skill.limits, timeout_sec: skill.limits.timeout_sec * scale } };
      res = await runSkill(scaled, values, {
        llm: new OpenAiCompatClient(settings),
        browser: new ChromeBrowser(tab.id),
        datasets,
        signal: abort.signal,
        dryRun: skill.risk === 'R3' && dryRun,
        files: {
          async save(filename, data) {
            download(filename, data, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
          },
        },
        ui: {
          ask: (text) =>
            new Promise<string>((resolve, reject) => {
              abort.signal.addEventListener('abort', () => reject(new Error('중지됨')), { once: true });
              setQuestion({ text, answer: resolve });
            }),
          approve: (request) =>
            new Promise<boolean>((resolve, reject) => {
              abort.signal.addEventListener('abort', () => reject(new Error('중지됨')), { once: true });
              setApproval({ request, decide: resolve });
            }),
        },
        onEvent(e) {
          collected.push(e);
          setEvents([...collected]);
        },
      });
    } catch (e) {
      res = {
        status: 'error',
        message: (e as Error).message,
        lastStep: 0,
        actions: 0,
        files: [],
        datasets: [],
        outputs: {},
        elapsedMs: 0,
      };
    }
    setQuestion(null);
    setApproval(null);
    setResult(res);
    setPreviews(datasets.list());
    setRunning(false);
    await appendRun({
      id: crypto.randomUUID(),
      startedAt,
      skill: { id: skill.id, version: skill.version },
      inputs: values,
      tabUrl,
      events: collected,
      result: res,
    });
  }

  async function exportLog() {
    const runs = await loadRuns();
    download(`dogent-log-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(runs, null, 2), 'application/json');
  }

  if (!settings) return null;

  return (
    <div className="app">
      <header>
        <h1>Dogent</h1>
        <div className="header-actions">
          <button className="ghost" onClick={exportLog} title="실행 기록을 JSON으로 저장">
            기록 내보내기
          </button>
          <button className="ghost" onClick={() => setShowSettings((v) => !v)}>
            설정
          </button>
        </div>
      </header>

      {showSettings && (
        <section className="card">
          <h2>모델 설정</h2>
          <label>
            API 주소
            <input
              value={settings.baseUrl}
              onChange={(e) => setSettings({ ...settings, baseUrl: e.target.value })}
              placeholder="https://.../v1"
            />
          </label>
          <label>
            모델 이름
            <input value={settings.model} onChange={(e) => setSettings({ ...settings, model: e.target.value })} />
          </label>
          <label>
            API 키
            <input
              type="password"
              value={settings.apiKey}
              onChange={(e) => setSettings({ ...settings, apiKey: e.target.value })}
            />
          </label>
          <label className="check">
            <input
              type="checkbox"
              checked={settings.jsonMode}
              onChange={(e) => setSettings({ ...settings, jsonMode: e.target.checked })}
            />
            JSON 출력 모드 사용 (API가 response_format을 지원할 때)
          </label>
          <label>
            제한 시간 배율
            <input
              type="number"
              min={1}
              value={settings.timeoutScale}
              onChange={(e) => setSettings({ ...settings, timeoutScale: Number(e.target.value) || 1 })}
            />
          </label>
          <p className="hint">기본은 응답 60초, 스킬별 전체 제한 시간입니다. 느린 로컬 모델이면 배율을 올리세요.</p>
          <p className="hint">API 주소의 호스트는 dogent.config.ts의 llmPermissions에도 있어야 합니다.</p>
          <button
            onClick={async () => {
              await saveSettings(settings);
              setShowSettings(false);
            }}
          >
            저장
          </button>
        </section>
      )}

      {skillErrors.map((e) => (
        <p key={e} className="notice error">
          {e}
        </p>
      ))}

      <section className="card">
        <h2>무엇을 할까요?</h2>
        <div className="row">
          <input
            id="request"
            value={request}
            disabled={running || planning}
            onChange={(e) => setRequest(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && plan()}
            placeholder="예: 8라인 PHOTO 공정 재공 확인해줘"
          />
          <button id="plan" className="secondary" onClick={plan} disabled={running || planning || !request.trim()}>
            {planning ? '해석 중' : '해석'}
          </button>
        </div>
        {notice && <p className="notice">{notice}</p>}

        <label>
          스킬
          <select
            id="skill"
            value={skillId}
            disabled={running}
            onChange={(e) => {
              setSkillId(e.target.value);
              setForm({});
            }}
          >
            {skills.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name} ({s.risk})
              </option>
            ))}
          </select>
        </label>
        {skill && <p className="hint">{skill.description}</p>}
        {skill?.inputs.map((i) => (
          <label key={i.name}>
            {i.label ?? i.name}
            {i.required && <span className="req"> *</span>}
            {i.type === 'enum' && i.values ? (
              <select
                data-input={i.name}
                value={form[i.name] ?? String(i.default ?? '')}
                disabled={running}
                onChange={(e) => setForm({ ...form, [i.name]: e.target.value })}
              >
                {i.default === undefined && <option value="">선택</option>}
                {i.values.map((v) => (
                  <option key={v}>{v}</option>
                ))}
              </select>
            ) : i.type === 'text' ? (
              <textarea
                data-input={i.name}
                value={form[i.name] ?? ''}
                disabled={running}
                rows={3}
                onChange={(e) => setForm({ ...form, [i.name]: e.target.value })}
              />
            ) : (
              <input
                data-input={i.name}
                value={form[i.name] ?? ''}
                disabled={running}
                placeholder={i.default !== undefined ? `기본값 ${i.default}` : ''}
                onChange={(e) => setForm({ ...form, [i.name]: e.target.value })}
              />
            )}
          </label>
        ))}
        {skill?.risk === 'R3' && (
          <label className="check">
            <input id="dryrun" type="checkbox" checked={dryRun} disabled={running} onChange={(e) => setDryRun(e.target.checked)} />
            시험 실행 (입력까지만 하고 저장·상신 직전에 멈춤)
          </label>
        )}
        <div className="row">
          {running ? (
            <button id="stop" className="danger" onClick={() => abortRef.current?.abort()}>
              중지
            </button>
          ) : (
            <button id="run" onClick={run} disabled={!skill}>
              실행
            </button>
          )}
        </div>
      </section>

      {(events.length > 0 || result) && (
        <section className="card">
          <h2>진행</h2>
          <ol className="log">
            {events.map((e, i) => {
              if (e.type === 'action') {
                const h = e.entry;
                return (
                  <li key={i} className={h.ok ? '' : 'fail'}>
                    <div className="log-head">
                      <span className="step">단계 {h.step}</span>
                      <b>{h.tool}</b>
                      <code>{JSON.stringify(h.args).slice(0, 90)}</code>
                    </div>
                    {h.thought && <div className="thought">{h.thought}</div>}
                    <div className="outcome">{h.result}</div>
                  </li>
                );
              }
              if (e.type === 'approval') {
                return (
                  <li key={i} className={e.approved ? 'minor' : 'fail'}>
                    "{e.request.button}" {e.dryRun ? '직전에 멈춤 (시험 실행)' : e.approved ? '승인됨' : '승인하지 않음'}
                  </li>
                );
              }
              if (e.type === 'step_done') {
                return (
                  <li key={i} className="minor">
                    단계 {e.step} 확인됨
                  </li>
                );
              }
              if (e.type === 'llm_retry') {
                return (
                  <li key={i} className="minor">
                    모델 응답 형식 오류, 재요청
                  </li>
                );
              }
              return null;
            })}
          </ol>

          {approval && (
            <div id="approval" className="approval">
              <b>"{approval.request.button}" 전에 확인해 주세요</b>
              <p className="hint">
                {approval.request.skill} · 화면에서 다시 읽은 현재 값입니다. 승인하면 실제로 제출됩니다.
              </p>
              <dl>
                {approval.request.fields.map((f) => (
                  <div key={f.name}>
                    <dt>{f.name}</dt>
                    <dd>{f.value || '(비어 있음)'}</dd>
                  </div>
                ))}
              </dl>
              <div className="row">
                <button
                  id="decline"
                  className="secondary"
                  onClick={() => {
                    approval.decide(false);
                    setApproval(null);
                  }}
                >
                  취소
                </button>
                <button
                  id="approve"
                  onClick={() => {
                    approval.decide(true);
                    setApproval(null);
                  }}
                >
                  승인하고 {approval.request.button}
                </button>
              </div>
            </div>
          )}

          {question && (
            <div className="question">
              <p>{question.text}</p>
              <div className="row">
                <input value={answer} onChange={(e) => setAnswer(e.target.value)} autoFocus />
                <button
                  onClick={() => {
                    question.answer(answer);
                    setQuestion(null);
                    setAnswer('');
                  }}
                >
                  답변
                </button>
              </div>
            </div>
          )}

          {result && (
            <div id="result" className={`result ${result.status}`} data-status={result.status}>
              <div className="result-head">
                <b>{STATUS_LABEL[result.status]}</b>
                <span>
                  동작 {result.actions}회 · {(result.elapsedMs / 1000).toFixed(1)}초
                </span>
              </div>
              <p>{result.message}</p>
              {result.files.length > 0 && <p className="hint">저장한 파일: {result.files.join(', ')}</p>}
            </div>
          )}

          {previews.map((ds) => (
            <details key={ds.name} className="preview">
              <summary>
                {ds.name} · {ds.rows.length}행
              </summary>
              <div className="tablewrap">
                <table>
                  <thead>
                    <tr>
                      {ds.columns.map((c) => (
                        <th key={c}>{c}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {ds.rows.slice(0, 10).map((r, i) => (
                      <tr key={i}>
                        {r.map((c, j) => (
                          <td key={j}>{c}</td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {ds.rows.length > 10 && <p className="hint">처음 10행만 표시</p>}
            </details>
          ))}
          <div ref={logEnd} />
        </section>
      )}
    </div>
  );
}
