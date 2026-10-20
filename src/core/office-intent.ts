import type { Skill } from './skill';

/** 요청이 엑셀 문서를 말하는지 */
const EXCEL_WORDS = /(엑셀|excel|xlsx|xlsm|\.xls\b|\.csv\b|스프레드시트|통합\s*문서|워크북|시트)/i;
/** 요청이 브라우저 화면의 일을 말하는지: 주소, 화면 조작을 뜻하는 말 */
const WEB_WORDS = /(화면|웹|브라우저|사이트|페이지|탭|메뉴|접속|로그인|입력란|클릭|상신|다운로드|내려받|업로드|https?:\/\/|localhost)/i;

export interface OfficeIntent {
  /** 엑셀 문서가 필요한 요청이다 */
  excel: boolean;
  /** 브라우저 화면도 필요한 요청이다 */
  web: boolean;
}

const stem = (name: string) => name.replace(/\.(xlsx|xlsm|xls|csv)$/i, '').trim();

/**
 * 요청 문장으로 엑셀과 브라우저 중 무엇이 필요한지 가린다. 판정은 말 그대로이며 모델을 부르지 않는다.
 * - 엑셀을 말하거나 열린 문서의 이름이 나오면 엑셀이 필요하다.
 * - 주소, 시스템 이름, 화면을 뜻하는 말이 있으면 브라우저도 필요하다.
 * 엑셀이 필요하고 브라우저는 필요 없으면 확장 연결을 기다리지 않고 엑셀 도구만으로 한다.
 */
export function officeIntent(text: string, o: { openDocs?: string[]; hasUrl?: boolean; hasSystem?: boolean } = {}): OfficeIntent {
  const docHit = (o.openDocs ?? []).some((n) => {
    const s = stem(n);
    return s.length >= 2 && text.toLowerCase().includes(s.toLowerCase());
  });
  const excel = EXCEL_WORDS.test(text) || docHit;
  const web = !!o.hasUrl || !!o.hasSystem || WEB_WORDS.test(text);
  return { excel, web };
}

/** 스킬 단계가 엑셀 도구나 파일 입력을 쓰는지 (그러면 실행에 엑셀 통로를 붙인다) */
export function skillUsesOffice(skill: Skill): boolean {
  return /excel_(docs|read|write|save)/.test(skill.body) || skill.inputs.some((i) => i.type === 'file');
}
