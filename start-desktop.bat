@echo off
setlocal EnableExtensions
cd /d "%~dp0"
chcp 65001 >nul

echo ========================================
echo Starting Claude Code Router Desktop
echo ========================================
echo.

REM Validate each launcher before accepting it. Explorer may retain an outdated PATH.
set "PNPM_CMD="
call :resolve_pnpm
if not defined PNPM_CMD (
    echo [ERROR] No working pnpm launcher was found.
    echo Reinstall pnpm, then run this script again.
    pause
    exit /b 1
)

echo Using pnpm: %PNPM_CMD%
for %%I in ("%PNPM_CMD%") do set "PNPM_HOME=%%~dpI"
set "PATH=%PNPM_HOME%;%PATH%"

echo Building shared library, CCR core and server...
call "%PNPM_CMD%" build:shared
if errorlevel 1 goto :failed

call "%PNPM_CMD%" build:core
if errorlevel 1 goto :failed

call "%PNPM_CMD%" build:server
if errorlevel 1 goto :failed

echo.
echo Starting desktop control plane...
call "%PNPM_CMD%" --filter @CCR/desktop dev
if errorlevel 1 goto :failed

goto :done

:resolve_pnpm
call :accept_pnpm "%APPDATA%\npm\pnpm.cmd"
if defined PNPM_CMD exit /b 0

call :accept_pnpm "%LOCALAPPDATA%\pnpm\pnpm.cmd"
if defined PNPM_CMD exit /b 0

call :accept_pnpm "pnpm.cmd"
exit /b 0

:accept_pnpm
if defined PNPM_CMD exit /b 0
if /i "%~1"=="pnpm.cmd" (
    where pnpm.cmd >nul 2>nul
    if errorlevel 1 exit /b 0
) else if not exist "%~1" (
    exit /b 0
)

call "%~1" --version >nul 2>nul
if errorlevel 1 exit /b 0
if /i "%~1"=="pnpm.cmd" (
    for /f "delims=" %%I in ('where pnpm.cmd 2^>nul') do if not defined PNPM_CMD set "PNPM_CMD=%%I"
) else (
    set "PNPM_CMD=%~1"
)
exit /b 0

:failed
echo.
echo [ERROR] Desktop application could not start.
pause
exit /b 1

:done
endlocal
