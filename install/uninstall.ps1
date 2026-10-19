<#
  Dogent 제거

  시작 메뉴 → Dogent → Dogent 제거 (또는 설치 폴더의 uninstall.cmd)
  프로그램, 바로 가기, dogent 명령(PATH), 브라우저 연결 등록을 지운다.
  내 스킬·설정·실행 기록(%USERPROFILE%\.dogent)은 남긴다. 함께 지우려면 -Purge.

  -Target  설치 폴더 (기본: 이 스크립트가 있는 폴더)
  -Purge   %USERPROFILE%\.dogent 도 지운다 (개인 스킬이 사라진다)
  -Quiet   묻지 않는다
#>
param(
  [string]$Target = $PSScriptRoot,
  [switch]$Purge,
  [switch]$Quiet
)

$ErrorActionPreference = 'Stop'
function Step($text) { Write-Host ''; Write-Host "▶ $text" -ForegroundColor Cyan }
function Ok($text) { Write-Host "  ✓ $text" -ForegroundColor Green }
function Warn($text) { Write-Host "  ! $text" -ForegroundColor Yellow }

$dotDogent = Join-Path $env:USERPROFILE '.dogent'
Write-Host ''
Write-Host 'Dogent 제거' -ForegroundColor White
Write-Host "  설치 폴더: $Target" -ForegroundColor DarkGray
if (-not (Test-Path (Join-Path $Target 'extension'))) { Warn '설치 폴더처럼 보이지 않습니다 (extension 폴더 없음). 바로 가기와 등록만 지웁니다.'; $Target = $null }
if (-not $Quiet) {
  $yes = Read-Host '  제거할까요? (Y/N)'
  if ($yes -notmatch '^[yY]') { Write-Host '그만뒀습니다.'; exit 0 }
}
# 설치 폴더를 지울 수 있게 그 밖으로 나간다
Set-Location $env:TEMP

Step '켜져 있는 Dogent 닫기'
$running = @(Get-Process -Name Dogent, dogent-office -ErrorAction SilentlyContinue)
$running | Stop-Process -Force -ErrorAction SilentlyContinue
if ($running.Count -gt 0) { Start-Sleep -Milliseconds 800; Ok "$($running.Count)개를 닫았습니다" } else { Ok '켜진 것 없음' }

Step '브라우저 연결 등록'
foreach ($key in @('HKCU:\Software\Google\Chrome\NativeMessagingHosts\com.dogent.bridge', 'HKCU:\Software\Microsoft\Edge\NativeMessagingHosts\com.dogent.bridge', 'HKCU:\Software\Chromium\NativeMessagingHosts\com.dogent.bridge')) {
  if (Test-Path $key) { Remove-Item -Recurse -Force $key; Ok "지움: $key" }
}
foreach ($f in @('com.dogent.bridge.json', 'native-host.cmd', 'native-host.mjs', 'protocol.mjs')) {
  $p = Join-Path $dotDogent $f
  if (Test-Path $p) { Remove-Item -Force $p }
}
Ok '호스트 파일 정리'

Step '바로 가기와 dogent 명령'
$desktopLink = Join-Path ([Environment]::GetFolderPath('Desktop')) 'Dogent.lnk'
if (Test-Path $desktopLink) { Remove-Item -Force $desktopLink }
$menu = Join-Path ([Environment]::GetFolderPath('Programs')) 'Dogent'
if (Test-Path $menu) { Remove-Item -Recurse -Force $menu }
Ok '바탕화면 · 시작 메뉴'
$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
if ($userPath) {
  $kept = @($userPath -split ';' | Where-Object { $_ -and -not ($_ -like '*\Dogent\bin') -and -not ($Target -and $_ -eq (Join-Path $Target 'bin')) })
  if ($kept.Count -ne @($userPath -split ';' | Where-Object { $_ }).Count) {
    [Environment]::SetEnvironmentVariable('Path', ($kept -join ';'), 'User')
    Ok 'PATH에서 dogent 명령을 뺐습니다'
  }
}

if ($Target) {
  Step '프로그램 폴더'
  try { Remove-Item -Recurse -Force $Target; Ok "지움: $Target" }
  catch { Warn "다 지우지 못했습니다 ($($_.Exception.Message)). 브라우저를 닫고 폴더를 직접 지우세요: $Target" }
}

if ($Purge) {
  Step '내 스킬·설정·실행 기록'
  if (Test-Path $dotDogent) { Remove-Item -Recurse -Force $dotDogent; Ok "지움: $dotDogent" }
} elseif (Test-Path $dotDogent) {
  Write-Host ''
  Write-Host "  내 스킬·설정·실행 기록은 남겼습니다: $dotDogent" -ForegroundColor DarkGray
}

Write-Host ''
Write-Host '제거했습니다. 브라우저의 확장 관리 화면(chrome://extensions, edge://extensions)에서 Dogent의 [삭제]도 눌러 주세요.' -ForegroundColor Green
if (-not $Quiet) { Read-Host '닫으려면 Enter' | Out-Null }
