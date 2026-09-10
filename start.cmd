@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"
title Vera Practice

echo.
echo   Vera Practice - тренажёр клинической коммуникации
echo   ================================================
echo.

where node >nul 2>nul
if errorlevel 1 goto no_node

set NODE_MAJOR=0
for /f "tokens=1 delims=." %%v in ('node -p "process.versions.node"') do set NODE_MAJOR=%%v
if %NODE_MAJOR% LSS 20 goto old_node
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

:no_node
echo   Не найден Node.js - без него тренажёр не запустится.
echo   Установите версию 20 или новее: https://nodejs.org/
echo   После установки закройте это окно и откройте start.cmd заново.
echo.
pause
exit /b 1

:old_node
echo   Найден Node.js версии %NODE_MAJOR%, а нужна 20 или новее.
echo   Обновите Node.js: https://nodejs.org/
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
