@echo off
rem Double-click to build Milk Crate.exe. See scripts\build-windows.ps1 for what it does.
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "scripts\build-windows.ps1"
if errorlevel 1 (
  echo.
  echo Something went wrong. Scroll up for the first error, or see README.md.
)
pause
