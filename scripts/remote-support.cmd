@echo off
setlocal enabledelayedexpansion

rem ============================================================================
rem  Cartethyia - Remote Support tunnel launcher (Windows)
rem ----------------------------------------------------------------------------
rem  Starts or stops a public tunnel to the local gateway WITHOUT installing
rem  anything. cloudflared and tailscale must already be installed by you; this
rem  script only finds them on PATH and runs them.
rem
rem  Usage:
rem    remote-support.cmd start cloudflared [port]
rem    remote-support.cmd start tailscale   [port]
rem    remote-support.cmd stop  [cloudflared|tailscale]
rem    remote-support.cmd status
rem    remote-support.cmd url
rem
rem  The tunnel is launched DETACHED (via PowerShell Start-Process), so it is
rem  NOT a child of whatever called this script. Killing the caller does not
rem  kill the tunnel, and the gateway never owns the tunnel's stdin.
rem ============================================================================

set "ACTION=%~1"
set "TOOL=%~2"
set "PORT=%~3"
if "%PORT%"=="" set "PORT=12800"

set "STATE_DIR=%APPDATA%\Cartethyia\remote-support"
if "%STATE_DIR%"=="" set "STATE_DIR=%USERPROFILE%\.cartethyia\remote-support"
if not exist "%STATE_DIR%" mkdir "%STATE_DIR%" >nul 2>&1

if "%ACTION%"=="" goto :usage
if /i "%ACTION%"=="start"  goto :start
if /i "%ACTION%"=="stop"   goto :stop
if /i "%ACTION%"=="status" goto :status
if /i "%ACTION%"=="url"    goto :url
goto :usage

:usage
echo usage: remote-support.cmd {start^|stop^|status^|url} [cloudflared^|tailscale] [port]
exit /b 2

rem ---------------------------------------------------------------------------
:start
if /i "%TOOL%"=="cloudflared" goto :start_cf
if /i "%TOOL%"=="tailscale"   goto :start_ts
echo error: tool must be "cloudflared" or "tailscale"
exit /b 2

:start_cf
where cloudflared >nul 2>&1
if errorlevel 1 goto :missing_cf
call :stop_one cloudflared >nul 2>&1
rem cloudflared prints the public URL to STDERR, so both streams are captured.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0remote-support.ps1" -Action launch -Tool cloudflared -Port %PORT% -StateDir "%STATE_DIR%"
if errorlevel 1 exit /b 1
echo started cloudflared
exit /b 0

:start_ts
where tailscale >nul 2>&1
if errorlevel 1 goto :missing_ts
call :stop_one tailscale >nul 2>&1
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0remote-support.ps1" -Action launch -Tool tailscale -Port %PORT% -StateDir "%STATE_DIR%"
if errorlevel 1 exit /b 1
echo started tailscale
exit /b 0

:missing_cf
echo error: cloudflared not found on PATH
echo install it yourself first, then run this again:
echo   winget install Cloudflare.cloudflared
echo see: https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/
exit /b 3

:missing_ts
echo error: tailscale not found on PATH
echo install it yourself first, then run this again:
echo   winget install Tailscale.Tailscale
echo then sign in once: tailscale up
echo see: https://tailscale.com/download/windows
exit /b 3

rem ---------------------------------------------------------------------------
:stop
if "%TOOL%"=="" (
  call :stop_one cloudflared
  tailscale serve reset >nul 2>&1
  exit /b 0
)
if /i "%TOOL%"=="tailscale" (
  tailscale serve reset >nul 2>&1
  del /f /q "%STATE_DIR%\tailscale.url" >nul 2>&1
  echo stopped tailscale
  exit /b 0
)
call :stop_one %TOOL%
exit /b 0

:stop_one
set "PIDFILE=%STATE_DIR%\%~1.pid"
if not exist "%PIDFILE%" exit /b 0
set /p PID=<"%PIDFILE%"
if "%PID%"=="" (
  del /f /q "%PIDFILE%" >nul 2>&1
  exit /b 0
)
taskkill /PID %PID% /T /F >nul 2>&1
del /f /q "%PIDFILE%" >nul 2>&1
del /f /q "%STATE_DIR%\%~1.url" >nul 2>&1
echo stopped %~1
exit /b 0

rem ---------------------------------------------------------------------------
:status
set "ANY=0"
if exist "%STATE_DIR%\cloudflared.pid" (
  set /p PID=<"%STATE_DIR%\cloudflared.pid"
  tasklist /FI "PID eq !PID!" /NH 2>nul | findstr /i "!PID!" >nul 2>&1
  if not errorlevel 1 (
    echo cloudflared running pid=!PID!
    set "ANY=1"
  ) else (
    del /f /q "%STATE_DIR%\cloudflared.pid" >nul 2>&1
  )
)
rem tailscale runs as a system service, so its pid file is unreliable.
rem Detect a live serve instead.
tailscale serve status --json 2>nul | findstr /i "\"Proxy\"" >nul 2>&1
if not errorlevel 1 (
  echo tailscale running
  set "ANY=1"
)
if "%ANY%"=="0" echo stopped
exit /b 0

:url
if exist "%STATE_DIR%\cloudflared.url" (
  type "%STATE_DIR%\cloudflared.url"
  echo.
  exit /b 0
)
if exist "%STATE_DIR%\tailscale.url" (
  type "%STATE_DIR%\tailscale.url"
  echo.
  exit /b 0
)
exit /b 0

endlocal
