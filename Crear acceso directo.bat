@echo off
rem Crea los accesos directos de MiniCAD 3D (Escritorio y menu Inicio)
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0crear-acceso-directo.ps1"
echo.
pause
