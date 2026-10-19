@echo off
rem Dogent install (no admin needed). Double-click in the package folder.
chcp 65001 >nul
"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1" %*
