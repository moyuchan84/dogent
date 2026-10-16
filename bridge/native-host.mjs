// Native Messaging 중계. 크롬(또는 엣지)이 Dogent 확장의 요청으로 이 프로그램을 띄운다.
// 크롬과는 stdin/stdout(4바이트 길이 + JSON)으로, 브리지(hub.mjs)와는 파이프(줄 단위 JSON)로 주고받으며 내용은 건드리지 않는다.
// 확인 절차(토큰)는 확장과 브리지가 직접 한다. 이 프로그램은 토큰을 모른다.
//
// 설치: pnpm bridge:install (호스트 매니페스트와 레지스트리를 등록한다)
import { connect } from 'node:net';
import { userInfo } from 'node:os';
import { encodeNative, lineReader, nativeReader, pipePath } from './protocol.mjs';

const PIPE = process.env.DOGENT_BRIDGE_PIPE ?? pipePath(userInfo().username);
const RETRY_MS = 1000;

let sock = null;
/** 브리지에 붙기 전에 확장이 보낸 메시지 */
const queue = [];
let told = false;

const toChrome = (msg) => process.stdout.write(encodeNative(msg));

function connectHub() {
  const s = connect(PIPE);
  s.on('connect', () => {
    sock = s;
    told = false;
    toChrome({ type: 'status', state: 'hub-connected' });
    for (const m of queue.splice(0)) s.write(`${JSON.stringify(m)}\n`);
  });
  s.on('data', lineReader((m) => toChrome(m)));
  s.on('error', () => {});
  s.on('close', () => {
    const was = sock === s;
    sock = null;
    // 브리지가 아직 안 떴거나 꺼졌다. 확장에 알리고 다시 붙어 본다.
    if (was || !told) {
      toChrome({ type: 'status', state: 'waiting-hub', detail: 'Dogent 클라이언트(브리지)가 실행 중이 아닙니다' });
      told = true;
    }
    setTimeout(connectHub, RETRY_MS);
  });
}

process.stdin.on(
  'data',
  nativeReader((m) => {
    if (sock) sock.write(`${JSON.stringify(m)}\n`);
    else queue.push(m);
  }),
);
// 크롬이 연결을 끊으면 끝낸다.
process.stdin.on('end', () => process.exit(0));
connectHub();
