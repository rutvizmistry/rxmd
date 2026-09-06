@echo off
REM ============================================================
REM  RxMD - one-click install for the clinic PC.
REM  Run this once after cloning/pulling the repo. It installs
REM  dependencies, builds the app, optionally sets the password
REM  and enables auto-start, then launches the tray controller.
REM ============================================================
setlocal enabledelayedexpansion
cd /d "%~dp0"
title RxMD Installer

echo(
echo   === RxMD install ===
echo(

where node >nul 2>&1
if errorlevel 1 (
  echo Node.js is not installed. Install the LTS version from https://nodejs.org and run this again.
  pause & exit /b 1
)
where git >nul 2>&1
if errorlevel 1 echo NOTE: Git was not found. Install "Git for Windows" so update.bat can pull future changes.

echo Installing dependencies (this can take a minute)...
call npm install
if errorlevel 1 ( echo. & echo npm install failed. & pause & exit /b 1 )

echo Building the web app...
call npm run build
if errorlevel 1 ( echo. & echo Build failed. & pause & exit /b 1 )

echo(
echo A starter config.json will be created on first launch. You can edit the
echo watched/library folders any time from the app's Settings (gear icon).
echo(

set "SETPW=Y"
set /p SETPW="Set the shared LAN password now? [Y/n]: "
if /i not "!SETPW!"=="n" ( call npm run set-password )

echo(
set "AUTO=Y"
set /p AUTO="Start RxMD automatically when Windows starts? [Y/n]: "
if /i not "!AUTO!"=="n" ( call :make_startup )

echo(
echo Launching RxMD...
call :launch_tray

echo(
echo   RxMD is running. Look for the blue "Rx" icon in the system tray
echo   (bottom-right, you may need to click the ^^ arrow to see it).
echo   - This PC:      http://localhost:8787
echo   - Other devices: right-click the tray icon to copy the LAN / Tailscale address.
echo(
pause
exit /b 0

:launch_tray
wscript "%~dp0scripts\launch-tray.vbs"
exit /b 0

:make_startup
set "STARTUP=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup"
powershell -NoProfile -ExecutionPolicy Bypass -Command "$s=(New-Object -ComObject WScript.Shell).CreateShortcut('%STARTUP%\RxMD.lnk'); $s.TargetPath='wscript.exe'; $s.Arguments='\"%~dp0scripts\launch-tray.vbs\"'; $s.WorkingDirectory='%~dp0'; $s.IconLocation='%SystemRoot%\System32\shell32.dll,13'; $s.Save()"
echo Added RxMD to Windows startup.
exit /b 0
