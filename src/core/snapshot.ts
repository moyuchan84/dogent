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
