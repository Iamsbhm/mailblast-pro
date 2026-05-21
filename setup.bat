@echo off
title ClipGenius Setup
color 0B

echo.
echo  =========================================
echo    ClipGenius - First Time Setup
echo  =========================================
echo.

:: Check Python
python --version >nul 2>&1
if %errorlevel% neq 0 (
  echo [ERROR] Python not found! Please install Python 3.9+ from python.org
  pause
  exit /b 1
)
echo [OK] Python found

:: Check pip
pip --version >nul 2>&1
if %errorlevel% neq 0 (
  echo [ERROR] pip not found!
  pause
  exit /b 1
)
echo [OK] pip found

:: Check FFmpeg
ffmpeg -version >nul 2>&1
if %errorlevel% neq 0 (
  echo.
  echo [WARNING] FFmpeg not found!
  echo.
  echo  FFmpeg is required for video processing.
  echo  Please install it:
  echo    1. Go to: https://www.gyan.dev/ffmpeg/builds/
  echo    2. Download ffmpeg-release-essentials.zip
  echo    3. Extract and add the bin/ folder to your PATH
  echo    4. Restart this script
  echo.
  pause
  exit /b 1
)
echo [OK] FFmpeg found

:: Install Python dependencies
echo.
echo Installing Python packages...
pip install -r clipper_api\requirements.txt
if %errorlevel% neq 0 (
  echo [ERROR] Failed to install Python packages
  pause
  exit /b 1
)
echo [OK] Python packages installed

:: Install Node dependencies (if needed)
if not exist node_modules (
  echo.
  echo Installing Node.js packages...
  npm install
)
echo [OK] Node packages ready

echo.
echo  =========================================
echo    Setup Complete! 
echo    Run start_all.bat to launch ClipGenius
echo  =========================================
echo.
pause
