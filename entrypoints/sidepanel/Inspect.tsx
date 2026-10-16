import { useEffect, useState } from 'react';
import { browser } from 'wxt/browser';
import { VERDICT_LABEL, diagnose, renderInspection, type SiteInspection } from '@/src/core';
import { ChromeBrowser } from '@/src/ext/browser';
import { download, targetTab } from './util';

const LEVEL_LABEL = { fail: '막힘', warn: '확인', ok: '정상', info: '참고' } as const;

/**
 * 화면 점검. 사내 화면을 처음 다룰 때, 녹화하기 전에 에이전트가 그 화면을 읽을 수 있는지 본다.
 * 결과는 보고서로 받아 개발 담당에게 보낼 수 있고, 화면 글자와 주소를 가릴 수 있다.
 */
export function Inspect({ onClose }: { onClose: () => void }) {
  const [site, setSite] = useState<SiteInspection | null>(null);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState('');
  const [hide, setHide] = useState(true);
  const [copied, setCopied] = useState(false);

  async function check() {
    setChecking(true);
    setError('');
    try {
      const tab = await targetTab();
      setSite(await new ChromeBrowser(tab.id).inspect());
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setChecking(false);
    }
  }

  useEffect(() => {
    void check();
  }, []);

  const report = () => renderInspection(site!, { hide, version: browser.runtime.getManifest().version });

  async function copy() {
    await navigator.clipboard.writeText(report()).then(
      () => setCopied(true),
      () => setError('복사하지 못했습니다. 보고서 내려받기를 쓰세요'),
    );
    setTimeout(() => setCopied(false), 1500);
  }

  const result = site ? diagnose(site) : null;

  return (
    <section className="card" id="inspect">
      <h2>화면 점검</h2>
      <p className="hint">
        지금 탭의 화면을 Dogent가 읽을 수 있는지 봅니다. 사내 화면에서 스킬을 녹화하기 전에 먼저 돌려 보세요. 화면을
        바꾸지 않습니다.
      </p>
      {checking && <p className="hint">점검하는 중…</p>}
      {error && <div className="notice error">{error}</div>}
      {result && site && !checking && (
        <>
          <div id="inspect-verdict" className={`lint verdict-${result.verdict}`} data-verdict={result.verdict}>
            <b>{VERDICT_LABEL[result.verdict]}</b>
          </div>
          <ul className="inspect-list">
            {result.findings.map((f, i) => (
              <li key={i} className={f.level}>
                <span className={`chip level-${f.level}`}>{LEVEL_LABEL[f.level]}</span>
                <div>
                  <b>{f.title}</b>
                  {f.detail && <p>{f.detail}</p>}
                  {f.fix && <p className="fix">{f.fix}</p>}
                </div>
              </li>
            ))}
          </ul>
          <label className="check">
            <input id="inspect-hide" type="checkbox" checked={hide} onChange={(e) => setHide(e.target.checked)} />
            보고서에서 화면 글자(라벨·머리글·버튼 이름)와 주소 가리기
          </label>
          <p className="hint">입력값과 표의 값은 가리기와 상관없이 보고서에 넣지 않습니다.</p>
        </>
      )}
      <div className="row wrap">
        <button className="secondary" onClick={() => void check()} disabled={checking}>
          다시 점검
        </button>
        {site && (
          <>
            <button
              id="inspect-report"
              className="secondary"
              disabled={checking}
              onClick={() =>
                download(`dogent-화면점검-${new Date().toISOString().slice(0, 10)}.md`, report(), 'text/markdown')
              }
            >
              보고서 내려받기
            </button>
            <button className="secondary" disabled={checking} onClick={() => void copy()}>
              {copied ? '복사됨' : '보고서 복사'}
            </button>
          </>
        )}
        <button className="ghost" onClick={onClose}>
          닫기
        </button>
      </div>
    </section>
  );
}
