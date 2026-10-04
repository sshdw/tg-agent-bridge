@echo off
rem TG Agent Bridge autostart installer (Windows only). ASCII-only on purpose.
rem Creates a per-user logon task "tg-agent-bridge" that runs this checkout:
rem   <repo>\scripts\run-bridge.cmd
rem with restart-on-failure (3 tries, 1 minute apart). No admin needed.
rem The bot and the Mini App HTTP server are ONE process (src/index.ts), so a
rem bot restart brings the Mini App back too - no extra steps for the Mini App.
rem Usage: double-click this file (or run it from cmd). Undo with:
rem   schtasks /delete /tn "tg-agent-bridge" /f
setlocal EnableExtensions
cd /d "%~dp0.."
set "REPO=%CD%"
set "TASKNAME=tg-agent-bridge"
set "XMLFILE=%TEMP%\tg-agent-bridge-task.xml"

if not exist "%REPO%\scripts\run-bridge.cmd" (
  echo Missing scripts\run-bridge.cmd next to this installer.
  exit /b 1
)

> "%XMLFILE%" echo ^<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task"^>
>> "%XMLFILE%" echo   ^<RegistrationInfo^>
>> "%XMLFILE%" echo     ^<Description^>Telegram agent bridge - start at logon^</Description^>
>> "%XMLFILE%" echo   ^</RegistrationInfo^>
>> "%XMLFILE%" echo   ^<Triggers^>
>> "%XMLFILE%" echo     ^<LogonTrigger^>^<Enabled^>true^</Enabled^>^</LogonTrigger^>
>> "%XMLFILE%" echo   ^</Triggers^>
>> "%XMLFILE%" echo   ^<Principals^>
>> "%XMLFILE%" echo     ^<Principal id="Author"^>
>> "%XMLFILE%" echo       ^<LogonType^>InteractiveToken^</LogonType^>
>> "%XMLFILE%" echo       ^<RunLevel^>LeastPrivilege^</RunLevel^>
>> "%XMLFILE%" echo     ^</Principal^>
>> "%XMLFILE%" echo   ^</Principals^>
>> "%XMLFILE%" echo   ^<Settings^>
>> "%XMLFILE%" echo     ^<MultipleInstancesPolicy^>IgnoreNew^</MultipleInstancesPolicy^>
>> "%XMLFILE%" echo     ^<DisallowStartIfOnBatteries^>false^</DisallowStartIfOnBatteries^>
>> "%XMLFILE%" echo     ^<StopIfGoingOnBatteries^>false^</StopIfGoingOnBatteries^>
>> "%XMLFILE%" echo     ^<AllowHardTerminate^>true^</AllowHardTerminate^>
>> "%XMLFILE%" echo     ^<StartWhenAvailable^>true^</StartWhenAvailable^>
>> "%XMLFILE%" echo     ^<AllowStartOnDemand^>true^</AllowStartOnDemand^>
>> "%XMLFILE%" echo     ^<Enabled^>true^</Enabled^>
>> "%XMLFILE%" echo     ^<Hidden^>false^</Hidden^>
>> "%XMLFILE%" echo     ^<ExecutionTimeLimit^>PT0^</ExecutionTimeLimit^>
>> "%XMLFILE%" echo     ^<Priority^>7^</Priority^>
>> "%XMLFILE%" echo     ^<RestartOnFailure^>^<Interval^>PT1M^</Interval^>^<Count^>3^</Count^>^</RestartOnFailure^>
>> "%XMLFILE%" echo   ^</Settings^>
>> "%XMLFILE%" echo   ^<Actions Context="Author"^>
>> "%XMLFILE%" echo     ^<Exec^>
>> "%XMLFILE%" echo       ^<Command^>"%REPO%\scripts\run-bridge.cmd"^</Command^>
>> "%XMLFILE%" echo       ^<WorkingDirectory^>%REPO%^</WorkingDirectory^>
>> "%XMLFILE%" echo     ^</Exec^>
>> "%XMLFILE%" echo   ^</Actions^>
>> "%XMLFILE%" echo ^</Task^>

schtasks /create /tn "%TASKNAME%" /xml "%XMLFILE%" /f
set "RC=%ERRORLEVEL%"
del "%XMLFILE%" >nul 2>&1
if not "%RC%"=="0" (
  echo Failed to create the task. Try running this file as Administrator.
  exit /b 1
)
echo Done. The bot starts at your next logon.
echo Check with:  schtasks /query /tn "%TASKNAME%"
echo Remove with: schtasks /delete /tn "%TASKNAME%" /f
exit /b 0
