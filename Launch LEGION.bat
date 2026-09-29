@echo off
REM ======================================================================
REM  LEGION launcher (console)
REM  Double-click for a console window with any startup output/errors.
REM  For a silent launch, use "Launch LEGION.vbs" instead.
REM ======================================================================
setlocal
cd /d "%~dp0"

set "ELECTRON=%~dp0node_modules\electron\dist\electron.exe"

if not exist "%ELECTRON%" (
  echo.
  echo   LEGION could not start.
  echo.
  echo   Electron was not found at:
  echo     %ELECTRON%
  echo.
  echo   Run this once in a terminal:
  echo     npm install
  echo.
  echo   then launch LEGION again.
  echo.
  pause
  exit /b 1
)

REM package.json names the real entry point (src/main/main.js), so hand Electron
REM the app directory as "." with the working directory set to it. Passing the
REM directory path itself makes Electron treat it as a module to resolve,
REM which fails with "Cannot find module" on a path containing spaces.
start "" "%ELECTRON%" .
endlocal
