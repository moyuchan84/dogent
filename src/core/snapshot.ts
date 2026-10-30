import type { FrameSnapshot, PageSnapshot, SnapshotItem } from './types';

/**
 * 프레임별 스냅샷을 하나로 합치며 ref를 탭 전체에서 유일한 번호로 다시 매긴다.
 * 돌려주는 refs로 전역 ref에서 (프레임, 프레임 내 ref)를 찾는다.
 */
export function mergeFrames<F>(
  frames: { frame: F; snap: FrameSnapshot }[],
): { snapshot: PageSnapshot; refs: Map<number, { frame: F; localRef: number }> } {
  const refs = new Map<number, { frame: F; localRef: number }>();
  const items: SnapshotItem[] = [];
  let next = 1;
  frames.forEach(({ frame, snap }, idx) => {
    if (idx > 0) items.push({ kind: 'frame', url: snap.url });
    for (const item of snap.items) {
      if (item.kind === 'el') {
        refs.set(next, { frame, localRef: item.ref });
        items.push({ ...item, ref: next++ });
      } else items.push(item);
    }
    if (snap.truncated) items.push({ kind: 'text', text: '(이 프레임의 나머지 요소는 생략됨)' });
  });
  const top = frames[0]?.snap;
  return {
    snapshot: {
      url: top?.url ?? '',
      title: top?.title ?? '',
      hasPassword: frames.some((f) => f.snap.hasPassword),
      items,
    },
    refs,
  };
}

function quote(s: string): string {
  return JSON.stringify(s);
}

/**
 * 화면에서 말에 맞는 요소만 고른다 (Claude in Chrome의 find처럼). 말의 낱말이 이름·값·설명·행·역할에 많이 들어 있는 순서다.
 * 요소가 많아 화면 읽기가 잘린 경우에도 ref를 찾을 수 있게 한다.
 */
export function findInSnapshot(snap: PageSnapshot, query: string, limit = 20): string {
  const words = query.toLowerCase().split(/[\s,]+/).filter(Boolean);
  const scored = snap.items.flatMap((item) => {
    if (item.kind !== 'el') return [];
    const hay = [item.name, item.value, item.detail, item.row, item.role].filter(Boolean).join(' ').toLowerCase();
    const score = words.filter((w) => hay.includes(w)).length;
    return score > 0 ? [{ item, score }] : [];
  });
  if (scored.length === 0) return `"${query}"에 맞는 요소가 화면에 없습니다. 화면을 내리거나(scroll) 다른 말로 찾아보세요`;
  scored.sort((a, b) => b.score - a.score);
  const hits = scored.slice(0, limit).map((s) => s.item);
  const lines = renderSnapshot({ ...snap, items: hits }).split('\n').slice(1);
  return `"${query}"에 맞는 요소 ${scored.length}개${scored.length > limit ? ` (앞의 ${limit}개)` : ''}\n${lines.join('\n')}`;
}

export function renderSnapshot(snap: PageSnapshot, maxChars = 12000): string {
  const lines = [`[page] ${snap.title} — ${snap.url}`];
  for (const item of snap.items) {
    if (item.kind === 'frame') lines.push(`--- frame: ${item.url} ---`);
    else if (item.kind === 'heading') lines.push(`# ${item.text}`);
    else if (item.kind === 'text') lines.push(item.text);
    else {
      let line = `[${item.ref}] ${item.role} ${quote(item.name)}`;
      if (item.value !== undefined) line += ` value=${quote(item.value)}`;
      if (item.detail) line += ` ${item.detail}`;
      if (item.row) line += ` row=${quote(item.row)}`;
      if (item.disabled) line += ' (비활성)';
      lines.push(line);
    }
  }
  const text = lines.join('\n');
  return text.length <= maxChars ? text : `${text.slice(0, maxChars)}\n(이하 생략)`;
}
