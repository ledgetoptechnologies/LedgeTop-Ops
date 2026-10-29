@echo off
setlocal
if "%~1"=="" (
  echo Drag one unopened Company file onto this CMD file.
  exit /b 1
)
"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -ExecutionPolicy Bypass -NoProfile -File "%~dp0Read-LedgeTopShellState.ps1" -LiteralPath "%~1"
exit /b %errorlevel%
