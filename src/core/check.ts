import type { DatasetStore } from './dataset';
import type { PageSnapshot } from './types';

/**
 * 단계의 "검사:" 줄. 모델의 판단 대신 규칙으로 단계 완료를 판정한다.
 *
 *   - 검사: value("라인") == "{line}"
 *   - 검사: did("click") and no_text("조회 중") and text("총")
 *   - 검사: rows("wip") == page_number("총 (\d+)건")
 *   - 검사: dataset("hold") and dataset("by_step")
 *
 * 검사가 있는 단계는 조건이 충족되는 순간 루프가 다음 단계로 넘기고,
 * 충족되기 전에는 모델이 next_step으로 건너뛸 수 없다.
 */
export type Clause =
  | { kind: 'text'; text: string; negate: boolean }
  | { kind: 'value'; name: string; expected: string }
  | { kind: 'rows'; dataset: string; pattern: string }
  | { kind: 'dataset'; name: string }
  | { kind: 'did'; tool: string };

/** 값이 주어지지 않은 선택 입력의 자리표시자. 이 값과의 비교는 확인할 것이 없으므로 통과로 본다. */
export const UNSET = '(미지정)';

const CHECK_LINE = /^\s*-\s*검사:\s*(.+)$/;

export function stripCheckLines(text: string): string {
  return text
    .split('\n')
    .filter((l) => !CHECK_LINE.test(l))
    .join('\n');
}

function parseClause(src: string): Clause {
  let m: RegExpExecArray | null;
  if ((m = /^(no_)?text\("([^"]*)"\)$/.exec(src))) return { kind: 'text', text: m[2], negate: !!m[1] };
  if ((m = /^value\("([^"]*)"\)\s*==\s*"([^"]*)"$/.exec(src))) return { kind: 'value', name: m[1], expected: m[2] };
  if ((m = /^rows\("([^"]*)"\)\s*==\s*page_number\("([^"]*)"\)$/.exec(src))) {
    new RegExp(m[2]);
    return { kind: 'rows', dataset: m[1], pattern: m[2] };
  }
  if ((m = /^dataset\("([^"]*)"\)$/.exec(src))) return { kind: 'dataset', name: m[1] };
  if ((m = /^did\("([^"]*)"\)$/.exec(src))) return { kind: 'did', tool: m[1] };
  throw new Error(
    `검사 식을 읽을 수 없습니다: ${src}\n` +
      '쓸 수 있는 형태: text("글자"), no_text("글자"), value("요소 이름") == "값", ' +
      'rows("데이터셋") == page_number("정규식"), dataset("이름"), did("도구") — and로 연결',
  );
}

/** 단계 본문에서 검사 줄을 찾아 읽는다. 없으면 null. */
export function stepCheck(stepText: string): Clause[] | null {
  const lines = stepText.split('\n').flatMap((l) => {
    const m = CHECK_LINE.exec(l);
    return m ? [m[1].trim()] : [];
  });
  if (lines.length === 0) return null;
  return lines.flatMap((line) => line.split(/\s+and\s+/).map((c) => parseClause(c.trim())));
}

export interface CheckContext {
  snap: PageSnapshot;
  datasets: DatasetStore;
  /** 지금 단계에서 성공한 동작의 도구 이름 */
  didTools: Set<string>;
}

function pageTexts(snap: PageSnapshot): string[] {
  return snap.items.flatMap((i) => {
    if (i.kind === 'text' || i.kind === 'heading') return [i.text];
    if (i.kind === 'el') return [i.name];
    return [];
  });
}

/** 충족되지 않은 조건을 사람이 읽을 수 있는 문장으로 돌려준다. 빈 배열이면 통과. */
export function evalCheck(clauses: Clause[], ctx: CheckContext): string[] {
  const texts = pageTexts(ctx.snap);
  const unmet: string[] = [];
  for (const c of clauses) {
    switch (c.kind) {
      case 'text': {
        const found = texts.some((t) => t.includes(c.text));
        if (found === c.negate) {
          unmet.push(c.negate ? `화면에서 "${c.text}" 표시가 사라져야 함` : `화면에 "${c.text}"가 보여야 함`);
        }
        break;
      }
      case 'value': {
        if (c.expected === UNSET) break;
        const el = ctx.snap.items.find((i) => i.kind === 'el' && i.name === c.name);
        const actual = el?.kind === 'el' ? el.value : undefined;
        if (actual !== c.expected) {
          unmet.push(
            `"${c.name}"의 값이 "${c.expected}"이어야 함 (현재 ${actual === undefined ? '요소 없음' : `"${actual}"`})`,
          );
        }
        break;
      }
      case 'rows': {
        const re = new RegExp(c.pattern);
        const hit = texts.map((t) => re.exec(t)).find(Boolean);
        const total = hit ? Number((hit[1] ?? hit[0]).replace(/,/g, '')) : NaN;
        const ds = ctx.datasets.list().find((d) => d.name === c.dataset);
        if (!ds) unmet.push(`데이터셋 "${c.dataset}"이 아직 없음 (extract_table로 만들어야 함)`);
        else if (Number.isNaN(total)) unmet.push(`화면에서 총 건수(${c.pattern})를 찾을 수 없음`);
        else if (ds.rows.length !== total) {
          unmet.push(`"${c.dataset}"은 ${ds.rows.length}행인데 화면의 총 건수는 ${total} (같아져야 함)`);
        }
        break;
      }
      case 'dataset':
        if (!ctx.datasets.list().some((d) => d.name === c.name)) unmet.push(`데이터셋 "${c.name}"이 아직 없음`);
        break;
      case 'did':
        if (!ctx.didTools.has(c.tool)) unmet.push(`이 단계에서 ${c.tool}을(를) 아직 성공하지 못함`);
        break;
    }
  }
  return unmet;
}
