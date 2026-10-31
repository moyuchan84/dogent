@echo off
rem Dogent update: git pull, build all, reinstall. Double-click. Options: update.cmd -Mode company -NoPull -Test
chcp 65001 >nul
"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File "%~dp0update.ps1" %*
if errorlevel 1 (
  echo.
  echo Update failed. See the messages above.
  pause
  exit /b 1
)
timeout /t 5
