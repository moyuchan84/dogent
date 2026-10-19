@echo off
rem Dogent build and package. Double-click, or: build.cmd -Mode company -Zip
chcp 65001 >nul
"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File "%~dp0build.ps1" %*
pause
