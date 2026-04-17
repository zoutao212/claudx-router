@echo off
echo ========================================
echo Starting Claude Code Router (DEV MODE)
echo ========================================
echo.

REM Set UTF-8 encoding for console
chcp 65001 >nul

REM Kill residual processes on port 8082
set KILL_PORT=8082
echo Checking for residual processes on port %KILL_PORT%...
for /f "tokens=5" %%a in ('netstat -ano ^| findstr "LISTENING" ^| findstr ":%KILL_PORT% "') do (
    echo   Found process %%a on port %KILL_PORT%, killing...
    taskkill /F /PID %%a >nul 2>&1
    if errorlevel 1 (
        echo   [WARN] Failed to kill process %%a
    ) else (
        echo   [OK] Killed process %%a
    )
)
echo.

echo Checking if packages need building...
if not exist "packages\core\dist" (
    echo Building core package...
    pnpm.cmd build:core
    if errorlevel 1 (
        echo [ERROR] Failed to build core package
        pause
        exit /b 1
    )
)

if not exist "packages\server\dist" (
    echo Building server package...
    pnpm.cmd build:server
    if errorlevel 1 (
        echo [ERROR] Failed to build server package
        pause
        exit /b 1
    )
)

echo.
echo ========================================
echo Starting development server...
echo ========================================
echo.
echo Server will be available at:
echo   - API Endpoint: http://127.0.0.1:8082/v1/messages
echo   - Web UI: http://127.0.0.1:8082
echo   - Config API: http://127.0.0.1:8082/api/config
echo   - Config: C:\Users\zouta\.claude-code-router\config.json
echo.
echo Trace logging enabled: CCR_TRACE=1
echo Trace logs will be written to: logs\trace\YYYY-MM-DD.jsonl
echo.
echo Press Ctrl+C to stop the server
echo ========================================
echo.

set CCR_TRACE=1
set SERVICE_PORT=8082
set CCR_UPSTREAM_RETRY_TOTAL_MS=15000
set CCR_UPSTREAM_RETRY_MAX=5
set CCR_UPSTREAM_RETRY_BASE_MS=300
pnpm.cmd dev:server

pause
