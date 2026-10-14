@echo off
rem Xeno-Racer launcher: builds if needed, then opens the game in its own Chrome window.
cd /d "%~dp0"
if not exist node_modules (
  echo Installing dependencies...
  call npm install --no-audit --no-fund
)
node scripts\play.mjs %*
