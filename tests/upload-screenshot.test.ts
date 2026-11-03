import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TOOLS, toContent } from '../bridge/tools.mjs';
import { checkUploadPath, defaultUploadDirs, readUploadFile } from '../client/src/upload';
import {
  BrowserTools,
  McpBrowser,
  OpenAiCompatClient,
  UPLOAD_CHUNK_BYTES,
  buildFreeSkill,
  buildTurnMessages,
  checkAction,
  fitSize,
  parseAction,
  runSkill,
  sensitiveNameReason,
  type Action,
  type ApprovalRequest,
  type ChatMessage,
  type McpCall,
  type ToolHost,
} from '../src/core';
import { JsdomBrowser, memoryFiles, scriptedLlm } from './helpers';

const SITE = 'http://localhost:4173';
const PAGE = `${SITE}/upload.html`;

const refOf = (snap: string, pattern: RegExp) => {
  const m = snap.split('\n').find((l) => pattern.test(l))?.match(/^\[(\d+)\]/);
  if (!m) throw new Error(`화면에 ${pattern} 없음:\n${snap}`);
  return Number(m[1]);
};

/** 확장 쪽(BrowserTools)을 jsdom 탭 하나에 붙인다. sites로 조작할 사이트를 바꾼다. */
function extension(browser: JsdomBrowser, opts: { decide?: boolean; sites?: string[] } = {}) {
  const asked: ApprovalRequest[] = [];
  const host: ToolHost = {
    tabs: async () => [{ id: 7, url: browser.document.location.href, title: browser.document.title }],
    open: async () => 7,
    focus: async () => {},
    port: () => browser,
    sites: async () => opts.sites ?? [`${SITE}/*`],
    approve: async (request) => {
      asked.push(request);
      return opts.decide ?? true;
    },
    activeTab: async () => 7,
  };
  return { tools: new BrowserTools(host), asked };
}

/** 클라이언트 쪽(McpBrowser)을 확장에 MCP 도구 호출로 잇는다. read가 올릴 파일을 읽는다. */
function client(tools: BrowserTools, read?: ConstructorParameters<typeof McpBrowser>[1]) {
  const calls: string[] = [];
  const call: McpCall = async (name, args) => {
    calls.push(String(args.method ?? name));
    try {
      return { text: await tools.call(name, args), isError: false };
    } catch (e) {
      return { text: (e as Error).message, isError: true };
    }
  };
  return { mcp: new McpBrowser(call, read), calls };
}

const csv = 'Lot,수량\nL001,25\n';
const source = (bytes: Uint8Array = new TextEncoder().encode(csv)) => async () => ({ name: '신청서.csv', mime: 'text/csv', bytes });

describe('파일 올리기: 페이지 에이전트', () => {
  it('숨겨진 파일 칸을 여는 라벨을 ref로 보여 주고, 파일 이름·크기·내용이 그대로 들어가며 input·change 이벤트가 난다', async () => {
    const browser = await JsdomBrowser.open('/upload.html');
    const { tools } = extension(browser);
    const snap = await tools.call('snapshot');
    expect(snap).toMatch(/button "파일 선택".*upload_file/);
    const { mcp } = client(tools, source());
    await mcp.snapshot();
    const label = refOf(snap, /button "파일 선택"/);
    const r = await mcp.uploadFile(label, 'C:\\Users\\x\\Downloads\\신청서.csv');
    expect(r.ok, r.message).toBe(true);
    const input = browser.document.getElementById('file') as HTMLInputElement;
    const files = input.files as unknown as File[];
    expect(files).toHaveLength(1);
    expect(files[0].name).toBe('신청서.csv');
    expect(files[0].size).toBe(new TextEncoder().encode(csv).length);
    expect(files[0].type).toBe('text/csv');
    await new Promise((r) => setTimeout(r, 100));
    // 페이지의 change 처리기가 실제로 파일을 읽었다: 이름·크기·첫 줄과 이벤트 순서
    expect(browser.document.getElementById('result')!.textContent).toBe(`첨부됨: 신청서.csv (${files[0].size}바이트) 첫 줄: Lot,수량 [이벤트: input,change]`);
  });

  it('파일 칸 자체나 같은 묶음의 버튼도 연결된 칸을 찾고, 연결을 알 수 없으면 거절한다', async () => {
    const browser = await JsdomBrowser.open('/portal.html');
    browser.dom.window.document.body.innerHTML = `
      <div id="a"><button id="open">찾아보기</button><input type="file" id="fa" hidden></div>
      <div id="b"><button id="b1">첫째</button><input type="file" id="fb1" hidden><input type="file" id="fb2" hidden></div>`;
    const snap = await browser.snapshot();
    const open = (snap.items.find((i) => i.kind === "el" && i.name === "찾아보기") as { ref: number }).ref;
    const payload = { name: 'a.txt', mime: 'text/plain', base64: btoa('hi') };
    expect((await browser.attachFile(open, payload)).ok).toBe(true);
    expect(((browser.document.getElementById('fa') as HTMLInputElement).files as unknown as File[])[0].name).toBe('a.txt');
    const second = snap.items.find((i) => i.kind === 'el' && i.name === '첫째');
    const r = await browser.attachFile((second as { ref: number }).ref, payload);
    expect(r.ok).toBe(false);
    expect(r.message).toContain('파일 입력 칸');
  });
});

describe('파일 올리기: 확장의 안전장치', () => {
  it('사용자가 승인하지 않으면 어떤 경로로도 input.files가 바뀌지 않는다', async () => {
    const browser = await JsdomBrowser.open('/upload.html');
    const { tools, asked } = extension(browser, { decide: false });
    const { mcp } = client(tools, source());
    const label = refOf(await tools.call('snapshot'), /button "파일 선택"/);
    const r = await mcp.uploadFile(label, 'C:\\Users\\x\\Downloads\\신청서.csv');
    expect(r.ok).toBe(false);
    expect(r.message).toContain('승인하지 않았습니다');
    expect(asked).toHaveLength(1);
    expect(((browser.document.getElementById('file') as HTMLInputElement).files as unknown as File[] | null)?.length ?? 0).toBe(0);
    expect(browser.document.getElementById('name')!.textContent).toBe('선택된 파일 없음');
  });

  it('승인 창에는 어떤 파일을 어느 사이트의 어느 칸에 올리는지 보인다', async () => {
    const browser = await JsdomBrowser.open('/upload.html');
    const { tools, asked } = extension(browser);
    const { mcp } = client(tools, source());
    await mcp.uploadFile(refOf(await tools.call('snapshot'), /button "파일 선택"/), 'x');
    expect(asked[0].button).toBe('파일 올리기');
    expect(asked[0].url).toBe(PAGE);
    expect(asked[0].fields).toEqual([
      { name: '올릴 파일', value: '신청서.csv (19B)' },
      { name: '올릴 사이트', value: 'localhost:4173' },
      { name: '올릴 칸', value: expect.stringContaining('파일 선택') },
    ]);
  });

  it('조작할 사이트 목록 밖의 탭에는 올리지도 화면을 찍지도 않는다', async () => {
    const browser = await JsdomBrowser.open('/upload.html');
    const { tools, asked } = extension(browser, { sites: ['https://other.example/*'] });
    const { mcp } = client(tools, source());
    await expect(mcp.uploadFile(1, 'x')).rejects.toThrow(/조작할 사이트 목록에 없습니다/);
    await expect(mcp.screenshot()).rejects.toThrow(/조작할 사이트 목록에 없습니다/);
    await expect(tools.call('screenshot')).rejects.toThrow(/조작할 사이트 목록에 없습니다/);
    expect(asked).toHaveLength(0);
    expect(browser.shots).toBe(0);
  });

  it('확장은 크기 상한과 숨김·키 파일을 클라이언트와 별개로 다시 거절한다', async () => {
    const browser = await JsdomBrowser.open('/upload.html');
    const { tools, asked } = extension(browser);
    await tools.call('snapshot');
    const port = (m: string, ...a: unknown[]) => tools.call('dogent_port', { method: m, args: a });
    await expect(port('uploadBegin', 'i1', 'id_rsa', 'text/plain', 10)).rejects.toThrow(/키·접속 정보/);
    await expect(port('uploadBegin', 'i2', '.env', 'text/plain', 10)).rejects.toThrow(/숨김 파일/);
    await expect(port('uploadBegin', 'i3', 'big.bin', 'x', 31 * 1024 * 1024)).rejects.toThrow(/크기는/);
    // 선언한 크기와 실제로 받은 크기가 다르면 올리지 않는다
    await port('uploadBegin', 'i4', 'a.txt', 'text/plain', 99);
    await port('uploadChunk', 'i4', 0, btoa('hi'));
    const label = refOf(await tools.call('snapshot'), /button "파일 선택"/);
    expect(JSON.parse(await port('uploadFile', label, 'i4'))).toMatchObject({ ok: false, message: expect.stringContaining('선언한 크기와 다릅니다') });
    expect(asked).toHaveLength(0);
  });

  it('큰 파일은 조각으로 나눠 보내 이어 붙이고, 한 번 쓴 파일은 다시 쓸 수 없다', async () => {
    const browser = await JsdomBrowser.open('/upload.html');
    const { tools } = extension(browser);
    const bytes = new Uint8Array(UPLOAD_CHUNK_BYTES * 2 + 100).map((_, i) => i % 251);
    const { mcp, calls } = client(tools, source(bytes));
    const label = refOf(await tools.call('snapshot'), /button "파일 선택"/);
    const big = await mcp.uploadFile(label, 'x');
    expect(big.ok, big.message).toBe(true);
    expect(calls.filter((c) => c === 'uploadChunk')).toHaveLength(3);
    const got = ((browser.document.getElementById('file') as HTMLInputElement).files as unknown as File[])[0];
    expect(got.size).toBe(bytes.length);
    // 올릴 파일은 한 번 쓰면 지워진다: 같은 번호로 다시 올리라고 해도 받은 파일이 없다
    expect([...(tools as unknown as { staged: Map<string, unknown> }).staged.keys()]).toEqual([]);
    await tools.call('snapshot');
    const r = JSON.parse(await tools.call('dogent_port', { method: 'uploadFile', args: [label, 'again'] }));
    expect(r.ok).toBe(false);
  });
});

describe('파일 올리기: 클라이언트의 경로 검사', () => {
  let root: string;
  let allowed: string;
  let outside: string;
  const policy = () => ({ dirs: [allowed] });

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'dogent-upload-'));
    allowed = join(root, 'Downloads');
    outside = join(root, 'secret-area');
    mkdirSync(join(allowed, 'sub'), { recursive: true });
    mkdirSync(join(allowed, '.ssh'), { recursive: true });
    mkdirSync(join(allowed, '.hidden'), { recursive: true });
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(allowed, 'report.xlsx'), 'data');
    writeFileSync(join(allowed, 'sub', 'a.csv'), 'a,b\n1,2\n');
    writeFileSync(join(allowed, 'server.pem'), 'KEY');
    writeFileSync(join(allowed, 'my.key'), 'KEY');
    writeFileSync(join(allowed, '.env'), 'A=1');
    writeFileSync(join(allowed, 'id_rsa'), 'KEY');
    writeFileSync(join(allowed, '.ssh', 'config'), 'x');
    writeFileSync(join(allowed, '.hidden', 'a.txt'), 'x');
    writeFileSync(join(allowed, 'empty.txt'), '');
    writeFileSync(join(allowed, 'big.bin'), Buffer.alloc(2 * 1024 * 1024));
    writeFileSync(join(outside, 'passwd.txt'), 'root');
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it('올릴 수 있는 폴더 안의 파일은 통과한다 (하위 폴더 포함)', async () => {
    expect(await checkUploadPath(join(allowed, 'report.xlsx'), policy())).toMatchObject({ name: 'report.xlsx', size: 4 });
    expect((await checkUploadPath(join(allowed, 'sub', 'a.csv'), policy())).name).toBe('a.csv');
  });

  it('상대 경로, 폴더 밖, ..로 빠져나가기, 없는 파일은 거절한다', async () => {
    await expect(checkUploadPath('report.xlsx', policy())).rejects.toThrow(/전체 경로/);
    await expect(checkUploadPath(join(outside, 'passwd.txt'), policy())).rejects.toThrow(/올릴 수 있는 폴더 밖/);
    await expect(checkUploadPath(join(allowed, '..', 'secret-area', 'passwd.txt'), policy())).rejects.toThrow(/올릴 수 있는 폴더 밖/);
    await expect(checkUploadPath(join(allowed, 'sub', '..', '..', 'secret-area', 'passwd.txt'), policy())).rejects.toThrow(/올릴 수 있는 폴더 밖/);
    await expect(checkUploadPath(join(allowed, 'nope.txt'), policy())).rejects.toThrow(/찾을 수 없습니다/);
    await expect(checkUploadPath(allowed, policy())).rejects.toThrow(/올릴 수 있는 폴더 밖/);
  });

  it('올릴 수 있는 폴더 안의 심볼릭 링크(정션)가 바깥을 가리켜도 실제 경로로 막는다', async (ctx) => {
    const link = join(allowed, 'link-out');
    try {
      symlinkSync(outside, link, 'junction');
    } catch {
      return ctx.skip();
    }
    await expect(checkUploadPath(join(link, 'passwd.txt'), policy())).rejects.toThrow(/올릴 수 있는 폴더 밖/);
  });

  it('다른 드라이브(또는 다른 루트)의 폴더는 허용 폴더로 치지 않는다', async () => {
    const other = process.platform === 'win32' ? 'Z:\\nowhere' : '/definitely/not/here';
    await expect(checkUploadPath(join(outside, 'passwd.txt'), { dirs: [other] })).rejects.toThrow(/올릴 수 있는 폴더 밖/);
  });

  it('숨김·키·시스템 파일은 거절한다', async () => {
    await expect(checkUploadPath(join(allowed, 'server.pem'), policy())).rejects.toThrow(/키·접속 정보/);
    await expect(checkUploadPath(join(allowed, 'my.key'), policy())).rejects.toThrow(/키·접속 정보/);
    await expect(checkUploadPath(join(allowed, 'id_rsa'), policy())).rejects.toThrow(/키·접속 정보/);
    await expect(checkUploadPath(join(allowed, '.env'), policy())).rejects.toThrow(/숨김 파일/);
    await expect(checkUploadPath(join(allowed, '.ssh', 'config'), policy())).rejects.toThrow(/숨김 폴더/);
    await expect(checkUploadPath(join(allowed, '.hidden', 'a.txt'), policy())).rejects.toThrow(/숨김 폴더/);
    expect(sensitiveNameReason('결과.xlsx')).toBeNull();
    expect(sensitiveNameReason('cert.PEM')).not.toBeNull();
  });

  it('크기 상한(기본 10MB, 설정 가능)과 빈 파일을 검사한다', async () => {
    await expect(checkUploadPath(join(allowed, 'big.bin'), { dirs: [allowed], maxBytes: 1024 * 1024 })).rejects.toThrow(/너무 큽니다/);
    expect((await checkUploadPath(join(allowed, 'big.bin'), policy())).size).toBe(2 * 1024 * 1024);
    await expect(checkUploadPath(join(allowed, 'empty.txt'), policy())).rejects.toThrow(/빈 파일/);
    // 설정이 확장의 절대 상한(30MB)보다 커도 30MB를 넘길 수 없다
    const fs = { realpath: async (p: string) => p, stat: async () => ({ isFile: () => true, size: 31 * 1024 * 1024 }), readFile: async () => new Uint8Array() };
    await expect(checkUploadPath(join(allowed, 'x.bin'), { dirs: [allowed], maxBytes: 100 * 1024 * 1024 }, fs)).rejects.toThrow(/너무 큽니다/);
  });

  it('읽은 파일에 이름과 형식이 붙는다', async () => {
    const f = await readUploadFile(join(allowed, 'report.xlsx'), policy());
    expect(f.name).toBe('report.xlsx');
    expect(f.mime).toContain('spreadsheetml');
    expect(new TextDecoder().decode(f.bytes)).toBe('data');
  });

  it('기본 폴더는 결과 저장 폴더, 내려받기, 문서, 바탕 화면이다', () => {
    expect(defaultUploadDirs('D:\\out', 'C:\\Users\\u')).toEqual(['D:\\out', join('C:\\Users\\u', 'Downloads'), join('C:\\Users\\u', 'Documents'), join('C:\\Users\\u', 'Desktop')]);
  });

  it('McpBrowser는 읽기 검사에서 막히면 확장에 아무것도 보내지 않는다', async () => {
    const browser = await JsdomBrowser.open('/upload.html');
    const { tools, asked } = extension(browser);
    const { mcp, calls } = client(tools, (p) => readUploadFile(p, policy()));
    const r = await mcp.uploadFile(1, join(outside, 'passwd.txt'));
    expect(r.ok).toBe(false);
    expect(r.message).toContain('올릴 수 있는 폴더 밖');
    expect(calls).toEqual([]);
    expect(asked).toHaveLength(0);
    // 파일 읽기를 주지 않으면 올릴 수 없다
    expect((await client(tools).mcp.uploadFile(1, 'x')).ok).toBe(false);
  });
});

describe('upload_file 동작 (루프와 정책)', () => {
  const act = (args: object): Action => {
    const p = parseAction(JSON.stringify({ thought: '', tool: 'upload_file', args }));
    if (!p.ok) throw new Error(p.error);
    return p.action;
  };

  it('저장·상신 허용(R3)이 꺼진 자유 요청에서는 쓸 수 없고, 켜면 쓸 수 있다', async () => {
    const browser = await JsdomBrowser.open('/upload.html');
    const snap = await browser.snapshot();
    const ref = refOf(snap.items.map((i) => (i.kind === 'el' ? `[${i.ref}] ${i.role} "${i.name}"` : '')).join('\n'), /파일 선택/);
    const off = checkAction(act({ ref, path: 'C:\\x.csv' }), snap, buildFreeSkill(PAGE, false));
    expect(off).toMatchObject({ ok: false, reason: expect.stringContaining('저장·상신 허용') });
    expect(checkAction(act({ ref, path: 'C:\\x.csv' }), snap, buildFreeSkill(PAGE, true)).ok).toBe(true);
    expect(checkAction(act({ ref: 999, path: 'C:\\x.csv' }), snap, buildFreeSkill(PAGE, true)).ok).toBe(false);
    expect(checkAction(act({ ref, path: 'C:\\x.csv' }), { ...snap, url: 'https://other.example/' }, buildFreeSkill(PAGE, true)).ok).toBe(false);
  });

  function run(dryRun: boolean, allowWrite: boolean, decide = true) {
    return (async () => {
      const browser = await JsdomBrowser.open('/upload.html');
      const { tools, asked } = extension(browser, { decide });
      const { mcp } = client(tools, source());
      const llm = scriptedLlm([
        { thought: '파일 올림', tool: 'upload_file', args: { ref: 1, path: 'C:\\Users\\x\\Downloads\\신청서.csv' } },
        { thought: '끝', tool: 'finish', args: { summary: '올렸습니다' } },
      ]);
      const r = await runSkill(buildFreeSkill(PAGE, allowWrite), { request: '첨부해 줘' }, { llm, browser: mcp, ui: { ask: async () => '', approve: async () => false }, files: memoryFiles(), dryRun });
      return { r, asked, browser };
    })();
  }

  it('모델이 고른 upload_file이 확장 승인을 거쳐 파일을 넣는다', async () => {
    const { r, asked, browser } = await run(false, true);
    expect(r.status, r.message).toBe('done');
    expect(asked).toHaveLength(1);
    expect(((browser.document.getElementById('file') as HTMLInputElement).files as unknown as File[])[0].name).toBe('신청서.csv');
  });

  it('승인하지 않으면 파일이 들어가지 않는다', async () => {
    const { asked, browser } = await run(false, true, false);
    expect(asked).toHaveLength(1);
    expect(((browser.document.getElementById('file') as HTMLInputElement).files as unknown as File[] | null)?.length ?? 0).toBe(0);
  });

  it('저장·상신 허용이 꺼져 있으면 확장에 묻지도 않는다', async () => {
    const { asked, browser } = await run(false, false);
    expect(asked).toHaveLength(0);
    expect(((browser.document.getElementById('file') as HTMLInputElement).files as unknown as File[] | null)?.length ?? 0).toBe(0);
  });

  it('시험 실행은 올리기 직전에 멈춘다', async () => {
    // 시험 실행은 R3 스킬에서만 켜진다 (loop의 dryRun은 deps로 직접 준다)
    const { r, asked, browser } = await run(true, true);
    expect(r.status).toBe('dryrun');
    expect(asked).toHaveLength(0);
    expect(((browser.document.getElementById('file') as HTMLInputElement).files as unknown as File[] | null)?.length ?? 0).toBe(0);
  });
});

describe('화면 그림 도구 (screenshot)', () => {
  it('bridge 도구 목록에 있고 입력 스키마는 tab_id뿐이다', () => {
    const t = TOOLS.find((x) => x.name === 'screenshot')!;
    expect(t).toBeDefined();
    expect(t.inputSchema).toMatchObject({ type: 'object', properties: { tab_id: { type: 'integer' } } });
    expect(t.description).toContain('조작할 사이트 목록');
  });

  it('MCP image content로 내보낸다', async () => {
    const browser = await JsdomBrowser.open('/upload.html');
    const { tools } = extension(browser);
    const text = await tools.call('screenshot');
    const content = toContent('screenshot', text);
    expect(content[0]).toEqual({ type: 'image', data: 'AAAA', mimeType: 'image/jpeg' });
    expect(content[1]).toMatchObject({ type: 'text', text: expect.stringContaining('640×480') });
    // 다른 도구와 글이 아닌 형식은 글 하나로 낸다
    expect(toContent('snapshot', 'abc')).toEqual([{ type: 'text', text: 'abc' }]);
    expect(toContent('screenshot', '실패 메시지')).toEqual([{ type: 'text', text: '실패 메시지' }]);
  });

  it('비밀번호 칸이 보이는 로그인 화면은 찍지 않고 login_required로 알린다', async () => {
    const browser = await JsdomBrowser.open('/login.html');
    const { tools } = extension(browser);
    await expect(tools.call('screenshot')).rejects.toThrow(/login_required/);
    expect(browser.shots).toBe(0);
  });

  it('긴 변을 1280px 이하로 줄인다', () => {
    expect(fitSize(2560, 1440)).toEqual({ width: 1280, height: 720 });
    expect(fitSize(800, 600)).toEqual({ width: 800, height: 600 });
    expect(fitSize(1000, 3000)).toEqual({ width: 427, height: 1280 });
  });
});

describe('llm.vision', () => {
  const turn = (extra: object = {}): ChatMessage[] => {
    const skill = buildFreeSkill(PAGE, false);
    return buildTurnMessages({
      skill,
      body: skill.body,
      inputs: { request: 'x' },
      history: [],
      datasets: '(없음)',
      page: '[page] t — u',
      step: { n: 1, total: 1, text: '단계', unmet: null },
      changes: null,
      ...extra,
    });
  };

  it('꺼져 있으면 프롬프트에 look 안내도 그림도 없고, 요청 본문은 그림이 없던 때와 같다', async () => {
    const off = turn();
    expect(off[0].content).not.toContain('look');
    expect(off[1].images).toBeUndefined();
    expect(Object.keys(off[1])).toEqual(['role', 'content']);
    // vision이 꺼진 채 image를 줘도 붙지 않는다
    expect(turn({ image: 'data:image/jpeg;base64,AAAA' })).toEqual(off);

    const bodies: unknown[] = [];
    const fetchImpl = (async (_u: string, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)));
      return new Response(JSON.stringify({ choices: [{ message: { content: '{}' } }] }));
    }) as unknown as typeof fetch;
    const settings = { baseUrl: 'http://x/v1', apiKey: 'k', model: 'm', jsonMode: false, timeoutScale: 1, skillDirect: true, pathCache: true, skillsUrl: '' };
    // 설정에 vision이 없거나 false이거나, 메시지에 그림이 실려도 본문의 messages는 글뿐이다
    const withImage: ChatMessage[] = [...off.slice(0, 1), { ...off[1], images: ['data:image/jpeg;base64,AAAA'] }];
    await new OpenAiCompatClient(settings, fetchImpl).complete(withImage);
    await new OpenAiCompatClient({ ...settings, vision: false }, fetchImpl).complete(withImage);
    await new OpenAiCompatClient(settings, fetchImpl).complete(off);
    const plain = JSON.stringify(off.map((m) => ({ role: m.role, content: m.content })));
    for (const b of bodies) expect(JSON.stringify((b as { messages: unknown }).messages)).toBe(plain);
    expect(JSON.stringify(bodies)).not.toContain('image_url');
  });

  it('켜져 있으면 look 안내와 image_url(data URL) 파트가 붙는다', async () => {
    const on = turn({ vision: true, image: 'data:image/jpeg;base64,AAAA' });
    expect(on[0].content).toContain('look {}');
    expect(on[1].images).toEqual(['data:image/jpeg;base64,AAAA']);
    let body: { messages: { role: string; content: unknown }[] } | undefined;
    const fetchImpl = (async (_u: string, init: RequestInit) => {
      body = JSON.parse(String(init.body));
      return new Response(JSON.stringify({ choices: [{ message: { content: '{}' } }] }));
    }) as unknown as typeof fetch;
    const settings = { baseUrl: 'http://x/v1', apiKey: 'k', model: 'm', jsonMode: false, timeoutScale: 1, skillDirect: true, pathCache: true, skillsUrl: '', vision: true };
    await new OpenAiCompatClient(settings, fetchImpl).complete(on);
    expect(body!.messages[0].content).toBe(on[0].content);
    const parts = body!.messages[1].content as { type: string; text?: string; image_url?: { url: string } }[];
    expect(parts[0]).toEqual({ type: 'text', text: on[1].content });
    expect(parts[1]).toEqual({ type: 'image_url', image_url: { url: 'data:image/jpeg;base64,AAAA' } });
    // vision이 켜져도 그림이 없는 차례는 글뿐이다
    const noShot = turn({ vision: true });
    expect(noShot[1].images).toBeUndefined();
  });

  it('루프: 꺼져 있으면 그림을 찍지 않고 look은 거절한다. 모델에 가는 메시지에도 그림이 없다', async () => {
    const sent: ChatMessage[][] = [];
    const replies = [
      { thought: '봄', tool: 'look', args: {} },
      { thought: '끝', tool: 'finish', args: { summary: '끝' } },
    ];
    let i = 0;
    const llm = { complete: async (m: ChatMessage[]) => (sent.push(m), JSON.stringify(replies[i++])) };
    const empty = await JsdomBrowser.open('/portal.html');
    const r = await runSkill(buildFreeSkill('http://localhost:4173/portal.html', false), { request: 'x' }, { llm, browser: empty, ui: { ask: async () => '', approve: async () => false }, files: memoryFiles() });
    expect(r.status, r.message).toBe('done');
    expect(empty.shots).toBe(0);
    expect(sent.every((m) => m.every((x) => x.images === undefined))).toBe(true);
    expect(sent[0][0].content).not.toContain('look {}');
  });

  it('루프: 켜져 있으면 look 뒤 다음 판단 한 번에 그림이 붙는다', async () => {
    const browser = await JsdomBrowser.open('/wip.html'); // 요소가 많은 화면: 자동 보조는 일어나지 않는다
    const sent: ChatMessage[][] = [];
    const replies = [
      { thought: '봄', tool: 'look', args: {} },
      { thought: '대기', tool: 'wait_for', args: { text: '재공', timeout_sec: 1 } },
      { thought: '끝', tool: 'finish', args: { summary: '끝' } },
    ];
    let i = 0;
    const llm = { complete: async (m: ChatMessage[]) => (sent.push(m), JSON.stringify(replies[i++])) };
    const r = await runSkill(buildFreeSkill(`${SITE}/wip.html`, false), { request: 'x' }, { llm, browser, ui: { ask: async () => '', approve: async () => false }, files: memoryFiles(), vision: true });
    expect(r.status, r.message).toBe('done');
    expect(browser.shots).toBe(1);
    expect(sent[0][1].images).toBeUndefined();
    expect(sent[1][1].images).toEqual(['data:image/jpeg;base64,AAAA']);
    expect(sent[2][1].images).toBeUndefined();
    expect(sent[1][0].content).toContain('look {}');
  });

  it('루프: 켜져 있고 화면에 조작할 요소가 거의 없으면 자동으로 그림을 붙인다 (찍지 못해도 계속한다)', async () => {
    const browser = await JsdomBrowser.open('/portal.html');
    browser.document.body.innerHTML = '<canvas width="400" height="300"></canvas>';
    const sent: ChatMessage[][] = [];
    const llm = { complete: async (m: ChatMessage[]) => (sent.push(m), JSON.stringify({ thought: '끝', tool: 'finish', args: { summary: '끝' } })) };
    const base = { llm, ui: { ask: async () => '', approve: async () => false }, files: memoryFiles(), vision: true };
    const r = await runSkill(buildFreeSkill(`${SITE}/portal.html`, false), { request: 'x' }, { ...base, browser });
    expect(r.status, r.message).toBe('done');
    expect(browser.shots).toBe(1);
    expect(sent[0][1].images).toHaveLength(1);
    // 그림을 찍을 수 없으면 요소 목록만으로 계속한다
    browser.screenshot = async () => {
      throw new Error('로그인 화면');
    };
    sent.length = 0;
    const again = await runSkill(buildFreeSkill(`${SITE}/portal.html`, false), { request: 'x' }, { ...base, browser });
    expect(again.status, again.message).toBe('done');
    expect(sent[0][1].images).toBeUndefined();
  });
});
