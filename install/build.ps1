<#
  Dogent 빌드와 배포 묶음 만들기 (개발 PC에서 한 번에)

  두 번 누르기:  install\build.cmd   (모드를 물어본다)
  명령으로:      powershell -NoProfile -ExecutionPolicy Bypass -File install\build.ps1 -Mode company -Zip

  -Mode        dev      모의 모델 (localhost:4174)
               home     .env.home.local    (집: 로컬 Ollama)
               company  .env.company.local (회사: 사내 Gemma)
  -Parts       extension,client,office,desktop 중 고른 것만 (기본: 전부)
  -NoPackage   묶음 폴더(release\Dogent-<모드>-<판>)를 만들지 않는다
  -Zip         묶음을 zip으로도 만든다 (사내 배포용)
  -Install     다 만든 뒤 이 PC에 바로 설치한다 (묶음의 install.ps1)
  -Reinstall   node_modules가 있어도 pnpm install을 다시 한다
  -Test        빌드 전에 typecheck와 단위 시험을 돌린다

  회사 모드로 만든 묶음에는 API 키가 들어간다. 저장소·메일·메신저로 옮기지 않고 사내에서만 나눈다.
#>
param(
  [string]$Mode = '',
  [string[]]$Parts = @('extension', 'client', 'office', 'desktop'),
  [switch]$NoPackage,
  [switch]$Zip,
  [switch]$Install,
  [switch]$Reinstall,
  [switch]$Test
)

$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
Set-Location $Root

function Step($text) { Write-Host ''; Write-Host "▶ $text" -ForegroundColor Cyan }
function Ok($text) { Write-Host "  ✓ $text" -ForegroundColor Green }
function Warn($text) { Write-Host "  ! $text" -ForegroundColor Yellow }
function Fail($text) { Write-Host ''; Write-Host "✗ $text" -ForegroundColor Red; exit 1 }

# pnpm 스크립트를 돌리고, 실패하면 멈춘다
function Run([string]$what, [string[]]$cmd) {
  Write-Host "  > $($cmd -join ' ')" -ForegroundColor DarkGray
  & $cmd[0] $cmd[1..($cmd.Length - 1)]
  if ($LASTEXITCODE -ne 0) { Fail "$what 실패 (종료 코드 $LASTEXITCODE). 위의 메시지를 확인하세요." }
}

# ── 모드 ─────────────────────────────────────────────
if (-not $Mode) {
  Write-Host ''
  Write-Host 'Dogent 빌드 — 어떤 설정으로 만들까요?' -ForegroundColor White
  Write-Host '  1) company  회사 (사내 Gemma, .env.company.local)'
  Write-Host '  2) home     집 (로컬 Ollama, .env.home.local)'
  Write-Host '  3) dev      모의 모델 (시험용)'
  $pick = Read-Host '번호'
  switch ($pick) { '1' { $Mode = 'company' } '2' { $Mode = 'home' } '3' { $Mode = 'dev' } default { Fail '1, 2, 3 중에서 고르세요.' } }
}
if ($Mode -notin @('dev', 'home', 'company')) { Fail "모드는 dev, home, company 중 하나입니다 (받은 값: $Mode)" }
# cmd에서 -Parts a,b 로 넘기면 한 글자열로 오므로 쉼표로 나눈다
$Parts = @($Parts -split ',' | ForEach-Object { $_.Trim().ToLower() } | Where-Object { $_ })
foreach ($p in $Parts) { if ($p -notin @('extension', 'client', 'office', 'desktop')) { Fail "모르는 부분: $p (extension, client, office, desktop)" } }
$modeArg = if ($Mode -eq 'dev') { @() } else { @('--mode', $Mode) }
$version = (Get-Content -Raw -Encoding UTF8 package.json | ConvertFrom-Json).version
Write-Host ''
Write-Host "Dogent $version · 모드 $Mode · $($Parts -join ', ')" -ForegroundColor White

# ── 준비물 ───────────────────────────────────────────
Step '준비물 확인'
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) { Fail 'Node.js가 없습니다. https://nodejs.org 에서 LTS(22 이상)를 설치한 뒤 새 창에서 다시 실행하세요.' }
$nodeVer = (& node -v).TrimStart('v')
if ([int]($nodeVer.Split('.')[0]) -lt 22) { Fail "Node.js $nodeVer 입니다. 22 이상이 필요합니다." }
Ok "Node.js $nodeVer"
if (-not (Get-Command pnpm -ErrorAction SilentlyContinue)) {
  Warn 'pnpm이 없어 corepack으로 켭니다'
  try { & corepack enable pnpm 2>$null } catch { }
  if (-not (Get-Command pnpm -ErrorAction SilentlyContinue)) { Fail 'pnpm을 켜지 못했습니다. 관리자 창에서 "npm install -g pnpm" 후 다시 실행하세요.' }
}
Ok "pnpm $(& pnpm -v)"

if ($Mode -ne 'dev') {
  $envFile = ".env.$Mode.local"
  if (-not (Test-Path $envFile)) {
    Copy-Item ".env.$Mode.example" $envFile
    Start-Process notepad $envFile
    Fail "$envFile 이 없어 예시에서 만들었습니다. 메모장에서 값을 채우고 저장한 뒤 다시 실행하세요."
  }
  if ((Get-Content -Raw -Encoding UTF8 $envFile) -match '=\((api_base_url|credential_key|model|user_type)\)') {
    Start-Process notepad $envFile
    Fail "$envFile 에 아직 채우지 않은 (…) 값이 있습니다. API 제공 측에서 받은 값으로 바꾸세요."
  }
  Ok "빌드 설정 $envFile"
}

if ($Reinstall -or -not (Test-Path node_modules)) {
  Step '의존성 설치 (pnpm install)'
  if ($env:ELECTRON_MIRROR) { Ok "Electron 미러: $env:ELECTRON_MIRROR" }
  Run 'pnpm install' @('pnpm', 'install')
} else {
  Ok 'node_modules 있음 (다시 받으려면 -Reinstall)'
}

# pnpm 스크립트(pnpm build 등)를 거치지 않고 도구를 바로 부른다. pnpm 판이 node_modules를 만든 판과 다르면
# pnpm이 스크립트 실행 전에 node_modules를 다시 깔려고 멈추기 때문이다. 명령은 package.json의 스크립트와 같다.
$bin = Join-Path $Root 'node_modules\.bin'
$wxt = Join-Path $bin 'wxt.CMD'
$builder = Join-Path $bin 'electron-builder.CMD'
$tsc = Join-Path $bin 'tsc.CMD'
$vitest = Join-Path $bin 'vitest.CMD'

if ($Test) {
  Step '검사 (typecheck, 단위 시험)'
  Run 'typecheck' @($tsc, '--noEmit')
  Run '단위 시험' @($vitest, 'run')
}

# ── 빌드 ─────────────────────────────────────────────
$extDir = if ($Mode -eq 'dev') { '.output\chrome-mv3' } else { ".output\chrome-mv3-$Mode" }
$deskExe = "desktop\release\Dogent-$version.exe"

if ('extension' -in $Parts) {
  Step '브라우저 확장'
  Run '확장 빌드' (@($wxt, 'build') + $modeArg)
  Ok $extDir
}
if ('client' -in $Parts) {
  Step '터미널 클라이언트'
  Run '클라이언트 빌드' (@('node', 'client/build.mjs') + $modeArg)
  Ok 'client\dist\dogent.mjs'
}
if ('office' -in $Parts) {
  # 데스크탑 실행본에 함께 넣으려면 데스크탑보다 먼저 만든다
  Step '오피스 도구 (Excel)'
  Run '오피스 도구 빌드' @('node', 'office/build.mjs')
  Ok 'office\dist\dogent-office.exe'
}
if ('desktop' -in $Parts) {
  Step '데스크탑 앱 (한 파일 실행본)'
  Run '데스크탑 빌드' (@('node', 'desktop/build.mjs') + $modeArg)
  Run '실행본 만들기' @($builder, '--projectDir', 'desktop/dist', '--config', '../electron-builder.yml')
  Ok $deskExe
}

if ($NoPackage) { Write-Host ''; Write-Host '빌드를 마쳤습니다 (묶음은 만들지 않음).' -ForegroundColor Green; exit 0 }

# ── 배포 묶음 ────────────────────────────────────────
Step '배포 묶음'
$name = "Dogent-$Mode-$version"
$pkg = Join-Path $Root "release\$name"
if (Test-Path $pkg) { Remove-Item -Recurse -Force $pkg }
New-Item -ItemType Directory -Force $pkg | Out-Null

$included = @()
# 이번에 빌드하지 않은 부분은 마지막 결과물을 넣는다. 다른 모드로 만든 것일 수 있으므로 표시한다
function Add($part, $from, $to, $label) {
  if (-not (Test-Path $from)) { Warn "$label 이(가) 없어 빼고 묶습니다: $from"; return }
  Copy-Item -Recurse $from $to
  if ($Parts -contains $part) { $script:included += $label }
  else { $script:included += "$label — 이번에 빌드하지 않음, $((Get-Item $from).LastWriteTime.ToString('yyyy-MM-dd HH:mm')) 결과물"; Warn "$label 은(는) 이전 결과물입니다. 모드가 맞는지 확인하세요 (-Parts 에 $part 를 넣으면 다시 빌드)" }
}
Add 'extension' $extDir (Join-Path $pkg 'extension') 'extension\ (브라우저 확장)'
Add 'desktop' $deskExe (Join-Path $pkg 'Dogent.exe') 'Dogent.exe (데스크탑 앱)'
Add 'office' 'office\dist\dogent-office.exe' $pkg 'dogent-office.exe (오피스 도구)'
Add 'client' 'client\dist\dogent.mjs' $pkg 'dogent.mjs (터미널 클라이언트, Node 필요)'
foreach ($f in @('install.cmd', 'install.ps1', 'uninstall.cmd', 'uninstall.ps1')) { Copy-Item (Join-Path $PSScriptRoot $f) $pkg }
Copy-Item 'docs\12-install-guide.html' (Join-Path $pkg '설치안내.html')

# 모드가 다른 빌드가 섞이지 않았는지 묶음에 적어 둔다
$commit = try { (& git rev-parse --short HEAD 2>$null) } catch { '' }
@(
  "Dogent $version"
  "모드: $Mode"
  "만든 때: $(Get-Date -Format 'yyyy-MM-dd HH:mm')"
  "커밋: $commit"
  "빌드한 부분: $($Parts -join ', ')"
  ''
  '들어 있는 것:'
  ($included | ForEach-Object { "  $_" })
  ''
  '설치: install.cmd 를 두 번 누릅니다. 자세한 것은 설치안내.html'
) | Set-Content -Encoding UTF8 (Join-Path $pkg 'build-info.txt')
foreach ($i in $included) { Ok $i }
Ok "release\$name"

if ($Zip) {
  $zipPath = "$pkg.zip"
  if (Test-Path $zipPath) { Remove-Item -Force $zipPath }
  Compress-Archive -Path "$pkg\*" -DestinationPath $zipPath
  Ok "release\$name.zip ($([math]::Round((Get-Item $zipPath).Length / 1MB, 1))MB)"
}
if ($Mode -eq 'company') { Warn '회사 모드 묶음에는 API 키가 들어 있습니다. 사내에서만 나누세요.' }

Write-Host ''
Write-Host '완료했습니다.' -ForegroundColor Green
if ($Install) {
  & (Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe') -NoProfile -ExecutionPolicy Bypass -File (Join-Path $pkg 'install.ps1')
  exit $LASTEXITCODE
}
Write-Host "이 PC에 설치하려면: release\$name\install.cmd"
