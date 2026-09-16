@echo off
setlocal EnableExtensions

rem Try to switch output to UTF-8; ignore failures.
chcp 65001 >nul 2>&1

set "SCRIPT_DIR=%~dp0"
set "PROJECT_ROOT=%SCRIPT_DIR%..\.."
cd /d "%PROJECT_ROOT%"

echo [INFO] Stopping old processes...

rem Read ports from .env with defaults.
set "BACKEND_PORT=9000"
set "PROXY_PORT=9001"
set "FRONTEND_PORT=5173"
for /f "tokens=2 delims==" %%v in ('findstr /B /C:"PORT=" .env 2^>nul') do set "BACKEND_PORT=%%v"
for /f "tokens=2 delims==" %%v in ('findstr /B /C:"PROXY_PORT=" .env 2^>nul') do set "PROXY_PORT=%%v"
for /f "tokens=2 delims==" %%v in ('findstr /B /C:"FRONTEND_PORT=" .env 2^>nul') do set "FRONTEND_PORT=%%v"

rem Kill listeners on backend/proxy/frontend ports.
for %%p in (%BACKEND_PORT% %PROXY_PORT% %FRONTEND_PORT%) do (
  for /f "tokens=5" %%a in ('netstat -aon ^| findstr ":%%p " ^| findstr /I LISTENING 2^>nul') do (
    if not "%%a"=="0" (
      echo     Killing PID %%a on port %%p
      taskkill /F /PID %%a >nul 2>&1
    )
  )
)

ping -n 3 127.0.0.1 >nul

echo [INFO] Syncing database schema...
call npx drizzle-kit push --force 2>nul || echo     (drizzle-kit push skipped)

echo [INFO] Starting development servers
echo     Backend:  http://localhost:%BACKEND_PORT%
echo     Frontend: http://localhost:%FRONTEND_PORT%

echo.
if /I "%~1"=="--no-dev" (
  echo --no-dev set; skipping npm run dev
  exit /b 0
)

call npm run dev
