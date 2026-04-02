@echo off
REM Quick update script for Claude Session Manager (Windows)
REM Usage: scripts\update.bat

cd /d "%~dp0\.."
echo === Claude Session Manager — Update ===

REM 1. Pull latest
echo [1/4] Pulling latest code...

REM Check for local changes
git diff --quiet HEAD
if errorlevel 1 (
    set HAS_CHANGES=1
    git stash
) else (
    set HAS_CHANGES=0
)

git pull --rebase origin main
if errorlevel 1 (
    echo ERROR: git pull failed
    pause
    exit /b 1
)

if %HAS_CHANGES%==1 (
    git stash pop
    if errorlevel 1 (
        echo ERROR: Merge conflict during git stash pop. Please resolve manually.
        pause
        exit /b 1
    )
)

REM 2. Install dependencies
echo [2/4] Installing dependencies...
call npm install --prefer-offline
if errorlevel 1 (
    echo ERROR: npm install failed
    pause
    exit /b 1
)

REM 3. Build
echo [3/4] Building...
if exist .next rmdir /s /q .next
call npm run build
if errorlevel 1 (
    echo ERROR: Build failed
    pause
    exit /b 1
)

REM 4. Restart server
echo [4/4] Restarting server...
taskkill /f /fi "WINDOWTITLE eq claude-session*" >nul 2>&1
for /f "tokens=5" %%a in ('netstat -aon ^| findstr ":3000" ^| findstr "LISTENING"') do (
    taskkill /f /pid %%a >nul 2>&1
)
timeout /t 2 /nobreak >nul

REM Start server in a new minimized window
start /min "claude-session-manager" cmd /c "npm run start"
timeout /t 4 /nobreak >nul

REM Health check
curl -s -o nul -w "HTTP %%{http_code}" http://localhost:3000/claude-sessions >nul 2>&1
if errorlevel 1 (
    echo WARNING: Could not reach server. It may still be starting up.
    echo Try opening http://localhost:3000 in your browser.
) else (
    echo.
    echo === Update complete! Server is running on http://localhost:3000 ===
)

pause
