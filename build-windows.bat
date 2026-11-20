@echo off
setlocal
cd /d "%~dp0"

echo ========================================================
echo Building Folio for Windows 11 (Installer + Portable EXE)
echo ========================================================
echo.

where npm >nul 2>nul
if %errorlevel% neq 0 (
  echo [ERROR] Node.js / npm is not installed or not in PATH.
  echo Please install Node.js LTS from https://nodejs.org/ and try again.
  pause
  exit /b 1
)

echo [1/3] Installing project dependencies...
call npm install
if %errorlevel% neq 0 (
  echo Retrying with --legacy-peer-deps...
  call npm install --legacy-peer-deps
  if %errorlevel% neq 0 (
    echo [ERROR] npm install failed.
    pause
    exit /b 1
  )
)

echo.
echo [2/3] Installing Electron packager dependencies...
call npm install --save-dev electron@^45.1.0 electron-builder@^26.18.0
if %errorlevel% neq 0 (
  echo [ERROR] Failed to install Electron packaging tools.
  pause
  exit /b 1
)

echo.
echo [3/3] Building Folio-Setup.exe and Folio-Portable.exe...
call npm run dist:win
if %errorlevel% neq 0 (
  echo [ERROR] Build failed.
  pause
  exit /b 1
)

echo.
echo ========================================================
echo Build complete!
echo Your executables are ready in the "release" folder:
echo   - release\Folio-Setup.exe    (Windows 11 Installer)
echo   - release\Folio-Portable.exe (Standalone Portable App)
echo ========================================================
explorer "%~dp0release"
pause
