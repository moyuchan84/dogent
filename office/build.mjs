// dogent-office.exe를 빌드한다.
//
//   pnpm office:build   → office/dist/dogent-office.exe
//
// 윈도우에 기본으로 있는 .NET Framework 4.x의 C# 컴파일러(csc.exe)를 쓴다. Visual Studio나 .NET SDK를 설치하지 않아도 된다.
// 다른 컴파일러를 쓰려면 DOGENT_CSC에 경로를 준다.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..');
const SRC = join(ROOT, 'office/src');
const OUT = join(ROOT, 'office/dist');
const windir = process.env.WINDIR ?? 'C:\\Windows';
const framework = [join(windir, 'Microsoft.NET/Framework64/v4.0.30319'), join(windir, 'Microsoft.NET/Framework/v4.0.30319')].find((d) =>
  existsSync(join(d, 'csc.exe')),
);
const csc = process.env.DOGENT_CSC ?? (framework && join(framework, 'csc.exe'));
if (!csc || !existsSync(csc)) {
  console.error('C# 컴파일러(csc.exe)를 찾지 못했습니다. 윈도우의 .NET Framework 4.x가 있어야 합니다 (C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319).');
  process.exit(1);
}

mkdirSync(OUT, { recursive: true });
const sources = readdirSync(SRC).filter((f) => f.endsWith('.cs')).map((f) => join(SRC, f));
const refs = ['System.dll', 'System.Core.dll', 'Microsoft.CSharp.dll', 'System.Web.Extensions.dll'];
const exe = join(OUT, 'dogent-office.exe');
try {
  const out = execFileSync(
    csc,
    ['/nologo', '/target:exe', '/platform:anycpu', '/optimize+', '/utf8output', '/codepage:65001', `/out:${exe}`, ...refs.map((r) => `/reference:${r}`), ...sources],
    { encoding: 'utf8' },
  );
  if (out.trim()) console.log(out.trim());
} catch (e) {
  console.error(e.stdout || e.message);
  process.exit(1);
}
console.log(`${exe} (컴파일러: ${csc})`);
