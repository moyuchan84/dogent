import type { ConfirmPolicy, PageDialog } from '../core/types';

export type DialogCommand =
  | { do: 'boot' }
  | { do: 'on'; until: number }
  | { do: 'off' }
  | { do: 'policy'; confirm: ConfirmPolicy | null }
  | { do: 'drain' };

/**
 * 브라우저의 알림(alert)·확인(confirm)·입력(prompt) 창을 대신 받는다.
 *
 * 이 창들이 뜨면 페이지가 멈춰 에이전트가 화면을 읽을 수 없으므로, 에이전트가 조작하는 동안에만
 * 창을 띄우지 않고 내용을 기록해 둔다. 알림은 그대로 넘기고, 확인 창은 정해 준 방법대로 답하며
 * (기본은 취소), 입력 창은 취소한다.
 *
 * 페이지의 main world에서 실행된다. 직렬화되어 주입되므로 바깥 변수를 쓰지 않는다.
 * 켜져 있다는 표시는 sessionStorage에 만료 시각으로 둔다. 탭마다 따로이고 그 탭이 연 창에는
 * 이어지므로, 이동하거나 새로 열린 화면에서도 'boot'로 바로 다시 걸 수 있다.
 */
export function dialogHook(command: DialogCommand): PageDialog[] | null {
  const KEY = '__dogent_dialogs_until';
  const w = window as any;
  const flag = (value: number | null) => {
    try {
      if (value === null) w.sessionStorage.removeItem(KEY);
      else w.sessionStorage.setItem(KEY, String(value));
    } catch {
      // 저장소를 쓸 수 없는 프레임은 화면을 읽을 때마다 다시 건다.
    }
  };
  const install = () => {
    if (w.__dogentDialogs) return;
    const state = {
      log: [] as PageDialog[],
      confirm: null as ConfirmPolicy | null,
      original: { alert: w.alert, confirm: w.confirm, prompt: w.prompt },
    };
    w.__dogentDialogs = state;
    w.alert = (message?: unknown) => {
      state.log.push({ kind: 'alert', message: String(message ?? ''), accepted: true });
    };
    w.confirm = (message?: unknown) => {
      const text = String(message ?? '');
      const p = state.confirm;
      const accepted = !!p && p.accept && !(p.unless && new RegExp(p.unless, 'i').test(text));
      state.log.push({ kind: 'confirm', message: text, accepted });
      return accepted;
    };
    w.prompt = (message?: unknown) => {
      state.log.push({ kind: 'prompt', message: String(message ?? ''), accepted: false });
      return null;
    };
  };

  switch (command.do) {
    case 'boot': {
      let until = 0;
      try {
        until = Number(w.sessionStorage.getItem(KEY) ?? 0);
      } catch {
        // 위와 같다.
      }
      if (until > Date.now()) install();
      return null;
    }
    case 'on':
      flag(command.until);
      install();
      return null;
    case 'off': {
      flag(null);
      const state = w.__dogentDialogs;
      if (state) {
        w.alert = state.original.alert;
        w.confirm = state.original.confirm;
        w.prompt = state.original.prompt;
        delete w.__dogentDialogs;
      }
      return null;
    }
    case 'policy':
      if (w.__dogentDialogs) w.__dogentDialogs.confirm = command.confirm;
      return null;
    case 'drain': {
      const state = w.__dogentDialogs;
      return state ? state.log.splice(0) : [];
    }
  }
}
