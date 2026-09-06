@echo off
REM ============================================================
REM  RxMD - one-click update. Pulls the latest changes from the
REM  repo, reinstalls dependencies, rebuilds the app, and tells
REM  the running tray to restart the server with the new version.
REM ============================================================
setlocal
cd /d "%~dp0"
title RxMD Update

echo(
echo   === RxMD update ===
echo(

where git >nul 2>&1
if errorlevel 1 ( echo Git is not installed. Install "Git for Windows" to use updates. & pause & exit /b 1 )

echo Pulling the latest changes...
call git pull
if errorlevel 1 ( echo. & echo git pull failed - check your internet connection and that this folder is the cloned repo. & pause & exit /b 1 )

echo Installing dependencies...
call npm install
if errorlevel 1 ( echo. & echo npm install failed. & pause & exit /b 1 )

echo Rebuilding the web app...
call npm run build
if errorlevel 1 ( echo. & echo Build failed. & pause & exit /b 1 )

REM Signal the running tray to restart the server (it polls this file).
if not exist "data" mkdir "data"
> "data\tray.control" echo restart

REM Make sure the tray is running (a second copy exits on its own).
wscript "%~dp0scripts\launch-tray.vbs"

echo(
echo   Update complete. The server is restarting with the new version.
echo   Refresh your browser (and reload it on iPad/iPhone) to load the update.
echo(
pause
exit /b 0
