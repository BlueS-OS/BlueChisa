@echo off
setlocal
cd /d "%~dp0"
echo.
echo   Chisa - taller de hilos
echo   http://localhost:5174
echo.
start "" "http://localhost:5174/"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0serve.ps1" -Port 5174
