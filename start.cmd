@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"
title Vera Practice

set "LOCAL_NODE=%~dp0.node"

echo.
echo   Vera Practice - тренажёр клинической коммуникации
echo   ================================================
echo.

call :ensure_node
if errorlevel 1 goto fail

if not exist node_modules goto install

:run
echo   Поднимаю сервер. Это окно не закрывайте: пока оно открыто, тренажёр работает.
echo   Браузер откроется сам, как только сервер будет готов.
echo.
start "" /b cmd /c "node scripts\open-when-ready.mjs >nul 2>&1"
call npm run dev
echo.
echo   Сервер остановлен. Чтобы запустить снова - откройте этот файл ещё раз.
echo.
pause
exit /b 0

:install
echo   Первый запуск: устанавливаю зависимости, это займёт минуту-другую...
echo.
call npm install
if errorlevel 1 goto install_failed
echo.
goto run

rem ============================================================
rem  Node.js: ищем в системе, при неудаче качаем портативный
rem ============================================================
:ensure_node
set "NODE_MAJOR=0"

where node >nul 2>nul
if errorlevel 1 goto ensure_node_local

for /f "tokens=1 delims=." %%v in ('node -p "process.versions.node" 2^>nul') do set NODE_MAJOR=%%v
if %NODE_MAJOR% GEQ 20 (
  echo   Node.js найден: версия %NODE_MAJOR%
  exit /b 0
)
echo   Node.js в системе устарел (версия %NODE_MAJOR%, нужна 20 или новее).

:ensure_node_local
if exist "%LOCAL_NODE%\node.exe" (
  set "PATH=%LOCAL_NODE%;%PATH%"
  echo   Использую Node.js из папки проекта.
  exit /b 0
)

echo   Node.js не найден - скачаю его в папку проекта. Права администратора
echo   и установка в систему не нужны, это разовая загрузка примерно на 30 МБ.
echo.
powershell -NoProfile -ExecutionPolicy Bypass -File "scripts\get-node.ps1"
if errorlevel 1 exit /b 1

set "PATH=%LOCAL_NODE%;%PATH%"
exit /b 0

:fail
echo.
echo   Запуск отменён: не удалось подготовить Node.js.
echo   Подробности выше. Можно поставить Node.js вручную с https://nodejs.org/
echo   (версия 20 или новее) и открыть start.cmd заново.
echo.
pause
exit /b 1

:install_failed
echo.
echo   Не удалось установить зависимости. Проверьте подключение к интернету
echo   и запустите start.cmd заново.
echo.
pause
exit /b 1
