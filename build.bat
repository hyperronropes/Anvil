@echo off
setlocal EnableExtensions
cd /d "%~dp0"

echo.
echo  ========================================
echo   Anvil - Windows build
echo  ========================================
echo.

where py >nul 2>&1
if %errorlevel%==0 (
  set "PY=py -3.10"
) else (
  set "PY=python"
)

echo Using: %PY%
echo.

echo [1/6] Upgrade pip / setuptools...
%PY% -m pip install --upgrade pip setuptools wheel -q
if errorlevel 1 goto :fail

echo [2/6] Python deps (anvil + pyinstaller + pillow)...
%PY% "%~dp0build\patch_py310_dis.py"
if errorlevel 1 goto :fail
%PY% -m pip install "%~dp0anvil" -q
if errorlevel 1 goto :fail
%PY% -m pip install -r "%~dp0server\requirements.txt" -q
if errorlevel 1 goto :fail
%PY% -m pip install pyinstaller pillow -q
if errorlevel 1 goto :fail

echo [3/6] npm install (app)...
cd /d "%~dp0app"
call npm install
if errorlevel 1 goto :fail

echo [4/6] Regenerate app icons from logo source...
cd /d "%~dp0app\assets"
%PY% prepare_logo.py
if errorlevel 1 goto :fail

echo [5/6] PyInstaller + Electron build (may take several minutes)...
cd /d "%~dp0"
%PY% build_all.py
if errorlevel 1 goto :fail

echo.
echo  ========================================
echo   BUILD OK
echo  ========================================
echo.
echo   GUI:  %~dp0dist\Anvil\Anvil.exe
echo.
goto :end

:fail
echo.
echo  ========================================
echo   BUILD FAILED  (exit %errorlevel%)
echo  ========================================
echo.
pause
exit /b 1

:end
pause
endlocal
