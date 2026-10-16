import type { FrameInspection } from './types';

/**
 * 화면 점검: 사내 화면을 처음 다룰 때 에이전트가 그 화면을 얼마나 읽을 수 있는지 미리 본다.
 * 스킬을 만들기 전에 막히는 곳(허용 목록, iframe, 그림으로 그린 그리드, 웹 컴포넌트)을 찾는 것이 목적이다.
 */
export interface SiteInspection {
  /** 탭의 주소 */
  url: string;
  /** 확장이 이 탭을 읽을 수 있었는지. false면 허용 목록 밖이다. */
  readable: boolean;
  /** 읽은 프레임들. 첫 번째가 맨 위 화면이다. */
  frames: FrameInspection[];
}

export type SiteFindingLevel = 'fail' | 'warn' | 'ok' | 'info';

export interface SiteFinding {
  level: SiteFindingLevel;
  title: string;
  detail?: string;
  /** 어떻게 하면 되는지 */
  fix?: string;
}

export interface Diagnosis {
  /** blocked: 이대로는 쓸 수 없음, check: 되지만 확인할 것이 있음, ready: 녹화해 볼 만함 */
  verdict: 'blocked' | 'check' | 'ready';
  findings: SiteFinding[];
}

export const VERDICT_LABEL: Record<Diagnosis['verdict'], string> = {
  blocked: '막힌 곳이 있습니다',
  check: '쓸 수 있지만 확인할 것이 있습니다',
  ready: '녹화해 볼 만합니다',
};

/** 보고서에 화면 글자와 주소를 그대로 둘지 가릴지 */
export interface Masking {
  hidden: boolean;
  /** 라벨·머리글·버튼 이름 같은 화면 글자 */
  text: (s: string) => string;
  /** 주소. 쿼리와 해시는 언제나 뺀다. */
  url: (u: string) => string;
}

const origin = (u: string) => {
  try {
    return new URL(u).origin;
  } catch {
    return '';
  }
};

export function plainMasking(): Masking {
  return {
    hidden: false,
    text: (s) => s,
    url: (u) => {
      try {
        const x = new URL(u);
        return x.origin + x.pathname;
      } catch {
        return u;
      }
    },
  };
}

/** 사외로 가져가도 되도록 화면 글자는 글자 수만, 호스트는 "호스트 A"처럼 바꾼다. 같은 값은 같은 이름이 된다. */
export function hiddenMasking(): Masking {
  const hosts = new Map<string, string>();
  return {
    hidden: true,
    text: (s) => (s === '' ? '' : `‹${[...s].length}자›`),
    url: (u) => {
      const o = origin(u);
      if (!o) return '‹주소›';
      if (!hosts.has(o)) hosts.set(o, `호스트 ${String.fromCharCode(65 + (hosts.size % 26))}`);
      const depth = new URL(u).pathname.split('/').filter(Boolean).length;
      return `${hosts.get(o)}${depth ? `/…(${depth}단계)` : '/'}`;
    },
  };
}

/** 화면에 들어 있지만 확장이 읽지 못한 iframe의 출처. 허용 목록 밖이라 스크립트가 들어가지 못한 것이다. */
export function unreadFrames(frames: FrameInspection[]): string[] {
  const read = new Set(frames.map((f) => origin(f.url)));
  const all = frames.flatMap((f) => f.frames.map(origin)).filter(Boolean);
  return [...new Set(all.filter((o) => !read.has(o)))];
}

const permissionLine = (o: string) => `'${o}/*'`;

export function diagnose(site: SiteInspection, mask: Masking = plainMasking()): Diagnosis {
  const t = mask.text;
  const findings: SiteFinding[] = [];
  const top = site.frames[0];

  if (!site.readable || !top) {
    const o = origin(site.url);
    findings.push({
      level: 'fail',
      title: '이 화면은 Dogent가 읽을 수 없습니다',
      detail: o ? `${mask.url(site.url)} 은(는) 허용 목록(sitePermissions)에 없습니다.` : '브라우저 내부 화면이나 새 탭은 읽지 않습니다.',
      fix: o
        ? `dogent.config.ts의 sitePermissions에 ${mask.hidden ? '이 호스트' : permissionLine(o)}를 넣고 pnpm build 후 확장을 새로고침하세요.`
        : '업무 화면을 연 탭에서 다시 점검하세요.',
    });
    return { verdict: 'blocked', findings };
  }

  if (site.frames.some((f) => f.hasPassword)) {
    findings.push({
      level: 'fail',
      title: '로그인 화면입니다',
      detail: '비밀번호 칸이 보이는 화면에서는 실행과 녹화를 멈춥니다.',
      fix: '직접 로그인한 뒤 업무 화면에서 다시 점검하세요.',
    });
  }

  const missing = unreadFrames(site.frames);
  if (missing.length > 0) {
    findings.push({
      level: 'fail',
      title: `읽지 못한 iframe ${missing.length}개`,
      detail: `화면 안에 들어 있는 ${missing.map(mask.url).join(', ')} 은(는) 허용 목록 밖이라 안을 읽지 못했습니다. 업무 화면이 이 안에 있으면 조작할 수 없습니다.`,
      fix: !mask.hidden
        ? `sitePermissions에 ${missing.map(permissionLine).join(', ')}를 더하고 다시 빌드하세요.`
        : 'sitePermissions에 이 호스트들을 더하고 다시 빌드하세요.',
    });
  }

  const canvases = site.frames.flatMap((f) => f.canvases);
  if (canvases.length > 0) {
    const downloads = site.frames.flatMap((f) => f.downloads);
    findings.push({
      level: 'warn',
      title: `그림으로 그린 영역 ${canvases.length}개`,
      detail: `크기 ${canvases.map((c) => `${c.width}×${c.height}`).join(', ')}. 표를 canvas에 그리는 그리드라면 칸의 값을 읽거나 넣을 수 없습니다. 차트라면 상관없습니다.`,
      fix: downloads.length
        ? `값이 필요하면 화면의 내려받기 버튼(${downloads.map(t).join(', ')})으로 받으세요. 녹화에서 그 버튼을 누르면 download_table 단계가 됩니다.`
        : '값이 필요하면 화면에 엑셀 내려받기 기능이 있는지 확인하세요.',
    });
  }

  const shadow = site.frames.flatMap((f) => f.shadowHosts);
  if (shadow.length > 0) {
    const controls = shadow.reduce((n, s) => n + s.controls, 0);
    findings.push({
      level: 'warn',
      title: `웹 컴포넌트 안의 요소 ${controls}개를 읽지 못합니다`,
      detail: `${[...new Set(shadow.map((s) => `<${s.tag}>`))].join(', ')} 안에 버튼·입력란이 있습니다. 지금은 shadow DOM 안을 읽지 않습니다.`,
      fix: '업무에 필요한 버튼이 이 안에 있으면 점검 보고서를 개발 담당에게 보내 주세요.',
    });
  }

  if (site.frames.some((f) => f.truncated)) {
    findings.push({
      level: 'warn',
      title: '화면 요소가 너무 많아 일부를 읽지 않았습니다',
      detail: '한 화면에서 조작할 요소를 300개까지만 읽습니다. 뒤쪽 요소는 모델도 녹화한 단계도 찾지 못할 수 있습니다.',
      fix: '조회 조건으로 결과를 줄이거나, 필요한 요소가 화면 앞쪽에 오도록 접힌 메뉴를 닫고 다시 점검하세요.',
    });
  }

  const unnamed: Record<string, number> = {};
  for (const f of site.frames) for (const [role, n] of Object.entries(f.unnamed)) unnamed[role] = (unnamed[role] ?? 0) + n;
  const unnamedTotal = Object.values(unnamed).reduce((a, b) => a + b, 0);
  if (unnamedTotal > 0) {
    findings.push({
      level: unnamedTotal >= 3 ? 'warn' : 'info',
      title: `이름 없는 요소 ${unnamedTotal}개`,
      detail: `${Object.entries(unnamed)
        .map(([role, n]) => `${role} ${n}`)
        .join(', ')}. 라벨·글자·title이 없는 요소는 이름으로 고를 수 없어, 녹화한 단계가 다른 요소를 누르거나 실행 때 찾지 못할 수 있습니다.`,
      fix: '녹화할 때 이런 요소를 누르게 되면, 초안의 그 단계가 맞는 요소를 가리키는지 시험 실행으로 확인하세요.',
    });
  }

  for (const f of site.frames) {
    for (const table of f.tables) {
      const where = site.frames.length > 1 ? ` (${mask.url(f.url)})` : '';
      const head = `${table.kind === 'grid' ? '그리드' : '표'} "${t(table.name)}"${where}`;
      if (table.columns.length === 0) {
        findings.push({
          level: 'warn',
          title: `${head}: 머리글을 찾지 못했습니다`,
          detail: `${table.rows}행. 열 이름이 없으면 표 읽기 결과의 컬럼이 "컬럼1"처럼 붙고, 엑셀로 채우기는 열을 맞출 수 없습니다.`,
        });
        continue;
      }
      const dups = table.columns.filter((c, i) => c && table.columns.indexOf(c) !== i);
      const mode =
        table.inputRows > 0
          ? `입력 칸이 있는 행 ${table.inputRows}개 → 엑셀로 채우기(fill_table) 가능`
          : '입력 칸 없음 → 표 읽기(extract_table) 가능. 입력용이라면 붙여넣기 전용 그리드로 채움';
      findings.push({
        level: dups.length ? 'warn' : 'ok',
        title: `${head}: ${table.rows}행, 열 ${table.columns.length}개`,
        detail: `열: ${table.columns.map((c) => t(c) || '(빈 칸)').join(', ')}. ${mode}.${dups.length ? ` 같은 이름의 열(${[...new Set(dups)].map(t).join(', ')})은 첫 번째 것만 씁니다.` : ''}`,
      });
    }
  }

  const downloads = [...new Set(site.frames.flatMap((f) => f.downloads))];
  if (downloads.length) {
    findings.push({
      level: 'info',
      title: `내려받기 버튼: ${downloads.map(t).join(', ')}`,
      detail: '여러 페이지의 결과가 필요하면 페이지를 넘기며 읽는 것보다 이 버튼으로 받는 편이 빠르고 정확합니다.',
    });
  }
  const pagers = [...new Set(site.frames.flatMap((f) => f.pagers))];
  if (pagers.length) {
    findings.push({
      level: 'info',
      title: `페이지 넘김 버튼: ${pagers.map(t).join(', ')}`,
      detail: '녹화에서 "화면의 표 읽기 추가"를 누르면 이 버튼으로 끝 페이지까지 읽을지 묻습니다.',
    });
  }

  const elements = site.frames.reduce((n, f) => n + f.elements, 0);
  findings.push({
    level: elements > 0 ? 'ok' : 'warn',
    title: `조작할 수 있는 요소 ${elements}개를 읽었습니다`,
    detail: site.frames.length > 1 ? `프레임 ${site.frames.length}개 (맨 위 화면 포함).` : undefined,
    fix: elements > 0 ? undefined : '화면이 다 뜬 뒤에 다시 점검하세요. 계속 0개면 화면 전체가 그림이거나 읽지 못하는 구조입니다.',
  });

  const order: SiteFindingLevel[] = ['fail', 'warn', 'ok', 'info'];
  findings.sort((a, b) => order.indexOf(a.level) - order.indexOf(b.level));
  const verdict = findings.some((f) => f.level === 'fail') ? 'blocked' : findings.some((f) => f.level === 'warn') ? 'check' : 'ready';
  return { verdict, findings };
}

const MARK: Record<SiteFindingLevel, string> = { fail: '[막힘]', warn: '[확인]', ok: '[정상]', info: '[참고]' };

/**
 * 점검 결과를 마크다운 보고서로 만든다. 화면의 값과 본문 글자는 처음부터 담지 않으며,
 * hide를 켜면 라벨·머리글·버튼 이름과 주소도 가린다.
 */
export function renderInspection(site: SiteInspection, opts: { hide: boolean; at?: Date; version?: string }): string {
  const mask = opts.hide ? hiddenMasking() : plainMasking();
  // 탭의 호스트가 "호스트 A"가 되도록 먼저 가린다.
  const shown = mask.url(site.url);
  const { verdict, findings } = diagnose(site, mask);
  const lines = [
    '# Dogent 화면 점검',
    '',
    `- 화면: ${shown}${site.frames[0] && !opts.hide ? ` (${site.frames[0].title})` : ''}`,
    `- 판정: ${VERDICT_LABEL[verdict]}`,
    `- 점검 시각: ${(opts.at ?? new Date()).toISOString()}`,
  ];
  if (opts.version) lines.push(`- Dogent 버전: ${opts.version}`);
  lines.push(
    `- 화면 글자: ${opts.hide ? '가림 (라벨·머리글·버튼 이름은 글자 수만, 호스트는 별칭)' : '그대로 (입력값과 표의 값은 담지 않음)'}`,
    '',
    '## 결과',
    '',
  );
  for (const f of findings) {
    lines.push(`- ${MARK[f.level]} ${f.title}`);
    if (f.detail) lines.push(`  - ${f.detail}`);
    if (f.fix) lines.push(`  - 조치: ${f.fix}`);
  }
  if (site.frames.length > 0) {
    lines.push('', '## 프레임', '');
    site.frames.forEach((f, i) => {
      const roles = Object.entries(f.unnamed)
        .map(([r, n]) => `${r} ${n}`)
        .join(', ');
      lines.push(
        `${i + 1}. ${mask.url(f.url)} — 요소 ${f.elements}개${f.truncated ? ' (일부 생략)' : ''}, 표 ${f.tables.length}개, iframe ${f.frames.length}개${roles ? `, 이름 없는 요소: ${roles}` : ''}`,
      );
    });
  }
  return lines.join('\n') + '\n';
}
