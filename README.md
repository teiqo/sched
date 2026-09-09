# sched

веб-приложение с расписанием, общими заменами, входом через telegram и отдельным ботом для уведомлений и отчётов.

## структура

- `public/` — сайт и pwa
- `bot/` — сервер входа, уведомлений и отчётов
- `scripts/` — локальный запуск, сборка и обновление расписания
- `config/firebase.rules.json` — правила firebase realtime database
- `.github/workflows/` — публикация сайта и автоматическое обновление расписания

## локальный запуск

```bash
python3 scripts/serve_local.py
```

сайт откроется по адресу `http://127.0.0.1:8765`.

локальный режим использует тестовый профиль. сообщения в telegram и изменения общей базы не отправляются.

## сборка сайта

```bash
python3 scripts/stage_site.py
```

готовые файлы появятся в `dist/`. туда копируется только содержимое `public/`; серверные файлы, локальные данные и секреты не попадают.

## публикация на github pages

workflow `.github/workflows/deploy-pages.yml` сам создаёт публичный конфиг, собирает `dist/` и публикует сайт.

добавь в repository variables:

```text
SHARED_SWAPS_URL
FIREBASE_API_KEY
TELEGRAM_BOT_NAME
TELEGRAM_OWNER_ID
TELEGRAM_ADMIN_IDS
SCHED_NOTIFY_URL
```

добавь в repository secrets:

```text
NOTIFY_SECRET
```

в настройках репозитория включи `settings → pages → source → github actions`.

`public/js/config.js` должен оставаться пустым шаблоном. значения конкретного сайта подставляются только во время сборки.

## firebase

создай realtime database и опубликуй правила из `config/firebase.rules.json`.

`FIREBASE_API_KEY` и адрес базы используются сайтом и поэтому являются публичными параметрами. приватный ключ service account должен храниться только на сервере бота и никогда не должен попадать в `public/` или git.

## если замены возвращают 401

1. В Firebase Realtime Database опубликуй правила из `config/firebase.rules.json`.
2. Проверь, что `FIREBASE_API_KEY`, `SHARED_SWAPS_URL` и JSON из `FIREBASE_SERVICE_ACCOUNT_FILE` относятся к **одному Firebase-проекту**.
3. Перезапусти сервер бота после изменения его environment variables.
4. Опубликуй сайт заново, открой профиль, выйди и войди через Telegram ещё раз. Старые сессии перестают работать после смены `NOTIFY_SECRET`.
5. Не включай Anonymous Authentication: приложение использует Firebase custom token, подписанный сервером после подтверждённого входа через Telegram.

Сайт сохраняет правку локально сразу. Если общая запись отклонена, теперь появляется понятное сообщение, а запрос с истёкшим Firebase ID token автоматически повторяется один раз с новым токеном.

## telegram и бот

создай бота и настрой web login в botfather. callback должен вести на:

```text
https://адрес-бота/auth/callback
```

скопируй пример окружения:

```bash
cp bot/.env.example bot/.env
python3 -m pip install -r bot/requirements.txt
set -a
source bot/.env
set +a
python3 -m bot.main --check-config
python3 -m bot.main
```

минимально нужны:

```text
TELEGRAM_BOT_TOKEN
TELEGRAM_BOT_NAME
TELEGRAM_CLIENT_ID
TELEGRAM_CLIENT_SECRET
TELEGRAM_OWNER_ID
BOT_PUBLIC_URL
SCHED_ALLOWED_ORIGINS
NOTIFY_SECRET
```

`NOTIFY_SECRET` на сервере должен совпадать с одноимённым github secret. файл service account подключается через `FIREBASE_SERVICE_ACCOUNT_FILE` и хранится вне репозитория.

данные бота находятся в `bot/data/` и игнорируются git. не удаляй эту папку при обновлении работающего сервера.

## автоматическое обновление расписания

workflow `.github/workflows/update-schedule.yml` запускает `scripts/update_schedule.py` каждые три часа и коммитит изменения только в `public/data/`.

для ручного запуска:

```bash
python3 -m pip install -r scripts/requirements.txt
python3 scripts/update_schedule.py
```

## безопасность

не добавляй в git:

- `.env`
- токен бота
- `NOTIFY_SECRET`
- service-account json и приватные ключи
- содержимое `bot/data/`
- локальные базы, логи и сборку `dist/`

эти файлы уже закрыты правилами в `.gitignore`.

## лицензия

см. `LICENSE`.
