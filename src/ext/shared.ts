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
 * withLogin이 꺼져 있으면 로그인 정보를 보내지 않으므로 저장소가 로그인 없이 읽혀야 한다.
 * 켜면 브라우저에 로그인된 세션(쿠키)으로 읽는다. 사내 GitHub의 비공개 저장소가 그렇다.
 */
export async function refreshShared(url: string, withLogin = false): Promise<SharedState> {
  const result = await syncSkills(url, {
    sha256,
    async fetchText(target) {
      const res = await fetch(target, { cache: 'no-store', credentials: withLogin ? 'include' : 'omit' }).catch((e: Error) => {
        throw new Error(`${e.message}. 저장소 주소의 호스트(파일이 다른 호스트로 넘어가면 그 호스트도)가 조작할 사이트 목록에 있어야 합니다`);
      });
      // 로그인 화면으로 넘어가면 HTML이 온다. 목록이나 스킬 대신 로그인 화면을 읽은 것이다.
      if (res.ok && /text\/html/i.test(res.headers.get('content-type') ?? '') && !target.endsWith('.html')) {
        throw new Error(withLogin ? '로그인 화면이 왔습니다. 브라우저에서 저장소 사이트에 먼저 로그인하세요' : '로그인 화면이 왔습니다. 설정에서 "브라우저 로그인으로 읽기"를 켜세요');
      }
      if (!res.ok) throw new Error(res.status === 401 || res.status === 403 || res.status === 404 ? `HTTP ${res.status}. 비공개 저장소라면 설정에서 "브라우저 로그인으로 읽기"를 켜고 브라우저에서 로그인하세요` : `HTTP ${res.status}`);
      return res.text();
    },
  });
  const state: SharedState = { url, syncedAt: new Date().toISOString(), ...result };
  await browser.storage.local.set({ [SHARED_KEY]: state });
  return state;
}
