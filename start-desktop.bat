@echo off
setlocal
chcp 65001 >nul

echo ========================================
echo Starting Claude Code Router Desktop
echo ========================================
echo.

echo Building shared library and CCR server...
call pnpm.cmd build:shared
if errorlevel 1 goto :failed

call pnpm.cmd build:server
if errorlevel 1 goto :failed

echo.
echo Starting desktop control plane...
call pnpm.cmd --filter @CCR/desktop dev
if errorlevel 1 goto :failed

goto :done

:failed
echo.
echo [ERROR] Desktop application could not start.
pause
exit /b 1

:done
endlocal