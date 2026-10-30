<#
  Dogent 통합 설치 (사용자 PC, 관리자 권한 불필요)

  배포 묶음 폴더의 install.cmd 를 두 번 누르면 이 스크립트가 돈다.
    1. 프로그램을 %LOCALAPPDATA%\Dogent 에 복사 (확장, 데스크탑 앱, 오피스 도구, 터미널 클라이언트)
    2. 바탕화면·시작 메뉴 바로 가기
    3. 브라우저 확장 로드 안내 (폴더 경로를 클립보드에 넣고 확장 관리 화면을 연다)
    4. Dogent 앱 실행 → 앱이 브라우저 연결(Native Messaging)을 스스로 등록

  -Target      설치 폴더 (기본 %LOCALAPPDATA%\Dogent). 업데이트 때도 같은 폴더를 쓴다 (확장 ID는 매니페스트의 key로 정해져 있다)
  -Browser     chrome | edge | both (기본: 설치된 것)
  -NoShortcut  바로 가기를 만들지 않는다
  -Quiet       묻지 않고, 브라우저와 앱을 띄우지 않는다 (복사와 등록만)
#>
param(
  [string]$Target = (Join-Path $env:LOCALAPPDATA 'Dogent'),
  [ValidateSet('', 'chrome', 'edge', 'both')][string]$Browser = '',
  [switch]$NoShortcut,
  [switch]$Quiet
)

$ErrorActionPreference = 'Stop'
$Src = $PSScriptRoot

function Step($text) { Write-Host ''; Write-Host "▶ $text" -ForegroundColor Cyan }
function Ok($text) { Write-Host "  ✓ $text" -ForegroundColor Green }
function Warn($text) { Write-Host "  ! $text" -ForegroundColor Yellow }
function Fail($text) { Write-Host ''; Write-Host "✗ $text" -ForegroundColor Red; if (-not $Quiet) { Read-Host '닫으려면 Enter' | Out-Null }; exit 1 }

if (-not (Test-Path (Join-Path $Src 'extension\manifest.json'))) {
  Fail "배포 묶음 폴더가 아닙니다 ($Src). 개발 PC라면 install\build.cmd 로 묶음을 먼저 만드세요."
}
$info = Join-Path $Src 'build-info.txt'
Write-Host ''
Write-Host 'Dogent 설치' -ForegroundColor White
if (Test-Path $info) { Get-Content -Encoding UTF8 $info -TotalCount 3 | ForEach-Object { Write-Host "  $_" -ForegroundColor DarkGray } }
Write-Host "  설치 폴더: $Target" -ForegroundColor DarkGray

# ── 켜져 있는 앱 닫기 (실행 파일을 덮어쓰려면) ─────────────
$running = @(Get-Process -Name Dogent, dogent-office -ErrorAction SilentlyContinue)
if ($running.Count -gt 0) {
  Step 'Dogent가 켜져 있습니다'
  if (-not $Quiet) {
    $yes = Read-Host '  닫고 계속할까요? 진행 중인 실행은 멈춥니다 (Y/N)'
    if ($yes -notmatch '^[yY]') { Fail '설치를 멈췄습니다. Dogent를 닫은 뒤 다시 실행하세요.' }
  }
  $running | Stop-Process -Force
  Start-Sleep -Milliseconds 800
  Ok '닫았습니다'
}

# ── 복사 ─────────────────────────────────────────────
Step '프로그램 복사'
New-Item -ItemType Directory -Force $Target | Out-Null
$extTarget = Join-Path $Target 'extension'
# 확장 폴더는 이전 판의 남은 파일이 섞이지 않게 통째로 맞춘다 (같은 경로라 확장 ID는 그대로)
& robocopy (Join-Path $Src 'extension') $extTarget /MIR /NFL /NDL /NJH /NJS /NP | Out-Null
if ($LASTEXITCODE -ge 8) { Fail "확장 폴더를 복사하지 못했습니다 (robocopy $LASTEXITCODE)" }
Ok '브라우저 확장 → extension\'
$copied = @{}
foreach ($f in @('Dogent.exe', 'dogent-office.exe', 'dogent.mjs', '설치안내.html', 'build-info.txt', 'uninstall.cmd', 'uninstall.ps1')) {
  $from = Join-Path $Src $f
  if (Test-Path $from) { Copy-Item -Force $from $Target; $copied[$f] = $true; Ok $f }
}
if (-not $copied['Dogent.exe']) { Warn '묶음에 데스크탑 앱(Dogent.exe)이 없습니다. 확장만 설치합니다.' }

# 터미널 클라이언트: dogent 명령 (Node가 있어야 돈다)
if ($copied['dogent.mjs']) {
  $bin = Join-Path $Target 'bin'
  New-Item -ItemType Directory -Force $bin | Out-Null
  Set-Content -Encoding ASCII (Join-Path $bin 'dogent.cmd') "@echo off`r`nnode `"%~dp0..\dogent.mjs`" %*"
  $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
  if (-not $userPath) { $userPath = '' }
  if (($userPath -split ';') -notcontains $bin) {
    [Environment]::SetEnvironmentVariable('Path', (($userPath.TrimEnd(';'), $bin) -join ';').TrimStart(';'), 'User')
    Ok 'dogent 명령을 PATH에 더했습니다 (새로 연 창부터)'
  }
  if (-not (Get-Command node -ErrorAction SilentlyContinue)) { Warn '터미널 클라이언트(dogent 명령)는 Node.js가 있어야 돕니다. 데스크탑 앱은 Node 없이 됩니다.' }
}

# ── 바로 가기 ────────────────────────────────────────
if (-not $NoShortcut) {
  Step '바로 가기'
  $shell = New-Object -ComObject WScript.Shell
  $menu = Join-Path ([Environment]::GetFolderPath('Programs')) 'Dogent'
  New-Item -ItemType Directory -Force $menu | Out-Null
  function Link($path, $target, $desc) {
    $s = $shell.CreateShortcut($path)
    $s.TargetPath = $target
    $s.WorkingDirectory = $Target
    $s.Description = $desc
    $s.Save()
  }
  if ($copied['Dogent.exe']) {
    $exe = Join-Path $Target 'Dogent.exe'
    Link (Join-Path ([Environment]::GetFolderPath('Desktop')) 'Dogent.lnk') $exe 'Dogent 업무 에이전트'
    Link (Join-Path $menu 'Dogent.lnk') $exe 'Dogent 업무 에이전트'
    Ok '바탕화면 · 시작 메뉴 → Dogent'
  }
  Link (Join-Path $menu 'Dogent 설치 안내.lnk') (Join-Path $Target '설치안내.html') 'Dogent 설치·업데이트 안내'
  Link (Join-Path $menu 'Dogent 확장 폴더.lnk') $extTarget '브라우저에 로드할 확장 폴더'
  Link (Join-Path $menu 'Dogent 제거.lnk') (Join-Path $Target 'uninstall.cmd') 'Dogent 제거'
  Ok '시작 메뉴 → Dogent 폴더 (안내, 확장 폴더, 제거)'
}

# ── 브라우저 확장 ────────────────────────────────────
$browsers = @(
  @{ key = 'chrome'; name = '크롬'; page = 'chrome://extensions'; data = 'Google\Chrome\User Data'
     exe = @("$env:ProgramFiles\Google\Chrome\Application\chrome.exe", "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe", "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe") },
  @{ key = 'edge'; name = '엣지'; page = 'edge://extensions'; data = 'Microsoft\Edge\User Data'
     exe = @("${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe", "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe") }
)
foreach ($b in $browsers) { $b.path = $b.exe | Where-Object { Test-Path $_ } | Select-Object -First 1 }
$want = switch ($Browser) { 'chrome' { @('chrome') } 'edge' { @('edge') } 'both' { @('chrome', 'edge') } default { @($browsers | Where-Object { $_.path } | ForEach-Object { $_.key }) } }
$targets = @($browsers | Where-Object { $want -contains $_.key })

# 압축해제 확장은 프로필 설정 파일에 폴더 경로가 남는다. 그 경로가 있으면 이미 로드된 것이다
function Loaded($b) {
  $root = Join-Path $env:LOCALAPPDATA $b.data
  if (-not (Test-Path $root)) { return $false }
  $needle = $extTarget.Replace('\', '\\')
  foreach ($p in Get-ChildItem $root -Directory -ErrorAction SilentlyContinue) {
    foreach ($file in @('Secure Preferences', 'Preferences')) {
      $f = Join-Path $p.FullName $file
      if ((Test-Path $f) -and ([IO.File]::ReadAllText($f).IndexOf($needle, [StringComparison]::OrdinalIgnoreCase) -ge 0)) { return $true }
    }
  }
  return $false
}

Step '브라우저에 확장 로드'
if ($targets.Count -eq 0) { Warn '크롬이나 엣지를 찾지 못했습니다. 설치된 브라우저에서 아래 순서로 로드하세요.' }
$pending = @($targets | Where-Object { -not (Loaded $_) })
foreach ($b in $targets) { if ($pending -notcontains $b) { Ok "$($b.name): 이미 로드됨 (업데이트였다면 확장 관리 화면에서 Dogent의 새로고침 ↻ 을 누르세요)" } }
if ($pending.Count -gt 0 -or $targets.Count -eq 0) {
  try { Set-Clipboard -Value $extTarget; $clip = ' (클립보드에 복사함)' } catch { $clip = '' }
  Write-Host ''
  Write-Host "  확장 폴더: $extTarget$clip" -ForegroundColor White
  Write-Host '  1. 열린 확장 관리 화면 오른쪽 위의 [개발자 모드]를 켭니다'
  Write-Host '  2. [압축해제된 확장 프로그램을 로드합니다] → 폴더 칸에 Ctrl+V → [폴더 선택]'
  Write-Host '  3. 툴바의 퍼즐 조각에서 Dogent를 고정(핀)하면 쓰기 편합니다'
  if (-not $Quiet) {
    foreach ($b in $pending) {
      if ($b.path) { Start-Process $b.path $b.page }
      Write-Host "  → $($b.name)에서 $($b.page) 를 열었습니다 (안 열렸으면 주소창에 직접 입력)" -ForegroundColor DarkGray
    }
    for ($try = 0; $try -lt 3 -and $pending.Count -gt 0; $try++) {
      $answer = Read-Host '  로드했으면 Enter (나중에 하려면 s)'
      if ($answer -match '^[sS]') { break }
      $pending = @($pending | Where-Object { -not (Loaded $_) })
      foreach ($b in $targets) { if ((Loaded $b)) { Ok "$($b.name): 확인됨" } }
      if ($pending.Count -gt 0) { Warn "아직 보이지 않습니다: $(($pending | ForEach-Object { $_.name }) -join ', ') (브라우저가 설정을 쓰는 데 몇 초 걸릴 수 있습니다)" }
    }
  }
}

# ── 앱 실행 → 연결 등록 ─────────────────────────────
Step '마무리'
if ($copied['Dogent.exe'] -and -not $Quiet) {
  Start-Process (Join-Path $Target 'Dogent.exe')
  Ok 'Dogent 앱을 띄웠습니다. 앱이 처음 뜰 때 브라우저 연결을 스스로 등록합니다'
}
Write-Host ''
Write-Host '남은 한 가지: 브라우저의 Dogent 사이드 패널 → 설정 → 클라이언트 연결' -ForegroundColor White
Write-Host '  방식을 [Native Messaging] 으로 고르고 저장 (토큰은 자동으로 전달됩니다)'
Write-Host '  앱 위쪽에 브라우저 이름이 보이면 연결된 것입니다'
Write-Host ''
Write-Host "설치를 마쳤습니다. 안내서: $(Join-Path $Target '설치안내.html')" -ForegroundColor Green
if (-not $Quiet) { Read-Host '닫으려면 Enter' | Out-Null }
