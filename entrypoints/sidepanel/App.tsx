import { useEffect, useMemo, useRef, useState } from 'react';
import { browser } from 'wxt/browser';
import {
  DatasetStore,
  FREE_SKILL_ID,
  buildFreeSkill,
  OpenAiCompatClient,
  headerPlaceholders,
  parseSkill,
  planRequest,
  readTable,
  resolveInputs,
  runSkill,
  batchReport,
  buildWorkbook,
  planBatch,
  stopsBatch,
  type ApprovalRequest,
  type BatchOutcome,
  type BatchPlan,
  type SkillInputs,
  type Dataset,
  type LlmSettings,
  type RunEvent,
  type RunResult,
  type Skill,
} from '@/src/core';
import { ChromeBrowser } from '@/src/ext/browser';
import { loadShared, refreshShared, type SharedState } from '@/src/ext/shared';
import { loadBundledSkills } from '@/src/ext/skills';
import { appendRun, builtInHeaders, resetSettings, clearPaths, effectiveSettings, hasBuiltInKey, loadDrafts, loadRuns, loadSettings, markTrial, pathStore, saveSettings, type DraftSkill } from '@/src/ext/storage';
import { Author } from './Author';
import { BatchView } from './Batch';
import { History } from './History';
import { Inspect } from './Inspect';
import { Sites } from './Sites';
import { Connect } from './Connect';
import { hostAccess } from '@/src/ext/sites';
import { download, targetTab } from './util';

/** 로그인 화면을 만났을 때 사람이 로그인하기를 기다리는 시간 */
const LOGIN_WAIT_MS = 5 * 60_000;

const STATUS_LABEL: Record<RunResult['status'], string> = {
  done: '완료',
  aborted: '중단',
  stopped: '사용자 중지',
  error: '오류',
  dryrun: '시험 실행 완료',
};

export function App() {
  const { skills: builtIn, errors: skillErrors } = useMemo(loadBundledSkills, []);
  // 공유 저장소에서 받은 스킬. 같은 id의 번들 스킬보다 우선한다 (저장소가 최신이다).
  const [shared, setShared] = useState<SharedState | null>(null);
  const [syncError, setSyncError] = useState('');
  const [syncing, setSyncing] = useState(false);
  const sharedSkills = useMemo(
    () =>
      (shared?.skills ?? []).flatMap((s): Skill[] => {
        try {
          return [parseSkill(s.source, s.policy)];
        } catch {
          return [];
        }
      }),
    [shared],
  );
  const isShared = (id: string) => sharedSkills.some((s) => s.id === id);
  const bundled = useMemo(
    () => [...sharedSkills, ...builtIn.filter((b) => !sharedSkills.some((s) => s.id === b.id))],
    [builtIn, sharedSkills],
  );
  const [tab, setTab] = useState<'run' | 'author' | 'history'>('run');
  const [drafts, setDrafts] = useState<DraftSkill[]>([]);
  // 초안은 만든 PC에서만 보인다. 번들된 스킬과 구분해 표시하고, 자연어 해석 대상에는 넣지 않는다.
  const draftSkills = useMemo(
    () =>
      drafts.flatMap((d): Skill[] => {
        try {
          return [parseSkill(d.source)];
        } catch {
          return [];
        }
      }),
    [drafts],
  );
  const skills = useMemo(() => [...bundled, ...draftSkills], [bundled, draftSkills]);
  const isDraft = (id: string) => draftSkills.some((d) => d.id === id);
  const reloadDrafts = () => loadDrafts().then(setDrafts);
  const [settings, setSettings] = useState<LlmSettings | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [showInspect, setShowInspect] = useState(false);
  const [llmTest, setLlmTest] = useState('');
  // 연결 시험에서 권한이 막혀 있던 모델 API 주소. 버튼으로 다시 요청한다.
  const [llmGrant, setLlmGrant] = useState<string | null>(null);
  const placeholders = useMemo(() => headerPlaceholders(builtInHeaders), []);

  /** 지금 설정 화면의 값으로 모델을 한 번 불러 본다. 저장하지 않아도 된다. */
  async function testLlm() {
    if (!settings) return;
    setLlmTest('시험하는 중…');
    const started = Date.now();
    try {
      const reply = await new OpenAiCompatClient(effectiveSettings(settings), undefined, 16).complete([
        { role: 'user', content: '연결 확인입니다. "ok"라고만 답하세요.' },
      ]);
      setLlmTest(`연결됨 (${((Date.now() - started) / 1000).toFixed(1)}초) · 모델 답: ${reply.trim().slice(0, 60)}`);
    } catch (e) {
      const message = (e as Error).message;
      setLlmGrant(null);
      if (!message.startsWith('모델 API에 닿지 못했습니다')) return setLlmTest(message);
      // 크롬에서는 되는데 엣지에서만 안 되는 경우: 브라우저가 확장의 이 주소 접근 권한을 막고 있으면
      // 확장의 요청도 CORS 검사를 받아 사내 게이트웨이에 닿지 못한다.
      const access = await hostAccess(settings.baseUrl);
      if (access && !access.granted) {
        setLlmGrant(access.pattern);
        return setLlmTest(
          `${message}\n\n원인: 이 브라우저에서 Dogent가 ${access.pattern}에 접근할 권한이 없습니다. 아래 "이 주소 접근 허용"을 누르세요. 허용 창이 뜨지 않으면 확장 관리 화면(edge://extensions 또는 chrome://extensions) → Dogent → 세부 정보 → 사이트 액세스를 확인하거나, 회사 정책(edge://policy의 ExtensionSettings → runtime_blocked_hosts)을 확인하세요.`,
        );
      }
      setLlmTest(
        `${message}\n\n권한은 있습니다. 네트워크 쪽(프록시, 인증서, 보안 프로그램)이 원인일 수 있습니다. 확장 관리 화면 → Dogent → "뷰 검사"로 개발자 도구를 열고, 연결 시험을 다시 눌러 Network 탭의 오류 코드를 확인하세요.`,
      );
    }
  }

  /** 막혀 있던 모델 API 주소 권한을 다시 요청한다. 버튼을 누른 처리 안에서 불러야 허용 창이 뜬다. */
  async function grantLlm() {
    if (!llmGrant) return;
    const ok = await browser.permissions.request({ origins: [llmGrant] }).catch((e: Error) => {
      setLlmTest(`권한을 요청하지 못했습니다: ${e.message}. 회사 정책으로 막혀 있으면 IT에 문의해야 합니다`);
      return null;
    });
    if (ok === null) return;
    if (!ok) return setLlmTest('허용하지 않았습니다. 브라우저가 묻는 창에서 "허용"을 눌러야 합니다');
    setLlmGrant(null);
    await testLlm();
  }
  const [skillId, setSkillId] = useState(FREE_SKILL_ID);
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
  const [allowWrite, setAllowWrite] = useState(false);
  // 파일 입력에서 고른 파일 (입력 이름 → 파일)
  const [picked, setPicked] = useState<Record<string, File | undefined>>({});
  // 묶어 실행하기: 고른 엑셀, 행마다의 입력값, 지금까지의 결과, 지금 도는 행
  const [batch, setBatch] = useState<{ file: string; plan: BatchPlan; outcomes: BatchOutcome[]; at: number } | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const logEnd = useRef<HTMLDivElement>(null);

  // 자유 요청은 실행할 때 현재 탭의 주소로 다시 만든다. 여기서는 입력 폼을 그리는 용도다.
  const freeTemplate = useMemo(() => buildFreeSkill('http://localhost/', false), []);
  const isFree = skillId === FREE_SKILL_ID;
  const skill = isFree ? freeTemplate : skills.find((s) => s.id === skillId);

  async function syncShared(url: string, withLogin = false) {
    if (!url) return setShared(null);
    setShared(await loadShared(url));
    setSyncing(true);
    setSyncError('');
    try {
      setShared(await refreshShared(url, withLogin));
    } catch (e) {
      // 저장소에 닿지 않으면 받아 둔 스킬로 계속 쓴다.
      setSyncError((e as Error).message);
    } finally {
      setSyncing(false);
    }
  }

  useEffect(() => {
    loadSettings().then((s) => {
      setSettings(s);
      void syncShared(s.skillsUrl, s.skillsWithLogin);
    });
    void reloadDrafts();
  }, []);
  useEffect(() => {
    logEnd.current?.scrollIntoView({ block: 'end' });
  }, [events, result, question, approval]);

  async function plan() {
    if (!settings || !request.trim()) return;
    setPlanning(true);
    setNotice('');
    try {
      const p = await planRequest(request, bundled, new OpenAiCompatClient(effectiveSettings(settings)));
      if (!p.skill_id) {
        setSkillId(FREE_SKILL_ID);
        setForm({ request });
        setNotice('맞는 스킬이 없어 자유 요청으로 준비했습니다. 확인하고 실행을 누르세요.');
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
    setBatch(null);
    setRunning(true);
    await execute(skill, values);
    setRunning(false);
  }

  /** 엑셀을 고르면 행마다 입력값을 만들어 보여 준다. 실행은 사용자가 따로 누른다. */
  async function pickBatch(file: File | undefined) {
    setBatch(null);
    setNotice('');
    if (!file || !skill || isFree) return;
    try {
      const plan = planBatch(skill, await readTable(await file.arrayBuffer(), file.name), form);
      setBatch({ file: file.name, plan, outcomes: [], at: -1 });
    } catch (e) {
      setNotice(`${file.name}: ${(e as Error).message}`);
    }
  }

  /** 행마다 처음 화면에서 다시 시작해 한 건씩 돌린다. 승인·중지·기록은 한 건씩 돌릴 때와 같다. */
  async function runBatch() {
    if (!settings || !skill || !batch) return;
    setRunning(true);
    const startUrl = (await targetTab().catch(() => null))?.url;
    const outcomes: BatchOutcome[] = batch.plan.rows.map((row) => ({ row }));
    let stop = false;
    for (let i = 0; i < outcomes.length; i++) {
      const o = outcomes[i];
      if (o.row.errors.length || stop) continue;
      setBatch((b) => b && { ...b, outcomes: [...outcomes], at: i });
      if (i > 0 && startUrl) {
        const tab = await targetTab().catch(() => null);
        if (tab) await new ChromeBrowser(tab.id).navigate(startUrl).catch(() => {});
      }
      const res = await execute(skill, o.row.values);
      outcomes[i] = { ...o, result: res };
      stop = stopsBatch(res);
    }
    setBatch((b) => b && { ...b, outcomes, at: outcomes.length });
    setRunning(false);
  }

  async function downloadBatchReport() {
    if (!skill || !batch) return;
    const data = await buildWorkbook([{ name: '결과', dataset: batchReport(skill, batch.outcomes) }]);
    const base = batch.file.replace(/\.(xlsx|csv)$/i, '');
    download(`${base}_결과.xlsx`, data, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  }

  async function execute(skill: Skill, values: SkillInputs): Promise<RunResult> {
    if (!settings) throw new Error('설정을 읽지 못했습니다');
    // 파일 입력은 여기서 읽어 데이터셋으로 넣어 둔다. 파일 내용은 모델에 보내지 않는다.
    const datasets = new DatasetStore();
    for (const spec of skill.inputs) {
      const file = picked[spec.name];
      if (spec.type !== 'file' || !spec.dataset || !file) continue;
      try {
        const table = await readTable(await file.arrayBuffer(), file.name);
        datasets.set(spec.dataset, table.columns, table.rows);
      } catch (e) {
        const message = `${spec.label ?? spec.name}: ${(e as Error).message}`;
        setNotice(message);
        return { status: 'error', message, lastStep: 0, actions: 0, files: [], datasets: [], outputs: {}, elapsedMs: 0 };
      }
    }
    setNotice('');
    setEvents([]);
    setResult(null);
    setPreviews([]);

    const abort = new AbortController();
    abortRef.current = abort;
    const collected: RunEvent[] = [];
    const startedAt = new Date().toISOString();
    let tabUrl = '';
    let res: RunResult;
    try {
      const tab = await targetTab();
      tabUrl = tab.url;
      const active = isFree ? buildFreeSkill(tab.url, allowWrite) : skill;
      if (isFree) {
        const origin = `${new URL(tab.url).origin}/*`;
        if (!(await browser.permissions.contains({ origins: [origin] }))) {
          throw new Error(`이 사이트(${new URL(tab.url).host})는 Dogent의 허용 목록에 없습니다. dogent.config.ts의 sitePermissions에 추가해야 합니다`);
        }
      }
      // 느린 모델용 배율은 스킬의 전체 제한 시간에도 같이 적용한다.
      const scale = Math.max(1, settings.timeoutScale || 1);
      const scaled = { ...active, limits: { ...active.limits, timeout_sec: active.limits.timeout_sec * scale } };
      res = await runSkill(scaled, values, {
        llm: new OpenAiCompatClient(effectiveSettings(settings)),
        browser: new ChromeBrowser(tab.id),
        datasets,
        signal: abort.signal,
        dryRun: !isFree && skill.risk === 'R3' && dryRun,
        direct: settings.skillDirect,
        // 자유 요청은 매번 내용이 달라 다시 쓸 경로가 없다.
        paths: settings.pathCache && !isFree ? pathStore : undefined,
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
        // 로그인 화면을 만나면 사람이 로그인할 때까지 기다렸다가 이어 간다 (비밀번호는 에이전트가 입력하지 않음).
        loginWaitMs: LOGIN_WAIT_MS,
        onEvent(e) {
          collected.push(e);
          setEvents([...collected]);
          // 로그인할 화면을 사람 앞으로 가져온다.
          if (e.type === 'login_wait') void browser.tabs.update(tab.id, { active: true }).catch(() => {});
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
    // 초안이 끝까지 돌면 시험 실행 통과로 기록한다. 배포 요청의 조건 중 하나다.
    if (isDraft(skill.id) && (res.status === 'done' || res.status === 'dryrun')) {
      await markTrial(skill.id, res.status);
      await reloadDrafts();
    }
    await appendRun({
      id: crypto.randomUUID(),
      startedAt,
      skill: { id: skill.id, version: skill.version },
      inputs: values,
      tabUrl,
      events: collected,
      result: res,
    });
    return res;
  }

  async function exportLog() {
    const runs = await loadRuns();
    download(`dogent-log-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(runs, null, 2), 'application/json');
  }

  if (!settings) return null;

  return (
    <div className="app">
      <header>
        <h1 title="Dogent: Do-Agent, 업무를 대신 하는 에이전트">
          <img className="logo" src="/icon/dogent.svg" alt="" width={22} height={22} />
          Dogent
        </h1>
        <div className="header-actions">
          <button className="ghost" onClick={exportLog} title="실행 기록을 JSON으로 저장">
            기록 내보내기
          </button>
          <button className="ghost" id="open-inspect" disabled={running} onClick={() => setShowInspect((v) => !v)} title="지금 화면을 Dogent가 읽을 수 있는지 점검">
            화면 점검
          </button>
          <button className="ghost" id="open-settings" onClick={() => setShowSettings((v) => !v)}>
            설정
          </button>
        </div>
      </header>

      {showInspect && !running && <Inspect onClose={() => setShowInspect(false)} />}

      {showSettings && (
        <section className="card">
          <h2>모델 설정</h2>
          <p className="hint" id="build-mode">
            이 확장은 <b>{import.meta.env.MODE === 'production' ? '기본' : import.meta.env.MODE}</b> 설정으로 빌드되었습니다. 비워 두거나
            바꾸지 않은 칸은 빌드에 넣은 값을 씁니다.
          </p>
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
              placeholder={hasBuiltInKey ? '비워 두면 배포에 포함된 공용 키를 씁니다' : ''}
              onChange={(e) => setSettings({ ...settings, apiKey: e.target.value })}
            />
          </label>
          {builtInHeaders && (
            <p className="hint" id="llm-headers">
              이 배포는 사내 게이트웨이용 헤더로 부릅니다: {Object.keys(builtInHeaders).join(', ')}
            </p>
          )}
          <label>
            시스템 이름 (Send-System-Name)
            <input
              id="llm-system-name"
              value={settings.systemName ?? ''}
              placeholder="사내 게이트웨이에 등록한 이름"
              onChange={(e) => setSettings({ ...settings, systemName: e.target.value.trim() })}
            />
          </label>
          {placeholders.has('userId') && (
            <label>
              사용자 ID <span className="req">*</span>
              <input
                id="llm-user-id"
                value={settings.userId ?? ''}
                placeholder="사내 SSO ID"
                onChange={(e) => setSettings({ ...settings, userId: e.target.value.trim() })}
              />
            </label>
          )}
          {placeholders.has('userType') && (
            <label>
              사용자 유형 <span className="req">*</span>
              <input
                id="llm-user-type"
                value={settings.userType ?? ''}
                placeholder="API 제공 측에서 안내한 값"
                onChange={(e) => setSettings({ ...settings, userType: e.target.value.trim() })}
              />
            </label>
          )}
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
          <label className="check">
            <input
              type="checkbox"
              checked={settings.skillDirect}
              onChange={(e) => setSettings({ ...settings, skillDirect: e.target.checked })}
            />
            스킬에 인자가 적힌 단계는 모델 없이 바로 실행 (빠름)
          </label>
          <label className="check">
            <input
              type="checkbox"
              checked={settings.pathCache}
              onChange={(e) => setSettings({ ...settings, pathCache: e.target.checked })}
            />
            모델이 찾아 성공한 경로를 기억해 다음 실행에서 다시 사용
          </label>
          <button className="ghost" onClick={() => void clearPaths()}>
            기억한 경로 지우기
          </button>
          <p className="hint">기본은 응답 60초, 스킬별 전체 제한 시간입니다. 느린 로컬 모델이면 배율을 올리세요.</p>
          <p className="hint">API 주소를 여기서 바꾸면 그 호스트가 빌드의 허용 목록에 있어야 닿습니다. 새 주소는 환경 파일에 적고 다시 빌드하세요.</p>
          <Sites />
          <Connect />
          <label>
            공유 스킬 저장소 (index.json 주소)
            <input
              id="skills-url"
              value={settings.skillsUrl}
              onChange={(e) => setSettings({ ...settings, skillsUrl: e.target.value.trim() })}
              placeholder="비워 두면 확장에 든 스킬만 씁니다"
            />
          </label>
          <label className="check">
            <input
              id="skills-login"
              type="checkbox"
              checked={settings.skillsWithLogin ?? false}
              onChange={(e) => setSettings({ ...settings, skillsWithLogin: e.target.checked })}
            />
            브라우저 로그인으로 읽기 (사내 GitHub처럼 로그인해야 보이는 저장소)
          </label>
          <div className="row wrap">
            <button id="test-llm" className="secondary" disabled={llmTest === '시험하는 중…'} onClick={() => void testLlm()}>
              연결 시험
            </button>
          </div>
          {llmGrant && (
            <div className="row">
              <button id="grant-llm" onClick={() => void grantLlm()}>
                이 주소 접근 허용
              </button>
            </div>
          )}
          {llmTest && (
            <div id="llm-test" className={`notice ${llmTest.startsWith('연결됨') ? 'ok' : llmTest.startsWith('시험하는') ? '' : 'error'}`}>
              {llmTest}
            </div>
          )}
          <button
            className="ghost"
            id="reset-settings"
            onClick={async () => {
              setSettings(await resetSettings());
              setLlmTest('');
            }}
          >
            빌드 기본값으로 되돌리기
          </button>
          <button
            id="save-settings"
            onClick={async () => {
              await saveSettings(settings);
              void syncShared(settings.skillsUrl, settings.skillsWithLogin);
              setShowSettings(false);
            }}
          >
            저장
          </button>
        </section>
      )}

      <nav className="tabs">
        <button id="tab-run" className={tab === 'run' ? 'on' : ''} onClick={() => setTab('run')}>
          실행
        </button>
        <button id="tab-author" className={tab === 'author' ? 'on' : ''} disabled={running} onClick={() => setTab('author')}>
          스킬 만들기
        </button>
        <button id="tab-history" className={tab === 'history' ? 'on' : ''} disabled={running} onClick={() => setTab('history')}>
          기록
        </button>
      </nav>

      {tab === 'history' && <History names={Object.fromEntries([...skills.map((s) => [s.id, s.name]), [FREE_SKILL_ID, '자유 요청']])} />}

      {tab === 'author' && <Author bundledIds={bundled.map((s) => s.id)} drafts={drafts} onChange={reloadDrafts} llm={() => new OpenAiCompatClient(effectiveSettings(settings), undefined, 2048)} />}

      {skillErrors.map((e) => (
        <p key={e} className="notice error">
          {e}
        </p>
      ))}

      {tab === 'run' && (<>
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
              setPicked({});
              setBatch(null);
            }}
          >
            <option value={FREE_SKILL_ID}>자유 요청 (스킬 없이 현재 화면 조작)</option>
            {skills.map((s) => (
              <option key={s.id} value={s.id}>
                {isDraft(s.id) ? '[초안] ' : isShared(s.id) ? '[공유] ' : ''}
                {s.name} ({s.risk})
              </option>
            ))}
          </select>
        </label>
        {settings.skillsUrl && (
          <p className="hint" id="shared-status">
            {syncing
              ? '공유 스킬을 받는 중…'
              : shared
                ? `공유 스킬 ${shared.skills.length}개 · ${new Date(shared.syncedAt).toLocaleString('ko-KR')} 기준`
                : '공유 스킬을 받지 못했습니다'}{' '}
            <button className="ghost" id="sync-skills" disabled={syncing || running} onClick={() => void syncShared(settings.skillsUrl, settings.skillsWithLogin)}>
              다시 받기
            </button>
          </p>
        )}
        {syncError && <p className="notice error">{syncError}</p>}
        {shared?.errors.map((e) => (
          <p key={e} className="notice error">
            공유 스킬 {e}
          </p>
        ))}
        {skill && <p className="hint">{skill.description}</p>}
        {skill?.inputs.map((i) => (
          <label key={i.name}>
            {i.label ?? i.name}
            {i.required && <span className="req"> *</span>}
            {i.type === 'file' ? (
              <input
                data-input={i.name}
                type="file"
                accept=".xlsx,.csv"
                disabled={running}
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  setPicked((p) => ({ ...p, [i.name]: file }));
                  setForm({ ...form, [i.name]: file?.name ?? '' });
                }}
              />
            ) : i.type === 'enum' && i.values ? (
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
        {isFree && (
          <label className="check">
            <input
              id="allowWrite"
              type="checkbox"
              checked={allowWrite}
              disabled={running}
              onChange={(e) => setAllowWrite(e.target.checked)}
            />
            저장·상신 버튼 허용 (누르기 전에 승인을 묻습니다)
          </label>
        )}
        {!isFree && skill?.risk === 'R3' && (
          <label className="check">
            <input id="dryrun" type="checkbox" checked={dryRun} disabled={running} onChange={(e) => setDryRun(e.target.checked)} />
            시험 실행 (입력까지만 하고 저장·상신 직전에 멈춤)
          </label>
        )}
        {!isFree && skill && !skill.inputs.some((i) => i.type === 'file') && skill.inputs.length > 0 && (
          <details className="batch" open={batch !== null}>
            <summary>엑셀로 여러 건 한 번에 실행</summary>
            <p className="hint">
              첫 행에 입력 이름이나 라벨({skill.inputs.map((i) => i.label ?? i.name).join(', ')})을 적은 엑셀을 고르면 행마다 한 번씩 실행합니다. 엑셀에
              없는 입력은 위에 적은 값을 모든 행에 씁니다.{skill.risk === 'R3' ? ' 저장·상신은 행마다 승인을 받습니다.' : ''}
            </p>
            <input
              id="batch-file"
              type="file"
              accept=".xlsx,.csv"
              disabled={running}
              onChange={(e) => {
                void pickBatch(e.target.files?.[0]);
                e.target.value = '';
              }}
            />
          </details>
        )}
        {batch && <BatchView batch={batch} running={running} onReport={downloadBatchReport} onClear={() => setBatch(null)} />}
        <div className="row">
          {running ? (
            <button id="stop" className="danger" onClick={() => abortRef.current?.abort()}>
              중지
            </button>
          ) : batch && batch.at < 0 ? (
            <button id="batch-run" onClick={runBatch} disabled={batch.plan.rows.every((r) => r.errors.length > 0)}>
              {batch.plan.rows.filter((r) => r.errors.length === 0).length}건 실행
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
                      {h.by === 'skill' && <span className="chip">모델 호출 없음</span>}
                      {h.by === 'cache' && <span className="chip">기억한 경로</span>}
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
              if (e.type === 'login_wait') {
                return (
                  <li key={i} className="fail">
                    로그인 화면을 만나 기다림: {e.url}
                  </li>
                );
              }
              if (e.type === 'login_done') {
                return (
                  <li key={i} className="minor">
                    로그인됨, 이어서 진행
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

          {running && events.at(-1)?.type === 'login_wait' && (
            <div id="login-wait" className="notice login-wait">
              <b>로그인이 필요합니다</b>
              <p>
                업무 화면 탭에서 직접 로그인해 주세요. 로그인되면 그 자리에서 이어서 진행합니다. Dogent는 비밀번호를 입력하지 않습니다.
              </p>
              <p className="hint">
                {Math.round(((events.at(-1) as Extract<RunEvent, { type: 'login_wait' }>).timeoutSec ?? 300) / 60)}분 안에 로그인하지 않으면 멈춥니다. 그만두려면 중지를 누르세요.
              </p>
            </div>
          )}

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
              {approval.request.tables.map((t) => (
                <div key={t.name} className="approval-table">
                  <p>
                    <b>{t.name}</b> · {t.rowCount}행 · 화면 값이 원본과 일치함
                  </p>
                  <div className="tablewrap">
                    <table>
                      <thead>
                        <tr>
                          {t.columns.map((c) => (
                            <th key={c}>{c}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {t.preview.map((r, i) => (
                          <tr key={i}>
                            {r.map((c, j) => (
                              <td key={j}>{c}</td>
                            ))}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  {t.rowCount > t.preview.length && <p className="hint">처음 {t.preview.length}행만 표시</p>}
                </div>
              ))}
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
      </>)}
    </div>
  );
}
