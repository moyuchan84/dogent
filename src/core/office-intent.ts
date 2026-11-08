import type { Skill } from './skill';

/** 요청이 엑셀 문서를 말하는지 */
const EXCEL_WORDS = /(엑셀|excel|xlsx|xlsm|\.xls\b|\.csv\b|스프레드시트|통합\s*문서|워크북|시트)/i;
/** 요청이 워드 문서를 말하는지 */
const WORD_WORDS = /(워드|\bword\b|\.docx?\b|\bdocx\b|\.rtf\b)/i;
/** 요청이 파워포인트 자료를 말하는지 */
const PPT_WORDS = /(파워\s*포인트|powerpoint|\bppt|\.pptx?\b|슬라이드|발표\s*자료|프레젠테이션|프리젠테이션)/i;
/** 요청이 브라우저 화면의 일을 말하는지: 주소, 화면 조작을 뜻하는 말 */
const WEB_WORDS = /(화면|웹|브라우저|사이트|페이지|탭|메뉴|접속|로그인|입력란|클릭|상신|다운로드|내려받|업로드|https?:\/\/|localhost)/i;

export interface OfficeIntent {
  /**
   * 오피스 문서(엑셀, 워드, 파워포인트)가 필요한 요청이다.
   * 이름은 엑셀로 시작했지만 지금은 셋 모두를 뜻한다. 무엇인지는 word, ppt로 본다 (엑셀만이면 둘 다 없다).
   */
  excel: boolean;
  /** 브라우저 화면도 필요한 요청이다 */
  web: boolean;
  /** 워드 문서를 말한다 (참일 때만 들어 있다) */
  word?: true;
  /** 파워포인트 자료를 말한다 (참일 때만 들어 있다) */
  ppt?: true;
}

const stem = (name: string) => name.replace(/\.(xlsx|xlsm|xls|csv|docx|docm|doc|rtf|pptx|pptm|ppt)$/i, '').trim();

/**
 * 요청 문장으로 오피스 문서와 브라우저 중 무엇이 필요한지 가린다. 판정은 말 그대로이며 모델을 부르지 않는다.
 * - 엑셀·워드·파워포인트를 말하거나 열린 문서의 이름이 나오면 오피스 문서가 필요하다.
 * - 주소, 시스템 이름, 화면을 뜻하는 말이 있으면 브라우저도 필요하다.
 * 문서가 필요하고 브라우저는 필요 없으면 확장 연결을 기다리지 않고 오피스 도구만으로 한다.
 */
export function officeIntent(text: string, o: { openDocs?: string[]; hasUrl?: boolean; hasSystem?: boolean } = {}): OfficeIntent {
  const docHit = (o.openDocs ?? []).some((n) => {
    const s = stem(n);
    return s.length >= 2 && text.toLowerCase().includes(s.toLowerCase());
  });
  const word = WORD_WORDS.test(text);
  const ppt = PPT_WORDS.test(text);
  const excel = EXCEL_WORDS.test(text) || word || ppt || docHit;
  const web = !!o.hasUrl || !!o.hasSystem || WEB_WORDS.test(text);
  return { excel, web, ...(word ? { word: true as const } : {}), ...(ppt ? { ppt: true as const } : {}) };
}

/**
 * 이번 문장에 단서가 하나도 없으면("거기 있는 거 봐줘", "방금 그거 합계 내줘") 직전 요청이 쓴 통로를 이어 쓴다.
 * 단서가 있으면 그 판정을 그대로 둔다. 직전이 브라우저뿐이었다면 기본값(브라우저)과 같으니 바꿀 것이 없다.
 */
export function carryIntent(intent: OfficeIntent, prev?: { office?: boolean; web?: boolean }): OfficeIntent {
  if (intent.excel || intent.web || !prev?.office) return intent;
  return { excel: true, web: !!prev.web };
}

/** 스킬 단계가 오피스 도구나 파일 입력을 쓰는지 (그러면 실행에 오피스 통로를 붙인다) */
export function skillUsesOffice(skill: Skill): boolean {
  return /(excel_(docs|read|write|save)|word_(read|write|save)|ppt_(read|write|save))/.test(skill.body) || skill.inputs.some((i) => i.type === 'file');
}
