@echo off
rem TG Agent Bridge autostart entry point (Windows only). ASCII-only on purpose.
rem Runs the bot in this repo checkout. Used by the scheduled logon task
rem created with scripts\install-autostart.cmd (or run it by hand).
rem Bot output already lands in bot.log via src/index.ts; nothing is echoed here.
setlocal EnableExtensions
cd /d "%~dp0.."
call npm run dev
