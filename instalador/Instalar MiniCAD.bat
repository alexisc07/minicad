@echo off
rem Instalador de MiniCAD 3D (no necesita permisos de administrador)
if not exist "%~dp0instalar.ps1" (
  echo.
  echo  Primero descomprime el ZIP: clic derecho en el archivo ZIP ^> Extraer todo.
  echo.
  pause
  exit /b 1
)
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0instalar.ps1"
pause
