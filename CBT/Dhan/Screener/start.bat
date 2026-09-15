@echo off
cd /d "%~dp0"

REM Use the venv Python that has all packages installed
set PYTHON=C:\Users\anura\OneDrive\Desktop\aiTools\.venv\Scripts\python.exe

if not exist "%PYTHON%" (
    echo ERROR: venv not found at %PYTHON%
    echo Run this first from the aiTools folder:
    echo   python -m venv .venv
    echo   .venv\Scripts\activate
    echo   pip install -r CBT\Dhan\Screener\requirements.txt
    pause
    exit /b 1
)

echo Starting NSE ORB Scanner Dashboard...
echo Open your browser at: http://localhost:5050
echo Press Ctrl+C to stop.
echo.
"%PYTHON%" dashboard.py
pause
