<#
  Dogent 업데이트 (코드를 받아 빌드하는 PC에서, 한 번에)

  두 번 누르기:  install\update.cmd
  명령으로:      powershell -NoProfile -ExecutionPolicy Bypass -File install\update.ps1 [-Mode company] [-NoPull] [-Test]

  하는 일
    1. git pull (고친 파일이 있으면 받지 않고 지금 코드로 빌드)
    2. 의존성이 바뀌었으면 pnpm install
    3. 확장, 터미널 클라이언트, 오피스 도구, 데스크탑 앱을 모두 빌드 (build.ps1)
    4. %LOCALAPPDATA%\Dogent 에 덮어써 설치하고 켜져 있던 앱을 새 판으로 다시 띄움 (install.ps1 -Update)
    5. 브라우저 확장은 지우거나 다시 로드하지 않는다. 확장이 폴더의 새 판을 알아채고 1분 안에 스스로 다시 읽는다
       (Dogent 패널을 열면 바로). 처음 한 번만 그 폴더를 로드해 두면 된다

  -Mode     company | home | dev. 비우면 지난번 모드 (처음이면 company)
  -NoPull   git pull 하지 않는다 (코드를 직접 옮겨 온 경우)
  -Test     빌드 전에 typecheck와 단위 시험
#>
param(
  [ValidateSet('', 'company', 'home', 'dev')][string]$Mode = '',
  [switch]$NoPull,
  [switch]$Test
)

$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
Set-Location $Root

function Step($text) { Write-Host ''; Write-Host "▶ $text" -ForegroundColor Cyan }
function Ok($text) { Write-Host "  ✓ $text" -ForegroundColor Green }
function Warn($text) { Write-Host "  ! $text" -ForegroundColor Yellow }

# 지난번에 쓴 모드를 기억한다 (저장소에는 올리지 않는 node_modules 안에 둔다)
$modeFile = Join-Path $Root 'node_modules\.dogent-mode'
if (-not $Mode) { $Mode = if (Test-Path $modeFile) { (Get-Content -Raw $modeFile).Trim() } else { 'company' } }
Write-Host ''
Write-Host "Dogent 업데이트 · 모드 $Mode" -ForegroundColor White

# ── 코드 받기 ─────────────────────────────────────────
if (-not $NoPull -and (Test-Path (Join-Path $Root '.git')) -and (Get-Command git -ErrorAction SilentlyContinue)) {
  Step '코드 받기 (git pull)'
  $before = (& git rev-parse --short HEAD).Trim()
  $dirty = @(& git status --porcelain --untracked-files=no)
  if ($dirty.Count -gt 0) {
    Warn "고친 파일이 $($dirty.Count)개 있어 받지 않고 지금 코드로 빌드합니다 (git status로 확인)"
  } else {
    & git pull --ff-only
    if ($LASTEXITCODE -ne 0) { Warn '받지 못했습니다 (네트워크나 갈라진 기록). 지금 코드로 빌드합니다' }
    $after = (& git rev-parse --short HEAD).Trim()
    if ($after -eq $before) { Ok "이미 최신입니다 ($after)" }
    else {
      Ok "$before → $after"
      & git log --oneline --no-decorate "$before..$after" | Select-Object -First 10 | ForEach-Object { Write-Host "    $_" -ForegroundColor DarkGray }
    }
  }
}

# ── 빌드와 설치 ──────────────────────────────────────
$buildArgs = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', (Join-Path $PSScriptRoot 'build.ps1'), '-Mode', $Mode, '-Install', '-Update')
if ($Test) { $buildArgs += '-Test' }
& (Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe') @buildArgs
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
if (Test-Path (Join-Path $Root 'node_modules')) { Set-Content -Encoding ASCII $modeFile $Mode }
exit 0
