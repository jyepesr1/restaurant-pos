@echo off
setlocal
rem Gives the admin a new password (like `pnpm reset-admin`): it needs the hub stopped, so the
rem service is stopped, the password is shown once, and the service starts again.

rem fltmc only works as administrator. If Windows still says no after asking once, stop there.
fltmc >nul 2>&1
if errorlevel 1 (
  if "%~1"=="elevated" (
    echo This needs an administrator account.
    pause
    exit /b 1
  )
  powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -ArgumentList 'elevated' -Verb RunAs"
  exit /b
)

set "BASE=%~dp0.."
set "DATA_DIR=%ProgramData%\Faro\data"

echo Stopping Faro...
"%BASE%\faro-hub.exe" stop
"%BASE%\node\node.exe" --disable-warning=ExperimentalWarning "%BASE%\hub\reset.mjs"
echo.
echo Starting Faro again...
"%BASE%\faro-hub.exe" start
echo.
pause
