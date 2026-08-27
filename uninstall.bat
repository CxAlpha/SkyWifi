@echo off
setlocal
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "uninstall.ps1" %*
if %ERRORLEVEL% neq 0 (
    echo.
    echo Uninstallation failed with error code %ERRORLEVEL%.
)
pause
endlocal
