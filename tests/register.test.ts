import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { findInstalledExtensions, isExtensionId } from '../bridge/register.mjs';

const id = 'abcdefghijklmnopabcdefghijklmnop';
const saved = process.env.LOCALAPPDATA;
afterEach(() => (process.env.LOCALAPPDATA = saved));

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
