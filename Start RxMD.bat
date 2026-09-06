@echo off
REM ============================================================
REM  Start RxMD - builds if needed, launches the server, opens the app.
REM  Double-click this file to run RxMD on this PC.
REM ============================================================
setlocal enabledelayedexpansion
cd /d "%~dp0"

set "PORT=8787"
set "URL=http://localhost:%PORT%/"

REM --- First run: install dependencies if needed ---
if not exist "node_modules" (
  echo First run detected - installing dependencies. This can take a minute...
  call npm install
  if errorlevel 1 (
    echo.
    echo npm install failed. Make sure Node.js is installed ^(https://nodejs.org^).
    pause
    exit /b 1
  )
)

REM --- Build the web app if it hasn't been built yet ---
if not exist "dist\index.html" (
  echo Building the web app...
  call npm run build
  if errorlevel 1 ( echo Build failed. & pause & exit /b 1 )
)

REM --- Start the server only if it isn't already running ---
powershell -NoProfile -Command "try{(New-Object Net.Sockets.TcpClient).Connect('127.0.0.1',%PORT%);exit 0}catch{exit 1}" >nul 2>&1
if errorlevel 1 (
  echo Starting RxMD server...
  start "RxMD Server" /min cmd /c "node server\index.js"
) else (
  echo RxMD server is already running.
)

REM --- Wait until the server responds (up to ~20s) ---
echo Waiting for the server to be ready...
powershell -NoProfile -Command "for($i=0;$i -lt 40;$i++){ try{ Invoke-WebRequest -UseBasicParsing -Uri '%URL%' -TimeoutSec 2 | Out-Null; exit 0 }catch{ Start-Sleep -Milliseconds 500 } }; exit 1"

echo Opening RxMD...
start "" "%URL%"

REM RxMD works in any browser, and on other devices on your network at
REM   http://THIS-PC-IP:%PORT%/   (the server window prints the exact address).
REM The minimized "RxMD Server" window keeps the app running - close it when done.
REM For 24x7 use, install it as a Windows service instead (see DEPLOY.md).
exit /b 0
