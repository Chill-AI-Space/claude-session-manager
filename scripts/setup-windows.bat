@echo off
REM ============================================================
REM Claude Session Manager — Windows Setup (one-click)
REM ============================================================
REM No prerequisites needed — this script installs everything.
REM Usage: Double-click this file, or run: scripts\setup-windows.bat
REM ============================================================

setlocal enabledelayedexpansion
cd /d "%~dp0\.."

echo.
echo ========================================
echo  Claude Session Manager — Windows Setup
echo ========================================
echo.

REM --- Check Node.js ---
where node >nul 2>&1
if errorlevel 1 goto :install_node

for /f "tokens=*" %%v in ('node --version') do set NODE_VER=%%v
echo [OK] Node.js %NODE_VER% found

REM --- Check minimum Node version (need 18+) ---
for /f "tokens=1 delims=v." %%a in ("%NODE_VER%") do set NODE_MAJOR=%%a
if %NODE_MAJOR% LSS 18 (
    echo [!] Node.js 18+ required, you have %NODE_VER%. Upgrading...
    goto :install_node
)
goto :node_ready

:install_node
echo [!] Node.js is not installed or too old.
echo.

REM Try winget first (available on Windows 10 1709+ and Windows 11)
where winget >nul 2>&1
if errorlevel 1 goto :no_winget

echo     Node.js can be installed automatically via winget.
echo.
choice /C YN /M "    Install Node.js now? (Y/N)"
if errorlevel 2 goto :manual_install
echo.
echo     Installing Node.js LTS via winget...
echo.
winget install OpenJS.NodeJS.LTS --accept-package-agreements --accept-source-agreements
if errorlevel 1 (
    echo.
    echo [ERROR] winget install failed. Trying manual install...
    goto :manual_install
)

REM winget installs to Program Files — add to PATH for this session
set "PATH=%PATH%;C:\Program Files\nodejs"

REM Verify it worked
where node >nul 2>&1
if errorlevel 1 (
    echo.
    echo [!] Node.js was installed but not yet in PATH.
    echo     Please close this window and run setup-windows.bat again.
    echo.
    pause
    exit /b 0
)

for /f "tokens=*" %%v in ('node --version') do set NODE_VER=%%v
echo.
echo [OK] Node.js %NODE_VER% installed successfully!
goto :node_ready

:no_winget
echo     winget is not available on this system.
echo.

:manual_install
echo     Please install Node.js manually:
echo.
echo     Option 1: Download from https://nodejs.org (LTS version)
echo              Make sure to check "Add to PATH" during install!
echo.
echo     Option 2: If you have chocolatey:
echo              choco install nodejs-lts
echo.
echo     After installing, close this window and run setup-windows.bat again.
echo.
pause
exit /b 1

:node_ready

REM --- Check npm ---
where npm >nul 2>&1
if errorlevel 1 (
    echo [ERROR] npm not found. It should come with Node.js.
    echo Try reinstalling Node.js from https://nodejs.org
    pause
    exit /b 1
)
echo [OK] npm found

REM --- Check Claude CLI (optional, warn only) ---
where claude >nul 2>&1
if errorlevel 1 (
    echo [WARN] Claude CLI not found in PATH.
    echo        Session replay/reply features won't work until Claude is installed.
    echo        Install later: npm install -g @anthropic-ai/claude-code
    echo.
) else (
    echo [OK] Claude CLI found
)

REM --- Install dependencies ---
echo.
echo [1/3] Installing dependencies...
call npm install
if errorlevel 1 (
    echo.
    echo [ERROR] npm install failed.
    echo.
    echo If better-sqlite3 compilation failed, you need C++ build tools:
    echo   Option 1: npm install --global windows-build-tools
    echo   Option 2: Download Visual Studio Build Tools:
    echo             https://visualstudio.microsoft.com/visual-cpp-build-tools/
    echo             Select "Desktop development with C++" workload
    echo.
    echo After installing build tools, run this script again.
    pause
    exit /b 1
)
echo [OK] Dependencies installed

REM --- Build ---
echo.
echo [2/3] Building production bundle...
if exist .next rmdir /s /q .next
call npm run build
if errorlevel 1 (
    echo [ERROR] Build failed. Check errors above.
    pause
    exit /b 1
)
echo [OK] Build complete

REM --- Create data directory ---
if not exist data mkdir data

REM --- Start server ---
echo.
echo [3/3] Starting server...

REM Kill any existing instance on port 3000
for /f "tokens=5" %%a in ('netstat -aon ^| findstr ":3000" ^| findstr "LISTENING"') do (
    taskkill /f /pid %%a >nul 2>&1
)
timeout /t 1 /nobreak >nul

start /min "claude-session-manager" cmd /c "npm run start"
timeout /t 4 /nobreak >nul

REM --- Health check ---
curl -s -o nul -w "%%{http_code}" http://localhost:3000/claude-sessions >nul 2>&1
if errorlevel 1 (
    echo [WARN] Server may still be starting up...
    echo Try opening http://localhost:3000/claude-sessions in your browser.
) else (
    echo [OK] Server is running!
)

echo.
echo ============================================
echo  Setup complete!
echo  Open in browser: http://localhost:3000/claude-sessions
echo ============================================
echo.
echo To update later, run: scripts\update.bat
echo To start server manually: npm run start
echo.

REM Open browser automatically
start "" "http://localhost:3000/claude-sessions"

pause
