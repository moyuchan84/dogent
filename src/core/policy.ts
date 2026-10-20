import type { Action } from './actions';
import type { Skill } from './skill';
import type { ElementItem, PageSnapshot } from './types';

/**
 * 저장·상신처럼 되돌리기 어려운 동작(R3)으로 보는 버튼 라벨.
 * 모델 판단에 맡기지 않고 라벨 규칙으로 판정한다.
 */
export const SUBMIT_PATTERN =
  /(저장|상신|제출|삭제|승인|결재|등록|확정|반려|submit|save|delete|remove|approve)/i;

/** 파일을 내려받는 버튼으로 보는 라벨 */
const DOWNLOAD_PATTERN = /(엑셀|excel|xlsx?|csv|다운로드|내려받|내보내|download|export)/i;

/**
 * download_table로 누를 수 없는 버튼이면 이유를 돌려준다.
 * "엑셀 저장"처럼 내려받기를 뜻하는 저장만 허용하고, 그 밖의 저장·상신 계열("엑셀 등록" 등)은 막는다.
 */
export function downloadBlocked(name: string): string | null {
  if (!SUBMIT_PATTERN.test(name)) return null;
  const rest = name.replace(/저장|save/gi, '');
  if (DOWNLOAD_PATTERN.test(name) && !SUBMIT_PATTERN.test(rest)) return null;
  return `"${name.trim()}"은(는) 저장·상신 계열이라 내려받기 버튼으로 쓸 수 없습니다`;
}

/**
 * 녹화한 클릭이 파일 내려받기로 보이는지. 초안에서 그 단계를 download_table로 만들 때 쓴다.
 * "엑셀 업로드"처럼 엑셀이라는 글자만 있는 버튼은 내려받기로 보지 않는다.
 */
export function looksLikeDownload(name: string): boolean {
  if (downloadBlocked(name)) return false;
  return /(다운로드|내려받|내보내|download|export)/i.test(name) || /(엑셀|excel|xlsx|csv)\s*(저장|save)?\s*$/i.test(name);
}

/** 패턴 예: "mes.example.internal", "localhost:4173", "*.example.internal" */
export function hostAllowed(url: string, patterns: string[]): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
  return patterns.some((p) => {
    const target = p.includes(':') ? u.host : u.hostname;
    if (p.startsWith('*.')) return target.endsWith(p.slice(1));
    return target === p;
  });
}

export function findElement(snap: PageSnapshot, ref: number): ElementItem | undefined {
  return snap.items.find((i): i is ElementItem => i.kind === 'el' && i.ref === ref);
}

/** 스냅샷의 options=[a, b, …] 표기에서 옵션 목록을 꺼낸다. 목록이 잘렸거나 없으면 null. */
export function optionsOf(el: ElementItem): string[] | null {
  const m = /^options=\[(.*)\]$/.exec(el.detail ?? '');
  if (!m || m[1].endsWith('…')) return null;
  return m[1].split(', ');
}

/** approval이 있으면 실행 전에 사용자 승인을 받아야 하는 동작이다. */
export type Verdict = { ok: true; approval?: ElementItem } | { ok: false; reason: string };

export function checkAction(action: Action, snap: PageSnapshot, skill: Skill): Verdict {
  if (action.tool === 'navigate') {
    // 이미 열려 있는 화면(iframe 안 포함)으로 다시 이동하면 입력한 조건이 사라진다.
    const bare = (u: string) => u.split('#')[0];
    const open = [snap.url, ...snap.items.flatMap((i) => (i.kind === 'frame' ? [i.url] : []))];
    if (open.some((u) => bare(u) === bare(action.args.url))) {
      return { ok: false, reason: '이 화면은 이미 열려 있습니다. 이동하지 말고 다음 단계를 진행하세요' };
    }
    return hostAllowed(action.args.url, skill.domains)
      ? { ok: true }
      : {
          ok: false,
          reason: `${action.args.url} 은(는) 이 스킬의 허용 도메인(${skill.domains.join(', ')})이 아닙니다`,
        };
  }
  // 새 탭도 허용 도메인 안의 주소만 연다 (이미 열려 있는 화면을 또 여는 것은 막지 않는다. 탭마다 따로 조작한다)
  if (action.tool === 'open_tab') {
    return hostAllowed(action.args.url, skill.domains)
      ? { ok: true }
      : { ok: false, reason: `${action.args.url} 은(는) 이 스킬의 허용 도메인(${skill.domains.join(', ')})이 아닙니다` };
  }
  // 열린 엑셀 문서를 바꾸거나 열린 곳에 저장하는 것은 저장·상신 허용(R3)일 때만 한다. 읽기와 다른 이름 저장은 늘 된다.
  if ((action.tool === 'excel_write' || (action.tool === 'excel_save' && !action.args.path)) && skill.risk !== 'R3') {
    return { ok: false, reason: '엑셀 문서를 바꾸거나 열린 곳에 저장하려면 저장·상신 허용(--allow-write) 또는 R3 스킬이어야 합니다. 다른 이름으로 저장(path)은 됩니다' };
  }
  // 화면의 글을 읽는 동작도 허용 도메인 안에서만 한다.
  if (action.tool === 'read_text' || (action.tool === 'summarize' && action.args.source === 'page')) {
    if (!hostAllowed(snap.url, skill.domains)) {
      return { ok: false, reason: `현재 페이지(${snap.url})는 허용 도메인 밖이라 글을 읽지 않습니다` };
    }
    if (action.tool === 'read_text' && action.args.ref !== undefined && !findElement(snap, action.args.ref)) {
      return { ok: false, reason: `ref ${action.args.ref} 이(가) 현재 화면에 없습니다` };
    }
    return { ok: true };
  }
  if (
    action.tool !== 'click' &&
    action.tool !== 'type' &&
    action.tool !== 'select' &&
    action.tool !== 'extract_table' &&
    action.tool !== 'download_table' &&
    action.tool !== 'fill_table' &&
    action.tool !== 'wait_for'
  ) {
    return { ok: true };
  }

  if (!hostAllowed(snap.url, skill.domains)) {
    return {
      ok: false,
      reason: `현재 페이지(${snap.url})는 허용 도메인 밖입니다. navigate로 허용된 화면에 먼저 이동해야 합니다`,
    };
  }
  if (action.tool === 'wait_for') return { ok: true };

  const el = findElement(snap, action.args.ref);
  if (!el) return { ok: false, reason: `ref ${action.args.ref} 이(가) 현재 화면에 없습니다` };
  if (el.disabled) return { ok: false, reason: `[${el.ref}] "${el.name}"은(는) 비활성 상태입니다` };

  if (action.tool === 'select') {
    // 엉뚱한 선택 상자를 고른 경우, 그 값이 있는 상자를 알려준다.
    const want = action.args.value.trim();
    const mine = optionsOf(el);
    if (mine && !mine.some((o) => o === want || o.includes(want))) {
      const others = snap.items.filter(
        (i): i is ElementItem => i.kind === 'el' && i !== el && !!optionsOf(i)?.includes(want),
      );
      const hint =
        others.length > 0
          ? ` 이 값은 ${others.map((o) => `[${o.ref}] ${o.role} "${o.name}"`).join(', ')}에 있습니다`
          : ` 가능한 값: ${mine.join(', ')}`;
      return { ok: false, reason: `[${el.ref}] ${el.role} "${el.name}"에는 "${want}" 옵션이 없습니다.${hint}` };
    }
  }

  if (action.tool === 'click' && SUBMIT_PATTERN.test(el.name)) {
    // 저장·상신 계열(R3)은 스킬이 선언한 단계에서, 선언한 버튼만, 사용자 승인을 거쳐 누를 수 있다.
    if (skill.risk !== 'R3') {
      return { ok: false, reason: `"${el.name}"은(는) 저장·상신 계열 동작입니다. 이 스킬은 조회 전용이라 실행하지 않습니다` };
    }
    if (!skill.submit_steps.includes(action.step)) {
      return {
        ok: false,
        reason: `"${el.name}"은(는) 저장·상신 계열 동작입니다. ${skill.submit_steps.join(', ')}단계에서만 누를 수 있습니다 (지금은 ${action.step}단계)`,
      };
    }
    if (skill.submit_labels.length > 0 && !skill.submit_labels.includes(el.name.trim())) {
      return {
        ok: false,
        reason: `"${el.name}"은(는) 이 스킬이 누를 수 있는 버튼(${skill.submit_labels.join(', ')})이 아닙니다`,
      };
    }
    return { ok: true, approval: el };
  }
  if (action.tool === 'download_table') {
    const blocked = downloadBlocked(el.name);
    if (blocked) return { ok: false, reason: blocked };
  }
  if (action.tool === 'fill_table') {
    if (el.role !== 'table') return { ok: false, reason: `[${el.ref}]은(는) 표가 아닙니다 (role=${el.role})` };
    // 업무 데이터를 화면에 넣는 동작(R2)은 그 등급 이상을 선언한 스킬만 할 수 있다.
    if (skill.risk !== 'R2' && skill.risk !== 'R3') {
      return { ok: false, reason: '이 스킬은 조회 전용이라 표에 값을 입력할 수 없습니다' };
    }
    if (action.args.add_ref !== undefined) {
      const add = findElement(snap, action.args.add_ref);
      if (!add) return { ok: false, reason: `add_ref ${action.args.add_ref} 이(가) 현재 화면에 없습니다` };
      if (SUBMIT_PATTERN.test(add.name)) {
        return { ok: false, reason: `"${add.name}"은(는) 저장·상신 계열이라 행 추가 버튼으로 쓸 수 없습니다` };
      }
    }
  }
  if (action.tool === 'extract_table') {
    if (el.role !== 'table') return { ok: false, reason: `[${el.ref}]은(는) 표가 아닙니다 (role=${el.role})` };
    if (action.args.next_ref !== undefined) {
      const next = findElement(snap, action.args.next_ref);
      if (!next) return { ok: false, reason: `next_ref ${action.args.next_ref} 이(가) 현재 화면에 없습니다` };
      if (SUBMIT_PATTERN.test(next.name)) {
        return { ok: false, reason: `"${next.name}"은(는) 저장·상신 계열이라 페이지 넘김 버튼으로 쓸 수 없습니다` };
      }
    }
  }
  return { ok: true };
}
