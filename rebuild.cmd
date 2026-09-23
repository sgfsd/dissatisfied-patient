@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"
title Vera Practice - пересборка

set "LOCAL_NODE=%~dp0.node"
if exist "%LOCAL_NODE%\node.exe" set "PATH=%LOCAL_NODE%;%PATH%"

echo.
echo   Пересборка Vera Practice
echo   ========================
echo.
echo   Нужна после обновления кода: start.cmd запускает уже собранную
echo   версию и сам её не пересобирает.
echo.

if exist ".next" (
  echo   Удаляю прошлую сборку...
  rmdir /s /q ".next"
)

call npm run build
if errorlevel 1 goto failed

echo.
echo   Готово. Запускайте start.cmd.
echo.
pause
exit /b 0

:failed
echo.
echo   Сборка не удалась, подробности выше.
echo   Если ошибок в коде нет, помогает удалить папку node_modules
echo   и запустить start.cmd заново - он поставит зависимости с нуля.
echo.
pause
exit /b 1
