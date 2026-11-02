<#
  Dogent 통합 설치 (사용자 PC, 관리자 권한 불필요)

  배포 묶음 폴더의 install.cmd 를 두 번 누르면 이 스크립트가 돈다.
    1. 프로그램을 설치 폴더에 복사 (확장, 데스크탑 앱, 오피스 도구, 터미널 클라이언트)
    2. 바탕화면·시작 메뉴 바로 가기
    3. 브라우저 확장 로드 안내 (폴더 경로를 클립보드에 넣고 확장 관리 화면을 연다)
    4. Dogent 앱 실행 → 앱이 브라우저 연결(Native Messaging)을 스스로 등록

  -Target      설치 폴더. 업데이트 때도 같은 폴더를 쓴다 (확장 ID는 매니페스트의 key로 정해져 있다)
               비우면 차례로: 환경 변수 DOGENT_HOME → D:\Multimedia\Dogent (D:\Multimedia가 있을 때) → %LOCALAPPDATA%\Dogent
               회사 PC는 보안 프로그램(EDM/NASCA) 때문에 크롬이 D:\Multimedia 아래 폴더의 확장만 로드할 수 있어 그곳이 기본이다
               기본 위치(D:\Multimedia\Dogent)에 설치하는데 %LOCALAPPDATA%\Dogent 에 예전 설치가 남아 있으면 지운다
               (-Target 이나 DOGENT_HOME 으로 직접 정했으면 지우지 않는다. 내 스킬·설정은 %USERPROFILE%\.dogent 라 그대로)
  -Browser     chrome | edge | both (기본: 설치된 것)
  -NoShortcut  바로 가기를 만들지 않는다
  -Quiet       묻지 않고, 브라우저와 앱을 띄우지 않는다 (복사와 등록만)
  -Update      업데이트 (update.cmd가 쓴다). 켜진 앱은 묻지 않고 닫았다가 다시 띄우고, 이미 로드한 확장은
               건드리지 않는다 (확장이 새 판을 알아채고 스스로 다시 읽는다). 끝나고 Enter를 기다리지 않는다
#>
param(
  [string]$Target = '',
  [ValidateSet('', 'chrome', 'edge', 'both')][string]$Browser = '',
  [switch]$NoShortcut,
  [switch]$Quiet,
  [switch]$Update
)

$ErrorActionPreference = 'Stop'
$Src = $PSScriptRoot

function Step($text) { Write-Host ''; Write-Host "▶ $text" -ForegroundColor Cyan }
function Ok($text) { Write-Host "  ✓ $text" -ForegroundColor Green }
function Warn($text) { Write-Host "  ! $text" -ForegroundColor Yellow }
function Fail($text) { Write-Host ''; Write-Host "✗ $text" -ForegroundColor Red; if (-not $Quiet) { Read-Host '닫으려면 Enter' | Out-Null }; exit 1 }

# 설치 폴더: 회사 보안 프로그램이 크롬의 확장 로드를 D:\Multimedia 아래로만 허용하므로 그곳을 먼저 쓴다
$OldDefault = Join-Path $env:LOCALAPPDATA 'Dogent'
$AutoTarget = -not $Target -and -not $env:DOGENT_HOME   # 직접 정한 폴더면 예전 설치를 지우지 않는다
if (-not $Target) {
  $Target = if ($env:DOGENT_HOME) { $env:DOGENT_HOME }
            elseif (Test-Path 'D:\Multimedia') { 'D:\Multimedia\Dogent' }
            else { $OldDefault }
}
$Target = [IO.Path]::GetFullPath($Target).TrimEnd('\')

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
$wasRunning = @($running | Where-Object { $_.ProcessName -eq 'Dogent' }).Count -gt 0
if ($running.Count -gt 0) {
  Step 'Dogent가 켜져 있습니다'
  if (-not $Quiet -and -not $Update) {
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
& (Join-Path $env:SystemRoot 'System32\robocopy.exe') (Join-Path $Src 'extension') $extTarget /MIR /NFL /NDL /NJH /NJS /NP | Out-Null
if ($LASTEXITCODE -ge 8) { Fail "확장 폴더를 복사하지 못했습니다 (robocopy $LASTEXITCODE)" }
Ok '브라우저 확장 → extension\'
$copied = @{}
# 데스크탑 앱은 압축을 푼 폴더(app\)로 둔다. 크롬이 이 app\Dogent.exe를 Native Messaging 호스트로 띄운다.
# (예전 묶음의 한 파일 Dogent.exe는 호스트로 띄우면 응답하지 않아 확장과 연결되지 않았다)
$appExe = Join-Path $Target 'app\Dogent.exe'
if (Test-Path (Join-Path $Src 'app\Dogent.exe')) {
  # 크롬이 호스트를 다시 띄워 파일을 잠깐 잡을 수 있어 몇 번 다시 해 본다 (기본값은 30초씩 백만 번)
  & (Join-Path $env:SystemRoot 'System32\robocopy.exe') (Join-Path $Src 'app') (Join-Path $Target 'app') /MIR /R:5 /W:2 /NFL /NDL /NJH /NJS /NP | Out-Null
  if ($LASTEXITCODE -ge 8) { Fail "데스크탑 앱 폴더를 복사하지 못했습니다 (robocopy $LASTEXITCODE). 브라우저를 닫고 다시 실행하세요" }
  $copied['Dogent.exe'] = $true
  Ok '데스크탑 앱 → app\Dogent.exe'
  $oldExe = Join-Path $Target 'Dogent.exe'
  if (Test-Path $oldExe) { Remove-Item -Force $oldExe -ErrorAction SilentlyContinue; Ok '예전 한 파일 실행본(Dogent.exe)을 지웠습니다' }
}
foreach ($f in @('dogent-office.exe', 'dogent.mjs', '설치안내.html', 'build-info.txt', 'uninstall.cmd', 'uninstall.ps1')) {
  $from = Join-Path $Src $f
  if (Test-Path $from) { Copy-Item -Force $from $Target; $copied[$f] = $true; Ok $f }
}
if (-not $copied['Dogent.exe']) { Warn '묶음에 데스크탑 앱(app\Dogent.exe)이 없습니다. 확장만 설치합니다.' }

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

# ── 예전 기본 위치(%LOCALAPPDATA%\Dogent)의 설치 정리 ─────────
# 설치 폴더가 D:\Multimedia\Dogent 로 바뀌면 예전 폴더는 쓰지 않는다. 남겨 두면 PATH의 dogent 명령과
# 확장 로드 위치가 헷갈리므로 지운다. Dogent 설치 폴더로 보일 때만 지운다 (내 스킬·설정은 %USERPROFILE%\.dogent)
if ($AutoTarget -and $OldDefault.TrimEnd('\') -ne $Target -and(Test-Path (Join-Path $OldDefault 'extension\manifest.json')) -and (Test-Path (Join-Path $OldDefault 'build-info.txt'))) {
  Step "예전 설치 정리 ($OldDefault)"
  $oldBin = Join-Path $OldDefault 'bin'
  $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
  if ($userPath -and (($userPath -split ';') -contains $oldBin)) {
    [Environment]::SetEnvironmentVariable('Path', (@($userPath -split ';' | Where-Object { $_ -and $_ -ne $oldBin }) -join ';'), 'User')
    Ok "PATH에서 뺌: $oldBin"
  }
  try { Remove-Item -Recurse -Force $OldDefault; Ok '예전 폴더를 지웠습니다' }
  catch { Warn "예전 폴더를 다 지우지 못했습니다 ($($_.Exception.Message)). 쓰지 않으니 나중에 직접 지워도 됩니다" }
  Warn "브라우저에 예전 폴더에서 로드한 Dogent가 있으면 지우고 $Target\extension 을 로드하세요"
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
    $exe = $appExe
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

# Dogent 확장 ID는 매니페스트의 key로 정해져 있다 (bridge/extension-key.mjs). 이 ID를 다른 폴더에서 로드했으면 그 경로
$ExtId = 'koofmoibafgagpofabagilbhknolfgok'
function OtherFolder($b) {
  $root = Join-Path $env:LOCALAPPDATA $b.data
  if (-not (Test-Path $root)) { return $null }
  foreach ($p in Get-ChildItem $root -Directory -ErrorAction SilentlyContinue) {
    foreach ($file in @('Secure Preferences', 'Preferences')) {
      $f = Join-Path $p.FullName $file
      if (-not (Test-Path $f)) { continue }
      $text = [IO.File]::ReadAllText($f)
      if ($text.IndexOf($ExtId) -lt 0) { continue }
      try { $path = ($text | ConvertFrom-Json).extensions.settings.$ExtId.path } catch { $path = $null }
      # PowerShell 5.1은 대소문자만 다른 키가 있으면 JSON을 읽지 못한다. 그때는 ID 뒤의 첫 "path"를 찾는다
      if (-not $path) {
        $m = [regex]::Match($text, '"' + $ExtId + '"\s*:\s*\{.{0,20000}?"path"\s*:\s*"((?:[^"\\]|\\.)*)"', 'Singleline')
        if ($m.Success) { $path = [regex]::Unescape($m.Groups[1].Value) }
      }
      if ($path -and ($path.TrimEnd('\') -ne $extTarget.TrimEnd('\'))) { return $path }
    }
  }
  return $null
}

Step '브라우저에 확장 로드'
if ($targets.Count -eq 0) { Warn '크롬이나 엣지를 찾지 못했습니다. 설치된 브라우저에서 아래 순서로 로드하세요.' }
$pending = @($targets | Where-Object { -not (Loaded $_) })
foreach ($b in $targets) {
  if ($pending -notcontains $b) { Ok "$($b.name): 이미 로드됨. 확장이 새 판을 알아채고 1분 안에 스스로 다시 읽습니다 (Dogent 패널을 열면 바로)" }
  else {
    $other = OtherFolder $b
    if ($other) {
      Warn "$($b.name): Dogent를 다른 폴더($other)에서 로드해 두었습니다."
      Warn '  확장 관리 화면에서 그 Dogent를 [삭제]하고 아래 폴더를 로드하세요. 이번 한 번만 하면 다음 업데이트부터는 지우지 않아도 됩니다'
    }
  }
}
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
if ($copied['Dogent.exe'] -and $Update) {
  # 업데이트: 켜져 있던 앱을 새 판으로 다시 띄운다. 연결 설정은 이미 되어 있다
  if ($wasRunning -or -not $Quiet) {
    Start-Process $appExe
    Ok 'Dogent 앱을 새 판으로 띄웠습니다'
  }
  Write-Host ''
  Write-Host "업데이트를 마쳤습니다. $(if (Test-Path $info) { (Get-Content -Encoding UTF8 $info -TotalCount 4 | Select-Object -Skip 2) -join ' · ' })" -ForegroundColor Green
  exit 0
}
if ($copied['Dogent.exe'] -and -not $Quiet) {
  Start-Process $appExe
  Ok 'Dogent 앱을 띄웠습니다. 앱이 처음 뜰 때 브라우저 연결을 스스로 등록합니다'
}
Write-Host ''
Write-Host '확장과 앱은 저절로 연결됩니다 (회사·집 빌드는 Native Messaging이 기본, 토큰도 자동)' -ForegroundColor White
Write-Host '  확장을 로드하고 앱을 띄우면 30초 안에 앱 위쪽에 브라우저 이름이 보입니다'
Write-Host '  안 보이면: 사이드 패널 → 설정 → 클라이언트 연결이 [Native Messaging] 인지 보고 저장'
Write-Host ''
Write-Host "설치를 마쳤습니다. 안내서: $(Join-Path $Target '설치안내.html')" -ForegroundColor Green
if (-not $Quiet) { Read-Host '닫으려면 Enter' | Out-Null }
