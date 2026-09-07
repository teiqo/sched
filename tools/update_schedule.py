# -*- coding: utf-8 -*-
"""Пересборка data/schedule.json из PDF с сайта колледжа.

Запуск: python3 tools/update_schedule.py [локальный.pdf для проверки]
Требует pdfplumber (pip install pdfplumber).

PDF — выгрузка из Excel с линиями сетки. Разбор идёт по координатам:
- колонки страницы строим по вертикальным линиям таблицы;
- колонку звонков узнаём по одиночным цифрам 1-6;
- шифры групп из строки-заголовка привязываем к колонкам по центру слова;
- страницы-продолжения без заголовка используют колонки текущей секции;
- границы строк пар — горизонтальные линии через колонку звонков
  (плюс края таблицы: у страниц-продолжений верхней линии нет);
- границы блоков дней — горизонтальные линии через полосу дня;
- подписи дней (вертикальный текст) склеиваем из букв по координатам.

Устойчивость:
- нет сети / битый PDF / бедный разбор — не роняем workflow: старый файл
  остаётся, скрипт завершается нулём, Action пробует снова через час;
- группа из нового разбора заменяет старую, только если число пар
  правдоподобно; группы, пропавшие из разбора, остаются из старого файла;
- если содержимое не изменилось, файл не перезаписывается: updatedAt
  означает последнее РЕАЛЬНОЕ изменение данных, пустых коммитов нет.
"""
import datetime
import json
import os
import re
import sys
import tempfile
import time
import urllib.request

PDF_URL = (
    "https://sustec.ru/wp-content/uploads/2018/09/"
    "mso-26-27_raspisanie_1_semestr_2026g_2027g.pdf"
)
OUT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "data", "schedule.json")
CHANGELOG_OUT = os.path.join(os.path.dirname(OUT), "changelog.json")
CHANGELOG_LIMIT = 60

GROUP_RE = re.compile(r"^[А-ЯЁ]{2,3}-\d{3}/[а-яё]$")
DAY_NAMES = {
    "понедельник": 1,
    "вторник": 2,
    "среда": 3,
    "четверг": 4,
    "пятница": 5,
    "суббота": 6,
}
BELL_RE = re.compile(r"^[1-6]$")

ROOM_RE = re.compile(r"\d\s*-?\s*к\s*-\s*(\d{1,3}[а-яё]?)")  # «3к - 208» и опечатка «3-к - 208»
# «Колосов С.М.», вариант без последней точки «Колосов С.М 3к - 04»
# и склейка «Останина К.Ю.3к - 312».
TEACHER_RE = re.compile(r"([А-ЯЁ][а-яё]+)\s+([А-ЯЁ])\.\s*([А-ЯЁ])\.?")
# компактная форма без пробела: «Кузовников.В.Г.» / «Кузовников. В.Г.»
TEACHER_COMPACT_RE = re.compile(r"([А-ЯЁ][а-яё]+)\.\s*([А-ЯЁ])\.\s*([А-ЯЁ])\.?")
# lookbehind: «четная неделя» внутри «Нечетная неделя» не должна матчиться
EVEN_RE = re.compile(r"(?i)(?<![А-ЯЁа-яё])четная\s+неделя")
ODD_RE = re.compile(r"(?i)(?<![А-ЯЁа-яё])нечетная\s+неделя")
SELF_RE = re.compile(r"\(\s*самостоятельная\s+работа\s*\)", re.I)
NOISE = ("Подгруппа 1", "Подгруппа 2", "(лекция)")
MID_ROOM_RE = re.compile(r"^\d{2,3}[а-яё]?$")
MAX_SUBJECT_LEN = 170
MAX_SUBJECT_WORDS = 18

TABLE_SETTINGS = {
    "vertical_strategy": "lines",
    "horizontal_strategy": "lines",
    "snap_tolerance": 3,
    "join_tolerance": 3,
    "intersection_tolerance": 3,
}


def fetch_pdf(path):
    last = None
    for attempt in range(3):
        try:
            req = urllib.request.Request(PDF_URL, headers={"User-Agent": "Mozilla/5.0 (schedule-bot)"})
            with urllib.request.urlopen(req, timeout=60) as resp:
                data = resp.read()
            if len(data) < 20000 or not data.startswith(b"%PDF"):
                raise RuntimeError("не похоже на PDF, байт: %d" % len(data))
            with open(path, "wb") as fh:
                fh.write(data)
            return
        except Exception as exc:  # сеть моргнула — повторим
            last = exc
            time.sleep(5 * (attempt + 1))
    raise RuntimeError("не удалось скачать PDF: %s" % last)


# ---------- геометрия страницы ----------

def center_x(w):
    return (w["x0"] + w["x1"]) / 2.0


def center_y(w):
    return (w["top"] + w["bottom"]) / 2.0


def merge_close(values, gap=2.0):
    out = []
    for v in sorted(values):
        if not out or v - out[-1] > gap:
            out.append(v)
    return out


def day_labels(words, right_edge):
    """Вертикальные подписи дней: буквы идут снизу вверх, склеиваем и разворачиваем."""
    letters = [
        w for w in words
        if center_x(w) < right_edge and re.match(r"^[а-яёА-ЯЁ]$", w["text"])
    ]
    letters.sort(key=lambda w: w["top"])
    clusters = []
    for w in letters:
        if clusters and w["top"] - clusters[-1][-1]["bottom"] < 14:
            clusters[-1].append(w)
        else:
            clusters.append([w])
    labels = []
    for cluster in clusters:
        text = "".join(w["text"] for w in cluster)[::-1].lower()
        if text in DAY_NAMES:
            labels.append({"day": DAY_NAMES[text], "y": (cluster[0]["top"] + cluster[-1]["bottom"]) / 2.0})
    return labels


def cell_text(page, x0, y0, x1, y1):
    """Текст ячейки: берём только символы, чей центр внутри ячейки (extract_text сам
    склеивает разреженные буквы со стр. 7), чтобы хвосты ячеек-«переростков»
    (типа «работа)») не протекали в соседнюю строку."""
    filtered = page.filter(
        lambda obj: obj["object_type"] != "char"
        or (x0 <= (obj["x0"] + obj["x1"]) / 2 < x1 and y0 <= (obj["top"] + obj["bottom"]) / 2 < y1)
    )
    return filtered.extract_text() or ""


def parse_pdf(path):
    """Возвращает {code: {(day, bell): текст ячейки}} и порядок групп."""
    import pdfplumber

    cells = {}          # code -> {(day, bell): text}
    group_cols = []     # [(code, x0, x1)] текущей секции
    last_cell = {}      # code -> (day, bell) — для довесных строк без цифры
    cur_day = 0
    prev_bell = 99

    with pdfplumber.open(path) as pdf:
        for page in pdf.pages:
            tables = page.find_tables(TABLE_SETTINGS)
            if not tables:
                continue
            table = max(tables, key=lambda t: (t.bbox[2] - t.bbox[0]) * (t.bbox[3] - t.bbox[1]))
            words = page.extract_words()
            if not words:
                continue
            tbl_left, tbl_top, tbl_right, tbl_bottom = table.bbox

            # колонки — по вертикальным линиям сетки
            vxs = merge_close(
                (e["x0"] + e["x1"]) / 2.0
                for e in page.edges
                if e["orientation"] == "v"
                and e["bottom"] > tbl_top + 2
                and e["top"] < tbl_bottom - 2
                and tbl_left - 2 <= (e["x0"] + e["x1"]) / 2.0 <= tbl_right + 2
            )
            if len(vxs) < 3:
                continue
            intervals = list(zip(vxs, vxs[1:]))

            # колонка звонков: узкая слева, больше всего одиночных цифр 1-6
            bell_idx, best_hits = None, 0
            for i, (x0, x1) in enumerate(intervals):
                if x1 > 62:
                    continue
                hits = sum(
                    1 for w in words
                    if BELL_RE.match(w["text"]) and x0 - 1 <= center_x(w) < x1 + 1
                )
                if hits > best_hits:
                    bell_idx, best_hits = i, hits
            if bell_idx is None or best_hits < 1:
                continue
            bell_x0, bell_x1 = intervals[bell_idx]
            day_interval = intervals[bell_idx - 1] if bell_idx > 0 else None

            # заголовок с шифрами групп начи��ает новую секцию
            header_words = [w for w in words if GROUP_RE.match(w["text"])]
            if header_words:
                group_cols = []
                for w in header_words:
                    cx = center_x(w)
                    col = next(
                        (c for c in intervals if c[0] - 1 <= cx < c[1] + 1 and c[0] > bell_x1 - 1),
                        None,
                    )
                    if col:
                        group_cols.append((w["text"], col[0], col[1]))
                if not group_cols:
                    continue
                group_cols.sort(key=lambda g: g[1])
                cur_day = 0
                prev_bell = 99
                last_cell = {}
                data_top = max(w["bottom"] for w in header_words) + 2
            else:
                if not group_cols:
                    continue  # секция ещё не началась
                data_top = tbl_top

            # строки пар — горизонтальные линии через колонку звонков + края таблицы
            bell_cx = (bell_x0 + bell_x1) / 2.0
            row_lines = merge_close(
                e["top"] for e in page.edges
                if e["orientation"] == "h"
                and e["x0"] - 1 <= bell_cx <= e["x1"] + 1
                and tbl_top - 2 <= e["top"] <= tbl_bottom + 2
            )
            if not row_lines or row_lines[0] - tbl_top > 3:
                row_lines.insert(0, tbl_top)
            if tbl_bottom - row_lines[-1] > 3:
                row_lines.append(tbl_bottom)

            # блоки дней — горизонтальные линии через полосу дня
            segments = []
            if day_interval:
                day_cx = (day_interval[0] + day_interval[1]) / 2.0
                day_lines = merge_close(
                    e["top"] for e in page.edges
                    if e["orientation"] == "h"
                    and e["x0"] - 1 <= day_cx <= e["x1"] + 1
                    and data_top - 2 <= e["top"] <= tbl_bottom + 2
                )
                bounds = [data_top] + [y for y in day_lines if y > data_top + 3] + [tbl_bottom]
                segments = [[bounds[i], bounds[i + 1], []] for i in range(len(bounds) - 1)]
            else:
                segments = [[data_top, tbl_bottom, []]]

            for lab in day_labels(words, bell_x0 - 1):
                for seg in segments:
                    if seg[0] - 2 <= lab["y"] <= seg[1] + 2:
                        seg[2].append(lab)
                        break
            # сегмент с несколькими подписями (линия между днями не дошла) — делим пополам по меткам
            split_segments = []
            for y0, y1, labs in segments:
                if len(labs) <= 1:
                    split_segments.append([y0, y1, labs[0]["day"] if labs else None])
                    continue
                labs.sort(key=lambda l: l["y"])
                cuts = [y0] + [(labs[i]["y"] + labs[i + 1]["y"]) / 2.0 for i in range(len(labs) - 1)] + [y1]
                for i, lab in enumerate(labs):
                    split_segments.append([cuts[i], cuts[i + 1], lab["day"]])
            segments = split_segments

            def segment_at(y):
                for idx, (y0, y1, day) in enumerate(segments):
                    if y0 - 2 <= y < y1 + 2:
                        return idx, day
                return None, None

            last_seg = None
            for r0, r1 in zip(row_lines, row_lines[1:]):
                if r1 <= data_top:
                    continue  # строка заголовка
                row_words = [w for w in words if r0 <= center_y(w) < r1]
                if not row_words:
                    continue
                bell_word = next(
                    (
                        w for w in row_words
                        if BELL_RE.match(w["text"]) and bell_x0 - 1 <= center_x(w) < bell_x1 + 1
                    ),
                    None,
                )
                seg_idx, seg_day = segment_at((r0 + r1) / 2.0)
                if seg_idx is not None and seg_idx != last_seg:
                    last_seg = seg_idx
                    if seg_day is not None:
                        cur_day = seg_day
                        prev_bell = 0  # новый подписанный день — сброс
                if bell_word is not None:
                    bell = int(bell_word["text"])
                    if bell <= prev_bell and seg_day is None:
                        cur_day += 1  # новый день без подписи (блок уехал на другую страницу)
                    prev_bell = bell
                else:
                    bell = None  # строка-довесок (ячейка разорвана переносом)
                if not 1 <= cur_day <= 6:
                    continue
                for code, x0, x1 in group_cols:
                    text = cell_text(page, x0, r0, x1, r1)
                    if not text.strip():
                        continue
                    group_cells = cells.setdefault(code, {})
                    if bell is None:
                        key = last_cell.get(code)
                        if key:
                            group_cells[key] = (group_cells.get(key) or "") + " " + text
                        continue
                    key = (cur_day, bell)
                    group_cells[key] = (group_cells.get(key) + " " + text) if key in group_cells else text
                    last_cell[code] = key
    return cells


# ---------- чистка ячейки ----------

def clean_cell(text):
    """Из текста ячейки делает список занятий (одно, два при чет/нечет)."""
    body = " ".join((text or "").split())
    if not body or set(body) <= set("- —–"):
        return []
    parts = []
    em = EVEN_RE.search(body)
    om = ODD_RE.search(body)
    if em and om:
        if em.start() < om.start():
            parts = [("even", body[: om.start()]), ("odd", body[om.start():])]
        else:
            parts = [("odd", body[: em.start()]), ("even", body[em.start():])]
    elif em:
        parts = [("even", body)]
    elif om:
        parts = [("odd", body)]
    else:
        parts = [(None, body)]

    out = []
    for parity, chunk in parts:
        piece = chunk
        extra = {}
        if parity:
            extra["parity"] = parity
        if SELF_RE.search(piece):
            extra["self"] = True
            piece = SELF_RE.sub(" ", piece)
        rooms = ROOM_RE.findall(piece)
        room = rooms[0] if rooms else ""
        piece = ROOM_RE.sub(" ", piece)
        teacher = ""
        t = TEACHER_RE.search(piece) or TEACHER_COMPACT_RE.search(piece)
        if t:
            teacher = "%s %s.%s." % (t.group(1).lower(), t.group(2).lower(), t.group(3).lower())
            piece = TEACHER_RE.sub(" ", piece)  # убираем всех (подгруппы), показываем первого
            piece = TEACHER_COMPACT_RE.sub(" ", piece)
        elif "вакансия" in piece.lower():
            teacher = "вакансия"
        if not room and teacher:
            m2 = re.search(r"\s(\d{2,3}[а-яё]?)$", piece.rstrip())  # «Гусев Н.Н. 101»
            if m2:
                room = m2.group(1)
                piece = piece.rstrip()[: m2.start()]
        for junk in NOISE:
            piece = piece.replace(junk, " ")
        piece = re.sub(r"(?i)(?<![А-ЯЁа-яё])нечетная\s+неделя\s*:?", " ", piece)
        piece = re.sub(r"(?i)(?<![А-ЯЁа-яё])четная\s+неделя\s*:?", " ", piece)
        piece = re.sub(r"\(\s*вакансия\s*\)|вакансия", " ", piece, flags=re.I)
        piece = re.sub(r"[-—–]{2,}", " ", piece)
        piece = re.sub(r"\s*,\s*$", " ", piece)
        subject = " ".join(piece.split()).strip(" ,.;-").lower()
        if len(subject) < 3:
            continue
        # «МДК 01.01 Длинное название модуля…» → просто «мдк 01.01»,
        # иначе в карточке пары полотно текста. Написания: «мдк 01.01», «мдк01.01», «мдк.02.05».
        mcode = re.match(r"^мдк[\s.]*(\d{2}\.\d{2})", subject)
        if mcode:
            subject = "мдк " + mcode.group(1)
        if len(subject) > MAX_SUBJECT_LEN:
            subject = subject[:MAX_SUBJECT_LEN].rstrip() + "…"
        out.append((subject, teacher, room, extra))
    return out


def slot_sane(item):
    """Отбраковка мусорных пар."""
    try:
        n, subject = item[0], item[1]
    except (TypeError, IndexError):
        return False
    if not isinstance(n, int) or not 1 <= n <= 6:
        return False
    if not isinstance(subject, str):
        return False
    if not 3 <= len(subject) <= MAX_SUBJECT_LEN:
        return False
    if len(subject.split()) > MAX_SUBJECT_WORDS:
        return False
    for word in subject.split()[:-1]:
        if MID_ROOM_RE.match(word):
            return False
    return True


def build_groups(cells):
    """{code: {(day, bell): text}} -> отсортированный список групп для JSON."""
    groups = []
    for code in sorted(cells, key=lambda c: c.lower()):
        by_day = {}
        for (day, bell), text in cells[code].items():
            if not 1 <= day <= 6 or not 1 <= bell <= 6:
                continue
            for subject, teacher, room, extra in clean_cell(text):
                if teacher == "вакансия":
                    continue  # пару без преподавателя (вакансию) не показываем
                item = [bell, subject, teacher, room, extra]
                if not slot_sane(item):
                    continue
                slots = by_day.setdefault(day, [])
                if item not in slots:
                    slots.append(item)
        days = {}
        for day in sorted(by_day):
            items = sorted(by_day[day], key=lambda it: it[0])
            if items:
                days[str(day)] = items
        if days:
            groups.append({"id": code.lower(), "name": code, "days": days})
    groups.sort(key=lambda g: g["name"].lower())
    return groups


# ---------- сравнение со старым файлом, журнал ----------

def day_count(days):
    return sum(len(items) for items in days.values())


DAY_SHORT = {1: "пн", 2: "вт", 3: "ср", 4: "чт", 5: "пт", 6: "сб"}


def slot_key(item):
    extra = item[4] if len(item) > 4 and isinstance(item[4], dict) else {}
    return (
        item[0],
        str(item[1]),
        str(item[2] or ""),
        str(item[3] or ""),
        str(extra.get("parity") or ""),
        bool(extra.get("self")),
    )


def slot_label(item):
    label = str(item[1])
    bits = [str(b) for b in (item[2], item[3]) if b]
    if bits:
        label += " (" + ", ".join(bits) + ")"
    if len(item) > 4 and isinstance(item[4], dict):
        if item[4].get("parity") == "even":
            label += " [чёт]"
        elif item[4].get("parity") == "odd":
            label += " [неч]"
        if item[4].get("self"):
            label += " [сам.работа]"
    return label


def diff_schedules(old_map, new_map, at):
    entries = []
    for gid in sorted(set(old_map) | set(new_map)):
        old_g = old_map.get(gid)
        new_g = new_map.get(gid)
        details = []
        summary = ""
        if old_g is None:
            summary = "новая группа"
            details.append("пар распознано: %d" % day_count(new_g.get("days") or {}))
        elif new_g is None:
            summary = "группа удалена"
            details.append("была удалена из нового разбора")
        else:
            old_days = old_g.get("days") or {}
            new_days = new_g.get("days") or {}
            for day in sorted(set(old_days) | set(new_days), key=lambda d: int(d)):
                old_slots = {slot_key(s): s for s in old_days.get(day) or [] if isinstance(s, list) and len(s) >= 2}
                new_slots = {slot_key(s): s for s in new_days.get(day) or [] if isinstance(s, list) and len(s) >= 2}
                dname = DAY_SHORT.get(int(day), str(day))
                for key in sorted(set(new_slots) - set(old_slots)):
                    s = new_slots[key]
                    details.append("+ %s %d пара: %s" % (dname, s[0], slot_label(s)))
                for key in sorted(set(old_slots) - set(new_slots)):
                    s = old_slots[key]
                    details.append("− %s %d пара: %s" % (dname, s[0], slot_label(s)))
            added = sum(1 for d in details if d.startswith("+"))
            removed = sum(1 for d in details if d.startswith("−"))
            if added or removed:
                summary = "+%d −%d" % (added, removed)
        if not details:
            continue
        if len(details) > 8:
            details = details[:8] + ["… и ещё %d" % (len(details) - 8)]
        entries.append({
            "at": at,
            "group": (new_g or old_g).get("name") or gid,
            "summary": summary,
            "details": details,
        })
    return entries


def load_changelog():
    try:
        with open(CHANGELOG_OUT, encoding="utf-8") as fh:
            data = json.load(fh)
        if isinstance(data, dict) and isinstance(data.get("entries"), list):
            return data
    except Exception:
        pass
    return {"entries": []}


def load_old():
    try:
        with open(OUT, encoding="utf-8") as fh:
            data = json.load(fh)
        if isinstance(data, dict) and isinstance(data.get("groups"), list):
            return data
    except Exception:
        pass
    return None


def touch_checked_at():
    """Штамп «проверено сейчас» в уже существующем файле —
    сайт показывает время последней проверки, даже если разбор бедный."""
    try:
        if not os.path.exists(OUT):
            return
        with open(OUT, encoding="utf-8") as fh:
            payload = json.load(fh)
        if not isinstance(payload, dict):
            return
        payload["checkedAt"] = datetime.datetime.now(datetime.timezone.utc).replace(microsecond=0).isoformat()
        with open(OUT, "w", encoding="utf-8") as fh:
            json.dump(payload, fh, ensure_ascii=False, indent=1, sort_keys=False)
            fh.write("\n")
        print("checkedAt обновлён (контент без изменений)")
    except Exception as exc:
        print("checkedAt не записался: %s" % exc, file=sys.stderr)


def main():
    if len(sys.argv) > 1:
        pdf = sys.argv[1]  # локальный файл для проверки
    else:
        pdf = os.path.join(tempfile.mkdtemp(prefix="sched-"), "schedule.pdf")
        try:
            fetch_pdf(pdf)
        except Exception as exc:
            # сети нет / PDF не отдают: не роняем workflow, попробуем в следующий час
            print("пропуск: %s" % exc, file=sys.stderr)
            return 0

    try:
        cells = parse_pdf(pdf)
    except Exception as exc:
        print("пропуск: разбор упал: %s" % exc, file=sys.stderr)
        return 0

    parsed = {g["id"]: g for g in build_groups(cells)}
    if len(parsed) < 5:
        # разбор подозрительно бедный — файл не трогаем, но и не падаем
        print("разбор слишком бедный: групп %d — оставляем старый файл" % len(parsed), file=sys.stderr)
        touch_checked_at()
        return 0

    old = load_old()
    if old:
        old_groups = {str(g.get("id", "")).lower(): g for g in old["groups"] if isinstance(g, dict)}
        old_total = sum(day_count(g.get("days") or {}) for g in old_groups.values())
        out_groups = []
        replaced = 0
        for gid, old_g in old_groups.items():
            new_g = parsed.get(gid)
            old_count = day_count(old_g.get("days") or {})
            new_count = day_count(new_g["days"]) if new_g else 0
            # Заменяем группу только если новый разбор правдоподобен:
            # не меньше 40%% и не больше 250%% от прежнего числа пар.
            if new_g and old_count and 0.4 * old_count <= new_count <= 2.5 * old_count:
                out_groups.append(new_g)
                replaced += 1
            elif new_g and not old_count and new_count >= 4:
                out_groups.append(new_g)
                replaced += 1
            else:
                out_groups.append(old_g)
        for gid, new_g in parsed.items():
            if gid not in old_groups and day_count(new_g["days"]) >= 4:
                out_groups.append(new_g)
        total = sum(day_count(g["days"]) for g in out_groups)
        if old_total and total < 0.6 * old_total:
            print(
                "итог хуже старого файла: было %d пар, стало %d — оставляем старый" % (old_total, total),
                file=sys.stderr,
            )
            touch_checked_at()
            return 0
        print("групп: %d, обновлено из PDF: %d, пар: %d" % (len(out_groups), replaced, total))
        groups = sorted(out_groups, key=lambda g: g["name"].lower())
    else:
        groups = sorted(parsed.values(), key=lambda g: g["name"].lower())
        total = sum(day_count(g["days"]) for g in groups)
        if total < 30:
            print("разбор слишком бедный: занятий %d — оставляем старый файл" % total, file=sys.stderr)
            touch_checked_at()
            return 0

    old_groups_list = (old or {}).get("groups") or []
    changed = (not old) or (
        json.dumps(groups, ensure_ascii=False, sort_keys=True)
        != json.dumps(old_groups_list, ensure_ascii=False, sort_keys=True)
    )
    now_iso = datetime.datetime.now(datetime.timezone.utc).replace(microsecond=0).isoformat()
    if not changed:
        # Контент тот же: updatedAt (дата смены расписания) не трогаем,
        # но обновляем checkedAt — штамп на сайте покажет свежую проверку.
        payload = dict(old)
        payload["updatedAt"] = old.get("updatedAt") or now_iso
        payload["checkedAt"] = now_iso
        with open(OUT, "w", encoding="utf-8") as fh:
            json.dump(payload, fh, ensure_ascii=False, indent=1, sort_keys=False)
            fh.write("\n")
        print("без изменений: групп %d, пар %d — обновлён checkedAt" % (len(groups), total))
        return 0

    payload = {
        "updatedAt": now_iso,
        "checkedAt": now_iso,
        "source": PDF_URL,
        "groups": groups,
    }
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w", encoding="utf-8") as fh:
        json.dump(payload, fh, ensure_ascii=False, indent=1, sort_keys=False)
        fh.write("\n")

    # Журнал изменений для кнопки «?» в настройках — только при реальных отличиях.
    old_map = {str(g.get("id", "")).lower(): g for g in old_groups_list if isinstance(g, dict)}
    if old_map:
        entries = diff_schedules(old_map, {g["id"]: g for g in groups}, now_iso)
        if entries:
            changelog = load_changelog()
            changelog["entries"] = (entries + changelog.get("entries", []))[:CHANGELOG_LIMIT]
            with open(CHANGELOG_OUT, "w", encoding="utf-8") as fh:
                json.dump(changelog, fh, ensure_ascii=False, indent=1)
                fh.write("\n")
            print("журнал: +%d записей" % len(entries))
    print("готово: групп %d, занятий %d" % (len(groups), total))
    return 0


if __name__ == "__main__":
    sys.exit(main())
