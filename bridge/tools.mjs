// Dogent 확장이 내놓는 브라우저 도구 목록 (MCP tools/list에 그대로 나간다).
// 브리지(hub.mjs)와 확장(src/core/browser-tools.ts)이 같이 쓴다. 이름과 인자는 스킬의 도구와 맞춘다.
//
// 공통 규칙 (확장이 지킨다)
// - 조작할 사이트 목록 밖으로는 이동하지 않는다.
// - 저장·상신 계열 버튼은 확장이 띄우는 승인 창에서 사람이 승인해야 누른다.
// - 로그인 화면을 만나면 snapshot이 알려 준다. 비밀번호는 입력할 수 없다. wait_for_login으로 사람이 로그인하기를 기다린다.
// - ref는 마지막 snapshot의 [번호]다. 화면이 바뀌면 snapshot을 다시 읽는다.

const ref = { type: 'integer', minimum: 0, description: '마지막 snapshot에서 [ ] 안의 요소 번호' };
const tabId = { type: 'integer', description: '탭 번호 (tabs_list). 없으면 지금 대상 탭' };

export const TOOLS = [
  {
    name: 'tabs_list',
    description: '브라우저의 탭 목록. 탭마다 번호, 제목, 주소, 조작할 수 있는지(조작할 사이트 목록 안인지), 지금 대상인지를 보여 준다.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'tab_open',
    description: '새 탭에서 주소를 열고 그 탭을 대상으로 정한다. 조작할 사이트 목록 밖의 주소는 열지 않는다.',
    inputSchema: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] },
  },
  {
    name: 'tab_select',
    description: '대상 탭을 바꾸고 앞으로 가져온다.',
    inputSchema: { type: 'object', properties: { tab_id: tabId }, required: ['tab_id'] },
  },
  {
    name: 'snapshot',
    description:
      '대상 탭의 화면을 요소 번호가 붙은 텍스트로 읽는다. 조작하기 전에 먼저 부른다. [번호] role "이름" value=… 형식이고, 표는 rows와 cols로 요약된다. 로그인 화면이면 맨 앞에 [login_required]가 붙는다.',
    inputSchema: { type: 'object', properties: { tab_id: tabId } },
  },
  {
    name: 'navigate',
    description: '대상 탭을 주소로 이동한다. 조작할 사이트 목록 밖이면 거절한다.',
    inputSchema: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] },
  },
  {
    name: 'click',
    description:
      '요소를 누른다. 저장·상신 계열 버튼이면 사람이 승인 창에서 승인해야 누른다. 누른 뒤 뜬 확인 창은 기본으로 취소하고, accept_dialog가 true면 확인을 누른다(저장·상신을 묻는 창은 승인받은 경우에만).',
    inputSchema: {
      type: 'object',
      properties: { ref, accept_dialog: { type: 'boolean' } },
      required: ['ref'],
    },
  },
  {
    name: 'type',
    description: '입력 칸에 글을 넣는다 (원래 값은 지운다). 비밀번호 칸은 화면 읽기에 나오지 않아 넣을 수 없다.',
    inputSchema: { type: 'object', properties: { ref, text: { type: 'string' } }, required: ['ref', 'text'] },
  },
  {
    name: 'select',
    description: '선택 상자에서 값을 고른다. 값은 보이는 글자나 value.',
    inputSchema: { type: 'object', properties: { ref, value: { type: 'string' } }, required: ['ref', 'value'] },
  },
  {
    name: 'wait_for',
    description: '화면에 글자가 나타날 때까지 기다린다.',
    inputSchema: {
      type: 'object',
      properties: { text: { type: 'string' }, timeout_sec: { type: 'number', default: 10, maximum: 60 } },
      required: ['text'],
    },
  },
  {
    name: 'extract_table',
    description:
      '표를 읽는다. next_ref에 다음 페이지 버튼을 주면 버튼이 비활성이 될 때까지 넘기며 모든 페이지를 읽는다. 결과는 JSON (columns, total_rows, rows). 행이 많으면 max_rows까지만 돌려준다.',
    inputSchema: {
      type: 'object',
      properties: { ref, next_ref: ref, max_rows: { type: 'integer', default: 200 } },
      required: ['ref'],
    },
  },
  {
    name: 'download_table',
    description: '화면의 엑셀·CSV 내려받기 버튼을 눌러 받은 파일을 표로 읽는다. 결과는 extract_table과 같은 JSON.',
    inputSchema: {
      type: 'object',
      properties: { ref, timeout_sec: { type: 'number', default: 30 }, max_rows: { type: 'integer', default: 200 } },
      required: ['ref'],
    },
  },
  {
    name: 'fill_table',
    description:
      '입력 칸이 있는 표(또는 붙여넣기 전용 그리드)의 빈 행에 값을 채운다. columns는 표의 머리글 이름, rows는 그 순서의 값. 행이 모자라면 add_ref(행 추가 버튼)를 누른다. 채운 뒤 화면을 다시 읽어 넣은 값과 대조한 결과를 돌려준다.',
    inputSchema: {
      type: 'object',
      properties: {
        ref,
        columns: { type: 'array', items: { type: 'string' } },
        rows: { type: 'array', items: { type: 'array', items: { type: 'string' } } },
        add_ref: ref,
      },
      required: ['ref', 'columns', 'rows'],
    },
  },
  {
    name: 'read_text',
    description: '화면(ref를 주면 그 요소)에 보이는 글을 읽는다. 공지·게시글 요약처럼 글 내용이 필요할 때 쓴다. 입력 칸의 값은 담지 않는다.',
    inputSchema: { type: 'object', properties: { ref, max_chars: { type: 'integer', default: 20000 } } },
  },
  {
    name: 'inspect',
    description: '대상 화면을 Dogent가 얼마나 읽을 수 있는지 점검한다 (읽지 못한 iframe, 그림으로 그린 그리드, 머리글 없는 표 등).',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'wait_for_login',
    description:
      '로그인 화면에서 사람이 직접 로그인하기를 기다린다. 비밀번호 칸이 사라지면 끝난다. snapshot이 [login_required]를 알렸을 때 사용자에게 로그인을 부탁하고 부른다.',
    inputSchema: { type: 'object', properties: { timeout_sec: { type: 'number', default: 300, maximum: 900 } } },
  },
];
