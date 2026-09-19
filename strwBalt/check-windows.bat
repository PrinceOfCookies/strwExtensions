@echo off
REM strwBalt diagnostics - run this and send the whole output for help.
cd /d "%~dp0"

echo ==============================
echo  strwBalt diagnostics
echo ==============================
echo.

echo --- docker ---
docker --version 2>nul
if errorlevel 1 (
    echo docker installed : NO
    echo.
    echo   Install Docker Desktop and open it once:
    echo   https://www.docker.com/products/docker-desktop/
    pause
    exit /b 1
)
docker info >nul 2>&1
if errorlevel 1 (
    echo docker running   : NO
    echo.
    echo   Open Docker Desktop, wait for "running", then re-run this.
    pause
    exit /b 1
)
echo docker running   : yes
echo.

echo --- containers ---
docker compose ps
echo.

echo --- backend responses ---
echo cobalt (9000):
curl -s --max-time 5 http://localhost:9000/
echo.
echo yt-dlp (9100):
curl -s --max-time 5 http://localhost:9100/health
echo.
echo.

echo --- recent errors ---
docker compose logs --tail=200 2>&1 | findstr /I "error fatal cannot failed denied"
echo.

echo If both backends printed JSON above, the backend is fine.
echo Reload the extension at chrome://extensions and reopen the popup.
echo.
pause
