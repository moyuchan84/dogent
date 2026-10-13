import { browser } from 'wxt/browser';
import { syncSkills, type SharedSkill } from '../core/shared';

const SHARED_KEY = 'sharedSkills';

/** 마지막으로 받아 둔 공유 스킬. 저장소에 닿지 않을 때는 이것을 쓴다. */
export interface SharedState {
  /** 받아 온 목록의 주소. 주소가 바뀌면 받아 둔 것을 쓰지 않는다. */
  url: string;
  syncedAt: string;
  skills: SharedSkill[];
  errors: string[];
}

export async function loadShared(url: string): Promise<SharedState | null> {
  const state = (await browser.storage.local.get(SHARED_KEY))[SHARED_KEY] as SharedState | undefined;
  return state && state.url === url ? state : null;
}

async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * 저장소에서 스킬을 다시 받아 저장한다. 목록을 읽지 못하면 던지고, 받아 둔 것은 그대로 둔다.
 * 로그인 정보는 보내지 않는다. 저장소는 사내망에서 로그인 없이 읽을 수 있어야 한다.
 */
export async function refreshShared(url: string): Promise<SharedState> {
  const result = await syncSkills(url, {
    sha256,
    async fetchText(target) {
      const res = await fetch(target, { cache: 'no-store', credentials: 'omit' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.text();
    },
  });
  const state: SharedState = { url, syncedAt: new Date().toISOString(), ...result };
  await browser.storage.local.set({ [SHARED_KEY]: state });
  return state;
}
