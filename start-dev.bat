@echo off
echo ========================================
echo Starting Claude Code Router (DEV MODE)
echo ========================================
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
pnpm.cmd dev:server

pause
