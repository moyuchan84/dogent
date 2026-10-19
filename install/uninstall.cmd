@echo off
rem Dogent uninstall. Leave the install folder first so it can be deleted.
chcp 65001 >nul
set "DOGENT_UNINSTALL=%~dp0uninstall.ps1"
cd /d "%TEMP%"
"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File "%DOGENT_UNINSTALL%" %*
