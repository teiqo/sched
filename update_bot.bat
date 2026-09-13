@echo off
chcp 65001 > nul
title Обновление бота sched (AlwaysData)
cd /d "%~dp0"

echo ========================================================
echo        ОБНОВЛЕНИЕ БОТА НА СЕРВЕРЕ (ALWAYSDATA)
echo ========================================================
echo.

echo [1/2] Отправка изменений в GitHub...
git add bot/ public/ js/ css/ 2>nul
git commit -m "update bot" >nul 2>nul
git push origin main
echo.

echo [2/2] Скачивание файлов и перезапуск бота на AlwaysData...
ssh gan13don@ssh-gan13don.alwaysdata.net "cd ~/www/schedbot/bot && curl -sSL https://raw.githubusercontent.com/teiqo/sched/main/bot/main.py -o main.py && curl -sSL https://raw.githubusercontent.com/teiqo/sched/main/bot/authentication.py -o authentication.py && curl -sSL https://raw.githubusercontent.com/teiqo/sched/main/bot/reports.py -o reports.py && ~/www/schedbot/.venv/bin/python -m py_compile main.py && pkill -f 'schedbot/bot/main.py' || true && echo && echo === ВСЕ ФАЙЛЫ БОТА УСПЕШНО СКАЧАНЫ И ПЕРЕЗАПУЩЕНЫ ==="

echo.
if %errorlevel% equ 0 (
    echo ========================================================
    echo   ГОТОВО! Бот на AlwaysData успешно обновлен.
    echo   (Если не перезапустился сам, нажми ⟳ в Web -^> Sites)
    echo ========================================================
) else (
    echo ========================================================
    echo   [!] Произошла ошибка. Проверь пароль SSH или интернет.
    echo ========================================================
)
echo.
pause
