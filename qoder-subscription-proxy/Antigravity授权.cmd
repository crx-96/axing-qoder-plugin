@echo off
setlocal
rem Use built-in Windows PowerShell; this helper does not require Node.js.
"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\antigravity-login.ps1" %*
set "LOGIN_EXIT_CODE=%ERRORLEVEL%"
if not "%LOGIN_EXIT_CODE%"=="0" echo Antigravity authorization was not completed. No automatic retry was performed.
pause
exit /b %LOGIN_EXIT_CODE%
