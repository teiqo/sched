[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$Host.UI.RawUI.WindowTitle = "Обновление бота sched (AlwaysData)"

# Можно переопределить перед запуском:
#   $env:SCHED_SSH = "gan13don@ssh-gan13don.alwaysdata.net"
#   $env:SCHED_REMOTE_BOT = "~/www/schedbot/bot"
#   $env:SCHED_REMOTE_VENV = "~/www/schedbot/.venv/bin/python"
$SshTarget = if ($env:SCHED_SSH) { $env:SCHED_SSH } else { "gan13don@ssh-gan13don.alwaysdata.net" }
$RemoteBot = if ($env:SCHED_REMOTE_BOT) { $env:SCHED_REMOTE_BOT } else { "~/www/schedbot/bot" }
$RemotePython = if ($env:SCHED_REMOTE_VENV) { $env:SCHED_REMOTE_VENV } else { "~/www/schedbot/.venv/bin/python" }
$RepoRaw = "https://raw.githubusercontent.com/teiqo/sched/main/bot"

Write-Host "========================================================" -ForegroundColor Cyan
Write-Host "       Обновление бота на сервере (ALWAYSDATA)" -ForegroundColor Cyan
Write-Host "========================================================" -ForegroundColor Cyan
Write-Host "SSH:    $SshTarget"
Write-Host "Remote: $RemoteBot"
Write-Host ""

Write-Host "[1/2] Проверка локальных изменений и синхронизация с GitHub..." -ForegroundColor Yellow
git add bot/ public/
git diff-index --quiet HEAD
if ($LASTEXITCODE -ne 0) {
    git commit -m "update bot"
}
git push origin main
if ($LASTEXITCODE -ne 0) {
    Write-Host "[!] Не удалось запушить в GitHub. Деплой на AlwaysData пропущен." -ForegroundColor Red
    exit 1
}
Write-Host ""

Write-Host "[2/2] Подтягивание файлов бота на AlwaysData по SSH..." -ForegroundColor Yellow
$remoteCmd = @"
set -e
cd $RemoteBot
curl -sSL $RepoRaw/main.py -o main.py
curl -sSL $RepoRaw/authentication.py -o authentication.py
curl -sSL $RepoRaw/reports.py -o reports.py
$RemotePython -m py_compile main.py authentication.py reports.py
echo
echo === Код бота обновлён. Перезапусти сайт в AlwaysData ===
"@

ssh -o BatchMode=yes $SshTarget $remoteCmd

if ($LASTEXITCODE -eq 0) {
    Write-Host ""
    Write-Host "========================================================" -ForegroundColor Green
    Write-Host "  Готово! Файлы бота обновлены на сервере." -ForegroundColor Green
    Write-Host "  Перезапусти сайт: AlwaysData -> Web -> Sites (аккаунт gan13don)" -ForegroundColor Green
    Write-Host "  Проверка: https://sched.alwaysdata.net/sched-bot/ (файлы на gan13don)" -ForegroundColor Green
    Write-Host "========================================================" -ForegroundColor Green
    Write-Host ""
} else {
    Write-Host ""
    Write-Host "========================================================" -ForegroundColor Red
    Write-Host "  [!] Ошибка SSH. Проверь:" -ForegroundColor Red
    Write-Host "  1) ключ добавлен в AlwaysData (SSH keys)" -ForegroundColor Red
    Write-Host "  2) логин верный: $SshTarget" -ForegroundColor Red
    Write-Host "  3) путь к боту: $RemoteBot" -ForegroundColor Red
    Write-Host "========================================================" -ForegroundColor Red
    Write-Host ""
    exit 1
}
