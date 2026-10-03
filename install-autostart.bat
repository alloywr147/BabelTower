@echo off
rem ============================================================
rem  Babel Tower - Install auto-start (double-click to run)
rem  Registers the local bridge to start at Windows login and
rem  exit automatically when Deadlock closes.
rem ============================================================
cd /d "%~dp0"
if not exist "%~dp0scripts\autostart.ps1" (
    echo [LCT] Missing file: scripts\autostart.ps1
    echo [LCT] The install is incomplete. Re-extract the FULL release zip
    echo [LCT] Keep its folder structure intact, then double-click this again.
    echo.
    pause
    exit /b 1
)
echo [BabelTower] Installing auto-start...
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\autostart.ps1" -Action Install
echo.
echo Done. Now you can just launch Deadlock from Steam.
echo Uninstall anytime with remove-autostart.bat
pause
