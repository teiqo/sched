[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$Host.UI.RawUI.WindowTitle = "Обновление бота sched (AlwaysData)"

Write-Host "========================================================" -ForegroundColor Cyan
Write-Host "       ОБНОВЛЕНИЕ БОТА НА СЕРВЕРЕ (ALWAYSDATA)" -ForegroundColor Cyan
Write-Host "========================================================" -ForegroundColor Cyan
Write-Host ""

Write-Host "[1/2] Проверка локальных изменений и синхронизация с GitHub..." -ForegroundColor Yellow
git add bot/ public/ js/ css/
git diff-index --quiet HEAD
if ($LASTEXITCODE -ne 0) {
    git commit -m "update bot"
}
git push origin main
Write-Host ""

Write-Host "[2/2] Обновление файлов бота на AlwaysData по SSH..." -ForegroundColor Yellow
$remoteCmd = "cd ~/www/schedbot/bot && curl -sSL https://raw.githubusercontent.com/teiqo/sched/main/bot/main.py -o main.py && curl -sSL https://raw.githubusercontent.com/teiqo/sched/main/bot/authentication.py -o authentication.py && curl -sSL https://raw.githubusercontent.com/teiqo/sched/main/bot/reports.py -o reports.py && ~/www/schedbot/.venv/bin/python -m py_compile main.py && echo && echo === ВСЕ ФАЙЛЫ БОТА УСПЕШНО СКАЧАНЫ И ПРОВЕРЕНЫ ==="

ssh -o BatchMode=yes gan13don@ssh-gan13don.alwaysdata.net $remoteCmd

if ($LASTEXITCODE -eq 0) {
    Write-Host ""
    Write-Host "========================================================" -ForegroundColor Green
    Write-Host "  УСПЕШНО! Все файлы бота обновлены на сервере." -ForegroundColor Green
    Write-Host "  Не забудьте нажать перезапуск в AlwaysData: Web -> Sites -> ⟳" -ForegroundColor Green
    Write-Host "========================================================" -ForegroundColor Green
    Write-Host ""
} else {
    Write-Host ""
    Write-Host "========================================================" -ForegroundColor Red
    Write-Host "  [!] Произошла ошибка. Проверьте интернет или соединение." -ForegroundColor Red
    Write-Host "========================================================" -ForegroundColor Red
    Write-Host ""
}
