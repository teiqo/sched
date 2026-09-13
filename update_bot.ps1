[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$Host.UI.RawUI.WindowTitle = "Обновление бота sched (AlwaysData)"

Write-Host "========================================================" -ForegroundColor Cyan
Write-Host "       ОБНОВЛЕНИЕ БОТА НА СЕРВЕРЕ (ALWAYSDATA)" -ForegroundColor Cyan
Write-Host "========================================================`n" -ForegroundColor Cyan

Write-Host "[1/2] Проверка локальных изменений и синхронизация с GitHub..." -ForegroundColor Yellow
git add bot/ public/ js/ css/
git diff-index --quiet HEAD
if ($LASTEXITCODE -ne 0) {
    git commit -m "update bot"
}
git push origin main
Write-Host ""

Write-Host "[2/2] Подключение к AlwaysData по SSH..." -ForegroundColor Yellow
$remoteCmd = 'cd ~/www/schedbot/bot && curl -sSL https://raw.githubusercontent.com/teiqo/sched/main/bot/main.py -o main.py && curl -sSL https://raw.githubusercontent.com/teiqo/sched/main/bot/authentication.py -o authentication.py && curl -sSL https://raw.githubusercontent.com/teiqo/sched/main/bot/reports.py -o reports.py && ~/www/schedbot/.venv/bin/python -m py_compile main.py && pkill -f ''schedbot/bot/main.py'' || true && echo && echo === ВСЕ ФАЙЛЫ БОТА УСПЕШНО СКАЧАНЫ И ПЕРЕЗАПУЩЕНЫ ==='

ssh gan13don@ssh-gan13don.alwaysdata.net $remoteCmd

if ($LASTEXITCODE -eq 0) {
    Write-Host "`n========================================================" -ForegroundColor Green
    Write-Host "  ГОТОВО! Все файлы бота обновлены и проверены." -ForegroundColor Green
    Write-Host "  (Если бот не перезапустился сам, нажми ⟳ в Web -> Sites)" -ForegroundColor Green
    Write-Host "========================================================`n" -ForegroundColor Green
} else {
    Write-Host "`n========================================================" -ForegroundColor Red
    Write-Host "  [!] Произошла ошибка. Проверь пароль SSH или интернет." -ForegroundColor Red
    Write-Host "========================================================`n" -ForegroundColor Red
}
