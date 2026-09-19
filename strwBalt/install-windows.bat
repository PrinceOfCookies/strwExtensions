@echo off
REM strwBalt installer - Windows
cd /d "%~dp0"

echo.
echo   strwBalt setup
echo   ==============
echo.

docker info >nul 2>&1
if errorlevel 1 (
    echo   Docker isn't running or isn't installed.
    echo   Get Docker Desktop: https://www.docker.com/products/docker-desktop/
    echo   Open it, wait until it says "running", then run this again.
    pause
    exit /b 1
)

echo   Building and starting containers (first run takes a few minutes)...
echo.
docker compose up -d --build
if errorlevel 1 (
    echo.
    echo   Something went wrong. Run: docker compose logs
    pause
    exit /b 1
)

echo.
echo   Waiting for backends to come up...
timeout /t 25 /nobreak >nul

curl -fsS http://localhost:9000/ >nul 2>&1 && echo     cobalt: ready || echo     cobalt: not responding
curl -fsS http://localhost:9100/health >nul 2>&1 && echo     yt-dlp: ready || echo     yt-dlp: not responding


echo.
echo   Next: install the browser extension
echo   -----------------------------------
echo   1. Open Chrome:  chrome://extensions
echo   2. Turn on "Developer mode" (top right)
echo   3. Click "Load unpacked"
echo   4. Select the "extension" folder inside this one
echo.
echo   Then click the strwBalt icon. Both dots should be green.
echo.
pause
