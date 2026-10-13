import type { DatasetStore } from './dataset';
import type { PageSnapshot } from './types';

/**
 * 단계의 "검사:" 줄. 모델의 판단 대신 규칙으로 단계 완료를 판정한다.
 *
 *   - 검사: value("라인") == "{line}"
 *   - 검사: did("click") and no_text("조회 중") and text("총")
 *   - 검사: rows("wip") == page_number("총 (\d+)건")
 *   - 검사: dataset("hold") and dataset("by_step")
 *   - 검사: url("/wip.html") and text("재공 현황 조회")
 *   - 검사: did("click") and dialog("접수되었습니다")
 *
 * 검사가 있는 단계는 조건이 충족되는 순간 루프가 다음 단계로 넘기고,
 * 충족되기 전에는 모델이 next_step으로 건너뛸 수 없다.
 */
export type Clause =
  | { kind: 'text'; text: string; negate: boolean }
  | { kind: 'url'; text: string }
  | { kind: 'value'; name: string; expected: string }
  | { kind: 'rows'; dataset: string; pattern: string }
  | { kind: 'dataset'; name: string }
  | { kind: 'did'; tool: string }
  /** 이 단계에서 뜬 알림·확인 창의 내용 */
  | { kind: 'dialog'; text: string };

/** 값이 주어지지 않은 선택 입력의 자리표시자. 이 값과의 비교는 확인할 것이 없으므로 통과로 본다. */
export const UNSET = '(미지정)';

const CHECK_LINE = /^\s*-\s*검사:\s*(.+)$/;
const CAPTURE_LINE = /^\s*-\s*기록:\s*(.+)$/;

/** 루프가 직접 처리하는 줄(검사, 기록)을 모델에게 보여줄 본문에서 뺀다. */
export function stripCheckLines(text: string): string {
  return text
    .split('\n')
    .filter((l) => !CHECK_LINE.test(l) && !CAPTURE_LINE.test(l))
    .join('\n');
}

/**
 * 단계의 "기록:" 줄. 단계가 끝난 시점의 화면에서 값을 읽어 실행 결과에 남긴다.
 *
 *   - 기록: request_id = page_text("신청 번호: (\S+)")
 *
 *   - 기록: receipt = dialog_text("접수 번호: (\S+)")
 *
 * page_text는 화면의 글자에서, dialog_text는 이 단계에서 뜬 알림·확인 창의 내용에서 읽는다.
 * 뒤 단계에서는 {out.request_id}로 쓸 수 있다. 모델이 옮겨 적다 틀릴 수 있는 값을 규칙으로 읽는다.
 */
export interface Capture {
  name: string;
  pattern: string;
  from: 'page' | 'dialog';
}

export function stepCaptures(stepText: string): Capture[] {
  return stepText.split('\n').flatMap((l) => {
    const line = CAPTURE_LINE.exec(l)?.[1].trim();
    if (!line) return [];
    const m = /^([a-z_][a-z0-9_]*)\s*=\s*(page|dialog)_text\("([^"]*)"\)$/.exec(line);
    if (!m) throw new Error(`기록 식을 읽을 수 없습니다: ${line}\n형태: 이름 = page_text("정규식") 또는 dialog_text("정규식")`);
    new RegExp(m[3]);
    return [{ name: m[1], pattern: m[3], from: m[2] as Capture['from'] }];
  });
}

/** 화면 글자(또는 이 단계에서 뜬 창의 내용)에서 정규식의 첫 괄호(없으면 전체 일치)를 읽는다. 없으면 null. */
export function capture(c: Capture, snap: PageSnapshot, dialogs: string[] = []): string | null {
  const re = new RegExp(c.pattern);
  for (const text of c.from === 'dialog' ? dialogs : pageTexts(snap)) {
    const hit = re.exec(text);
    if (hit) return hit[1] ?? hit[0];
  }
  return null;
}

function parseClause(src: string): Clause {
  let m: RegExpExecArray | null;
  if ((m = /^(no_)?text\("([^"]*)"\)$/.exec(src))) return { kind: 'text', text: m[2], negate: !!m[1] };
  if ((m = /^url\("([^"]*)"\)$/.exec(src))) return { kind: 'url', text: m[1] };
  if ((m = /^value\("([^"]*)"\)\s*==\s*"([^"]*)"$/.exec(src))) return { kind: 'value', name: m[1], expected: m[2] };
  if ((m = /^rows\("([^"]*)"\)\s*==\s*page_number\("([^"]*)"\)$/.exec(src))) {
    new RegExp(m[2]);
    return { kind: 'rows', dataset: m[1], pattern: m[2] };
  }
  if ((m = /^dataset\("([^"]*)"\)$/.exec(src))) return { kind: 'dataset', name: m[1] };
  if ((m = /^did\("([^"]*)"\)$/.exec(src))) return { kind: 'did', tool: m[1] };
  if ((m = /^dialog\("([^"]*)"\)$/.exec(src))) return { kind: 'dialog', text: m[1] };
  throw new Error(
    `검사 식을 읽을 수 없습니다: ${src}\n` +
      '쓸 수 있는 형태: text("글자"), no_text("글자"), url("주소 일부"), value("요소 이름") == "값", ' +
      'rows("데이터셋") == page_number("정규식"), dataset("이름"), did("도구"), dialog("글자") — and로 연결',
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
  /** 지금 단계에서 뜬 알림·확인 창의 내용 */
  dialogs?: string[];
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
      case 'url': {
        const urls = [ctx.snap.url, ...ctx.snap.items.flatMap((i) => (i.kind === 'frame' ? [i.url] : []))];
        if (!urls.some((u) => u.includes(c.text))) unmet.push(`주소에 "${c.text}"가 들어간 화면이 열려 있어야 함`);
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
      case 'dialog':
        if (!ctx.dialogs?.some((d) => d.includes(c.text))) unmet.push(`"${c.text}" 내용의 알림 창이 떠야 함`);
        break;
      case 'did':
        if (!ctx.didTools.has(c.tool)) unmet.push(`이 단계에서 ${c.tool}을(를) 아직 성공하지 못함`);
        break;
    }
  }
  return unmet;
}
