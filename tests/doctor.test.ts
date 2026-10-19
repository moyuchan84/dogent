import { describe, expect, it } from 'vitest';
import { judgeManifest, judgePolicy, parseLauncher, parseRegValues, readPolicy } from '../client/src/doctor';

const ID = 'a'.repeat(32);
const OTHER = 'b'.repeat(32);
const levels = (f: { level: string }[]) => f.map((x) => x.level);

describe('dogent doctor', () => {
  it('reg query 출력에서 값을 읽는다 (기본값, 숫자, 빈 값)', () => {
    const out = [
      '',
      'HKEY_CURRENT_USER\\Software\\Google\\Chrome\\NativeMessagingHosts\\com.dogent.bridge',
      '    (기본값)    REG_SZ    C:\\Users\\a b\\.dogent\\com.dogent.bridge.json',
      '    NativeMessagingUserLevelHosts    REG_DWORD    0x0',
      '    1    REG_SZ    *',
      '    empty    REG_SZ',
      '',
    ].join('\r\n');
    expect(parseRegValues(out)).toEqual({
      '(기본값)': 'C:\\Users\\a b\\.dogent\\com.dogent.bridge.json',
      NativeMessagingUserLevelHosts: '0x0',
      '1': '*',
      empty: '',
    });
  });

  it('정책: 막는 것이 없으면 통과', () => {
    expect(levels(judgePolicy('크롬', { blocklist: [], allowlist: [] }))).toEqual(['ok']);
  });

  it('정책: 블록리스트 *는 막고, 허용 목록에 호스트가 있으면 푼다', () => {
    expect(levels(judgePolicy('크롬', { blocklist: ['*'], allowlist: [] }))).toEqual(['error']);
    expect(levels(judgePolicy('크롬', { blocklist: ['*'], allowlist: ['com.dogent.bridge'] }))).toEqual(['ok']);
    expect(levels(judgePolicy('엣지', { blocklist: ['com.dogent.bridge'], allowlist: [] }))).toEqual(['error']);
  });

  it('정책: 사용자 수준 등록을 막으면 WebSocket을 안내한다', () => {
    const f = judgePolicy('엣지', { userLevelHosts: 0, blocklist: [], allowlist: [] });
    expect(levels(f)).toEqual(['error']);
    expect(f[0].hint).toMatch(/WebSocket/);
  });

  it('정책을 HKLM과 HKCU에서 모아 읽는다', () => {
    const reg: Record<string, Record<string, string>> = {
      'HKLM\\Software\\Policies\\Google\\Chrome': { NativeMessagingUserLevelHosts: '0' },
      'HKLM\\Software\\Policies\\Google\\Chrome\\NativeMessagingBlocklist': { '1': '*' },
      'HKCU\\Software\\Policies\\Google\\Chrome\\NativeMessagingAllowlist': { '1': 'com.x.y' },
    };
    expect(readPolicy('Google\\Chrome', (k) => reg[k] ?? null)).toEqual({ userLevelHosts: 0, blocklist: ['*'], allowlist: ['com.x.y'] });
  });

  it('매니페스트: 정상', () => {
    const m = { name: 'com.dogent.bridge', path: 'C:/h.cmd', allowed_origins: [`chrome-extension://${ID}/`] };
    expect(judgeManifest(m, [ID], () => true)).toEqual([]);
  });

  it('매니페스트: 실행 파일이 없거나, 프로필의 확장 ID가 허용 목록에 없으면 오류', () => {
    const m = { name: 'com.dogent.bridge', path: 'C:/h.cmd', allowed_origins: [`chrome-extension://${ID}/`] };
    expect(judgeManifest(m, [], () => false)[0].text).toMatch(/실행 파일이 없습니다/);
    const wrongId = judgeManifest(m, [OTHER], () => true);
    expect(levels(wrongId)).toEqual(['error']);
    expect(wrongId[0].text).toContain(OTHER);
    expect(judgeManifest(null, [], () => true)[0].level).toBe('error');
  });

  it('호스트 실행 파일(cmd)에서 프로그램과 스크립트를 꺼낸다', () => {
    const cmd = '@echo off\r\nset ELECTRON_RUN_AS_NODE=1\r\n"C:\\Program Files\\Dogent\\Dogent.exe" "C:\\Users\\a\\.dogent\\native-host.mjs" %*\r\n';
    expect(parseLauncher(cmd)).toEqual({ runtime: 'C:\\Program Files\\Dogent\\Dogent.exe', script: 'C:\\Users\\a\\.dogent\\native-host.mjs' });
    expect(parseLauncher('@echo off\r\n')).toBeNull();
  });
});
