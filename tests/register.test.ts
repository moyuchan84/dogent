import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { findInstalledExtensions, hostHome, isExtensionId, launcherPath } from '../bridge/register.mjs';

const id = 'abcdefghijklmnopabcdefghijklmnop';
const saved = process.env.LOCALAPPDATA;
const savedHome = process.env.DOGENT_HOME;
afterEach(() => {
  process.env.LOCALAPPDATA = saved;
  if (savedHome === undefined) delete process.env.DOGENT_HOME;
  else process.env.DOGENT_HOME = savedHome;
});

describe('호스트 파일 폴더', () => {
  it('DOGENT_HOME이 있으면 그 아래 native', () => {
    process.env.DOGENT_HOME = join('X:', 'apps', 'Dogent');
    expect(hostHome()).toBe(join('X:', 'apps', 'Dogent', 'native'));
    expect(launcherPath()).toBe(join('X:', 'apps', 'Dogent', 'native', 'native-host.cmd'));
  });

  it('없으면 D:\\Multimedia가 있을 때 그 아래, 아니면 ~/.dogent', () => {
    delete process.env.DOGENT_HOME;
    const multimedia = process.platform === 'win32' && existsSync('D:\\Multimedia');
    expect(hostHome()).toBe(multimedia ? join('D:\\Multimedia', 'Dogent', 'native') : join(homedir(), '.dogent'));
  });
});

describe('Native Messaging 등록', () => {
  it('확장 ID 형식은 a~p 32글자', () => {
    expect(isExtensionId(id)).toBe(true);
    expect(isExtensionId('short')).toBe(false);
    expect(isExtensionId(`${id.slice(0, 31)}z`)).toBe(false);
  });

  it('브라우저 프로필에서 Dogent 확장만 찾는다', () => {
    const local = mkdtempSync(join(tmpdir(), 'dogent-ud-'));
    process.env.LOCALAPPDATA = local;
    const profile = join(local, 'Microsoft', 'Edge', 'User Data', 'Default');
    mkdirSync(profile, { recursive: true });
    writeFileSync(
      join(profile, 'Preferences'),
      JSON.stringify({ extensions: { settings: { [id]: { manifest: { name: 'Dogent' } }, [id.replace(/a/g, 'b')]: { manifest: { name: '다른 확장' } } } } }),
    );
    expect(findInstalledExtensions()).toEqual([{ id, browser: 'edge', profile: 'Default' }]);
  });
});
