@echo off
rem TG Agent Bridge self-updater (Windows only). ASCII-only on purpose.
rem Spawned DETACHED by the bot during /update; the bot exits right after.
rem This script waits for the old process to die, pulls + rebuilds again
rem (in case the in-process pre-update could not finish), restarts
rem "npm run dev" detached, and exits 0. Progress goes to updater.log.
setlocal EnableExtensions
cd /d "%~dp0.."
set "LOGFILE=%CD%\updater.log"
>> "%LOGFILE%" echo [%DATE% %TIME%] updater started in %CD%
timeout /t 5 /nobreak >nul
git pull --ff-only >> "%LOGFILE%" 2>&1
call npm i --no-audit --no-fund >> "%LOGFILE%" 2>&1
call npm run build >> "%LOGFILE%" 2>&1
>> "%LOGFILE%" echo [%DATE% %TIME%] restarting npm run dev
start "" /min cmd /d /s /c "npm run dev >> updater.log 2>&1"
exit /b 0
