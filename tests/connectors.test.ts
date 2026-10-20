import { describe, expect, it } from 'vitest';
import { nameFromUrl, parsePasted, splitCommand } from '../client/src/connectors';

describe('splitCommand', () => {
  it('따옴표를 지키고 이어진 줄을 한 줄로 본다', () => {
    const text = ['a "b c" \'d e\' f', String.fromCharCode(92), ' g'].join('\n');
    expect(splitCommand(text)).toEqual(['a', 'b c', 'd e', 'f', 'g']);
    expect(() => splitCommand('a "b')).toThrow(/따옴표/);
  });
});

describe('parsePasted', () => {
  it('claude mcp add 명령', () => {
    const p = parsePasted('claude mcp add --transport http --scope user github-mcp http://ssai.samsungds.net:9999/mcp');
    expect(p).toMatchObject({ kind: 'mcp', scope: 'user', entries: { 'github-mcp': { url: 'http://ssai.samsungds.net:9999/mcp', transport: 'http' } } });
  });
  it('프롬프트 기호와 npx/dogent 접두를 뗀다', () => {
    expect(parsePasted('$ dogent mcp add x http://h/mcp')).toMatchObject({ kind: 'mcp', entries: { x: { url: 'http://h/mcp' } } });
  });
  it('stdio 명령과 헤더', () => {
    const p = parsePasted('claude mcp add -e KEY=1 mes -- npx -y @co/mes-mcp');
    expect(p).toMatchObject({ kind: 'mcp', entries: { mes: { command: 'npx', args: ['-y', '@co/mes-mcp'], env: { KEY: '1' } } } });
  });
  it('mcpServers JSON, 서버 하나짜리 JSON은 주소로 이름을 짓는다', () => {
    expect(parsePasted('{"mcpServers":{"a":{"url":"http://h/mcp"}}}')).toMatchObject({ entries: { a: { url: 'http://h/mcp' } } });
    expect(parsePasted('{"type":"http","url":"http://ssai.x.net/mcp"}')).toMatchObject({ entries: { ssai: { url: 'http://ssai.x.net/mcp' } } });
  });
  it('서버 주소만 붙이면 http 서버로 본다', () => {
    expect(parsePasted('http://ssai.samsungds.net:9999/mcp')).toMatchObject({ kind: 'mcp', entries: { ssai: { transport: 'http' } } });
  });
  it('npx skills add 는 스킬로 읽는다', () => {
    expect(parsePasted('npx skills add https://agent.samsungds.net:3355/skills/p4nFpt45gv0d -a claude-code')).toEqual({
      kind: 'skill',
      url: 'https://agent.samsungds.net:3355/skills/p4nFpt45gv0d',
      agent: 'claude-code',
    });
  });
  it('모르는 글과 빈 글은 이유와 함께 던진다', () => {
    expect(() => parsePasted('   ')).toThrow(/비어/);
    expect(() => parsePasted('hello world')).toThrow(/알아보지/);
    expect(() => parsePasted('{bad')).toThrow(/JSON/);
  });
  it('이름 짓기', () => {
    expect(nameFromUrl('http://ssai.samsungds.net:9999/mcp')).toBe('ssai');
    expect(nameFromUrl('nonsense')).toBe('mcp');
  });
});
