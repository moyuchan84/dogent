import { useEffect, useState } from 'react';
import { BUILT_IN_SITES, SITE_SCOPE, addedSites, removeSite, requestSites } from '@/src/ext/sites';

/**
 * 에이전트가 조작할 사이트 목록. 빌드에 든 사이트는 지울 수 없고, 그 밖의 사이트는 크롬 권한 요청으로 더하고 뺀다.
 * 다시 빌드하지 않아도 바로 쓸 수 있다.
 */
export function Sites() {
  const [added, setAdded] = useState<string[]>([]);
  const [input, setInput] = useState('');
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  const reload = () => addedSites().then(setAdded, () => setAdded([]));
  useEffect(() => {
    void reload();
  }, []);

  async function add() {
    setMessage(null);
    try {
      const patterns = await requestSites([input]);
      setInput('');
      setMessage({ ok: true, text: `${patterns.join(', ')}을(를) 더했습니다. 열려 있는 그 사이트 탭은 새로고침하세요` });
    } catch (e) {
      setMessage({ ok: false, text: (e as Error).message });
    }
    await reload();
  }

  async function remove(pattern: string) {
    await removeSite(pattern);
    setMessage({ ok: true, text: `${pattern}을(를) 뺐습니다` });
    await reload();
  }

  const anySite = SITE_SCOPE.some((s) => s === 'http://*/*' || s === 'https://*/*');
  return (
    <div className="sites" id="sites">
      <h3>조작할 사이트</h3>
      <ul className="site-list">
        {BUILT_IN_SITES.map((p) => (
          <li key={p}>
            <code>{p}</code>
            <span className="chip">빌드에 포함</span>
          </li>
        ))}
        {added.map((p) => (
          <li key={p} data-site={p}>
            <code>{p}</code>
            <button className="ghost" onClick={() => void remove(p)}>
              빼기
            </button>
          </li>
        ))}
      </ul>
      <div className="row">
        <input
          id="site-input"
          value={input}
          placeholder="예: mes.example.com 또는 업무 화면 주소"
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && input.trim()) void add();
          }}
        />
        <button id="site-add" className="secondary" disabled={!input.trim()} onClick={() => void add()}>
          추가
        </button>
      </div>
      {message && <div className={`notice ${message.ok ? 'ok' : 'error'}`}>{message.text}</div>}
      <p className="hint">
        추가하면 크롬이 허용할지 묻습니다. 다시 빌드할 필요가 없습니다.
        {anySite ? '' : ` 이 배포에서 더할 수 있는 범위: ${SITE_SCOPE.join(', ')}`}
      </p>
    </div>
  );
}
