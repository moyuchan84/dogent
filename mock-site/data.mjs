// 모의 재공 데이터. 같은 조건이면 항상 같은 결과가 나오도록 시드 기반 난수를 쓴다.

export const LINES = ['6라인', '7라인', '8라인'];
export const STEPS = ['PHOTO', 'ETCH', 'DIFF', 'CMP', 'IMP'];
export const COLUMNS = ['Lot ID', '제품', '공정', '수량', '상태', '정체시간'];

const COUNTS = { '6라인': 37, '7라인': 128, '8라인': 173 };
const PRODUCTS = ['DR5-16G', 'DR5-32G', 'NV2-512', 'NV2-1T'];

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** @returns {string[][]} 화면에 표시되는 문자열 그대로의 행 */
export function generateWip(line, step) {
  const n = COUNTS[line] ?? 0;
  const lineNo = line.replace(/\D/g, '');
  const rand = mulberry32(Number(lineNo) * 7919);
  const pick = (arr) => arr[Math.floor(rand() * arr.length)];
  const rows = [];
  for (let i = 1; i <= n; i++) {
    const r = rand();
    const status = r < 0.08 ? 'HOLD' : r < 0.55 ? 'RUN' : 'WAIT';
    const hours = rand() < 0.25 ? Math.round(rand() * 480) / 10 + 20 : Math.round(rand() * 190) / 10;
    rows.push([
      `P${lineNo}-${String(i).padStart(5, '0')}`,
      pick(PRODUCTS),
      pick(STEPS),
      (Math.floor(rand() * 2400) + 100).toLocaleString('en-US'),
      status,
      String(hours),
    ]);
  }
  return step && step !== '전체' ? rows.filter((r) => r[2] === step) : rows;
}
