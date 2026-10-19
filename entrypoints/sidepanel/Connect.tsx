import { useEffect, useState } from 'react';
import { browser } from 'wxt/browser';
import {
  BRIDGE_SETTINGS_KEY,
  BRIDGE_STATUS_KEY,
  loadBridgeSettings,
  type BridgeMode,
  type BridgeSettings,
  type BridgeStatus,
} from '@/src/ext/bridge';

const STATE_LABEL: Record<BridgeStatus['state'], string> = {
  off: '꺼짐',
  connecting: '연결 중',
  connected: '연결됨',
  error: '연결 안 됨',
};

/**
 * 클라이언트 연결. 외부 MCP 클라이언트(Claude Code, Dogent 클라이언트)가 브리지를 거쳐 이 브라우저를 조작하게 한다.
 * 연결은 백그라운드가 맺고, 여기서는 설정을 저장하고 상태를 보여 준다.
 */
export function Connect() {
  const [s, setS] = useState<BridgeSettings | null>(null);
  const [status, setStatus] = useState<BridgeStatus | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    void loadBridgeSettings().then(setS);
    void browser.storage.local.get(BRIDGE_STATUS_KEY).then((r) => setStatus((r[BRIDGE_STATUS_KEY] as BridgeStatus) ?? null));
    const onChange = (changes: Record<string, { newValue?: unknown }>, area: string) => {
      if (area === 'local' && changes[BRIDGE_STATUS_KEY]) setStatus((changes[BRIDGE_STATUS_KEY].newValue as BridgeStatus) ?? null);
    };
    browser.storage.onChanged.addListener(onChange);
    return () => browser.storage.onChanged.removeListener(onChange);
  }, []);

  if (!s) return null;
  const save = async () => {
    await browser.storage.local.set({ [BRIDGE_SETTINGS_KEY]: { ...s, token: s.token.trim() } });
    setSaved(true);
    setTimeout(() => setSaved(false), 1500);
  };
  const id = browser.runtime.id;
  const state = status?.state ?? 'off';

  return (
    <div className="connect" id="connect">
      <h3>클라이언트 연결</h3>
      <p className="hint">
        Claude Code나 Dogent 클라이언트 같은 MCP 클라이언트가 이 브라우저를 조작하게 합니다. 조작할 사이트와 저장·상신 승인은 그대로 적용됩니다.
      </p>
      <div className="row wrap" role="radiogroup" aria-label="연결 방식">
        {(
          [
            ['off', '끔'],
            ['native', 'Native Messaging'],
            ['ws', 'WebSocket'],
          ] as [BridgeMode, string][]
        ).map(([mode, label]) => (
          <label key={mode} className="check">
            <input type="radio" name="bridge-mode" data-mode={mode} checked={s.mode === mode} onChange={() => setS({ ...s, mode })} />
            {label}
          </label>
        ))}
      </div>
      {s.mode === 'ws' && (
        <label>
          포트
          <input id="bridge-port" type="number" value={s.port} onChange={(e) => setS({ ...s, port: Number(e.target.value) || s.port })} />
        </label>
      )}
      {s.mode !== 'off' && (
        <label>
          토큰
          <input
            id="bridge-token"
            type="password"
            value={s.token}
            placeholder="pnpm bridge:token 으로 나오는 값"
            onChange={(e) => setS({ ...s, token: e.target.value })}
          />
        </label>
      )}
      {s.mode !== 'off' && (
        <label>
          이 브라우저 이름
          <input
            id="bridge-label"
            value={s.label ?? ''}
            placeholder="비우면 브라우저 이름 (예: 업무용 크롬, 엣지)"
            onChange={(e) => setS({ ...s, label: e.target.value })}
          />
          <span className="hint">크롬·엣지처럼 Dogent가 든 브라우저가 여럿이면, 클라이언트에서 이 이름으로 고릅니다.</span>
        </label>
      )}
      <div className="row">
        <button id="bridge-save" className="secondary" onClick={() => void save()}>
          {saved ? '저장됨' : '연결 설정 저장'}
        </button>
        <span id="bridge-status" className={`chip bridge-${state}`} data-state={state}>
          {STATE_LABEL[state]}
        </span>
      </div>
      {status?.detail && <p className="hint">{status.detail}</p>}
      {s.mode === 'native' && (
        <p className="hint">
          호스트 등록이 필요합니다. Dogent 앱을 한 번 실행하면 자동으로 등록됩니다. 앱 없이 터미널 클라이언트만 쓴다면 <code>dogent doctor --fix --id {id}</code> 를 실행하세요. 그래도 안 붙으면 <code>dogent doctor</code> 가 원인을 알려 줍니다 (개발 PC는 <code>pnpm bridge:install --id {id}</code>).
        </p>
      )}
      {s.mode !== 'off' && (
        <p className="hint">
          MCP 클라이언트에 브리지를 등록: <code>claude mcp add dogent -- node (저장소)/bridge/hub.mjs</code>
        </p>
      )}
      <p className="hint">이 확장의 ID: <code id="ext-id">{id}</code></p>
    </div>
  );
}
