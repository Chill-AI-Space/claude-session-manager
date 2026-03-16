@echo off
REM ============================================================
REM Claude Session Manager — Start (quick launch)
REM ============================================================
REM Double-click to start the server and open in browser.
REM If already running — just opens the browser.
REM ============================================================

setlocal
cd /d "%~dp0\.."

REM --- Check if already running ---
curl -s -o nul -w "%%{http_code}" http://localhost:3000/api/health >nul 2>&1
if not errorlevel 1 (
    echo [OK] Session Manager is already running!
    start "" "http://localhost:3000/claude-sessions"
    exit /b 0
)

echo.
echo ========================================
echo  Claude Session Manager — Starting...
echo ========================================
echo.

REM --- Kill stale processes on port 3000 ---
for /f "tokens=5" %%a in ('netstat -aon ^| findstr ":3000" ^| findstr "LISTENING"') do (
    echo [*] Killing stale process on port 3000 (PID %%a)
    taskkill /f /pid %%a >nul 2>&1
)
timeout /t 1 /nobreak >nul

REM --- Check if build exists ---
if not exist .next (
    echo [*] No build found, building...
    call npm run build
    if errorlevel 1 (
        echo [ERROR] Build failed. Run scripts\setup-windows.bat first.
        pause
        exit /b 1
    )
)

REM --- Start server minimized ---
start /min "claude-session-manager" cmd /c "npm run start"

REM --- Wait for server to be ready ---
echo [*] Waiting for server...
set /a attempts=0

:wait_loop
if %attempts% GEQ 15 goto :timeout
timeout /t 1 /nobreak >nul
set /a attempts+=1
curl -s -o nul http://localhost:3000/api/health >nul 2>&1
if errorlevel 1 goto :wait_loop

echo [OK] Server is running on http://localhost:3000
start "" "http://localhost:3000/claude-sessions"
exit /b 0

:timeout
echo [WARN] Server is taking long to start. Opening browser anyway...
start "" "http://localhost:3000/claude-sessions"
exit /b 0
