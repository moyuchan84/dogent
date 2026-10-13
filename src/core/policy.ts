import type { Action } from './actions';
import type { Skill } from './skill';
import type { ElementItem, PageSnapshot } from './types';

/**
 * 저장·상신처럼 되돌리기 어려운 동작(R3)으로 보는 버튼 라벨.
 * 모델 판단에 맡기지 않고 라벨 규칙으로 판정한다.
 */
export const SUBMIT_PATTERN =
  /(저장|상신|제출|삭제|승인|결재|등록|확정|반려|submit|save|delete|remove|approve)/i;

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
function optionsOf(el: ElementItem): string[] | null {
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
  if (
    action.tool !== 'click' &&
    action.tool !== 'type' &&
    action.tool !== 'select' &&
    action.tool !== 'extract_table' &&
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
