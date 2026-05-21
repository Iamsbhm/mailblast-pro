@echo off
title ClipGenius Launcher
color 0A

echo.
echo  =========================================
echo    ClipGenius - Starting All Servers
echo  =========================================
echo.
echo  Frontend:  http://localhost:3000/clipper
echo  Python API: http://localhost:5000
echo.
echo  Press Ctrl+C in each window to stop.
echo.

:: Start Python Flask API in a new window
echo Starting Python API server...
start "ClipGenius Python API" cmd /k "cd /d "%~dp0" && python clipper_api\app.py"

:: Wait 2 seconds for Flask to start
timeout /t 2 /nobreak >nul

:: Start Node.js server in a new window
echo Starting Node.js frontend server...
start "ClipGenius Node Server" cmd /k "cd /d "%~dp0" && npm run dev"

:: Wait for servers to start
timeout /t 3 /nobreak >nul

:: Open browser
echo.
echo Opening ClipGenius in browser...
start http://localhost:3000/clipper

echo.
echo  [DONE] Both servers running!
echo  Close the server windows to stop.
echo.
