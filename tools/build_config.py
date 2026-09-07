#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Подставляет значения в js/config.js при деплое на GitHub Pages.

Главное правило: пустая переменная окружения НИЧЕГО не затирает.
Тогда остаётся значение, которое лежит в репозитории — и приложение
работает даже если переменные в Settings ещё не заданы.

Запускается из корня репозитория:  python3 tools/build_config.py
"""
import io
import os
import re
import sys

KEYS = [
    "SHARED_SWAPS_URL",
    "FIREBASE_API_KEY",
    "TELEGRAM_BOT_NAME",
    "TELEGRAM_BOT_ID",
    "TELEGRAM_BOT_TOKEN_SHA256",
]

PATH = "js/config.js"

if not os.path.exists(PATH):
    print("нет файла %s" % PATH)
    sys.exit(1)

with io.open(PATH, encoding="utf-8") as f:
    src = f.read()

print("значение                   откуда        длина")
print("-" * 48)

for key in KEYS:
    value = (os.environ.get(key) or "").strip()
    pattern = re.compile(r'^var %s = "([^"]*)";$' % key, re.M)
    match = pattern.search(src)
    current = match.group(1) if match else ""

    if value:
        safe = value.replace("\\", "\\\\").replace('"', '\\"')
        line = 'var %s = "%s";' % (key, safe)
        if match:
            src = pattern.sub(lambda m: line, src, count=1)
        else:
            src = src.rstrip("\n") + "\n" + line + "\n"
        where, size = "окружение", len(value)
    else:
        where, size = ("репозиторий" if current else "ПУСТО"), len(current)

    print("%-26s %-13s %d" % (key, where, size))

with io.open(PATH, "w", encoding="utf-8") as f:
    f.write(src)

print("-" * 48)
print("js/config.js готов")
