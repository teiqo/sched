// расписание групп — данные приезжают из data/schedule.json (парсер PDF на GitHub Action)
// parity: "even" (чётная) | "odd" (нечётная); self — самостоятельная работа

export const BELLS = [
  { n: 1, week: "8:30–10:05", sat: "8:30–10:05" },
  { n: 2, week: "10:15–11:50", sat: "10:15–11:50" },
  { n: 3, week: "12:30–14:05", sat: "12:10–13:45" },
  { n: 4, week: "14:15–15:50", sat: "13:55–15:30" },
  { n: 5, week: "16:00–17:35", sat: "15:40–17:10" },
  { n: 6, week: "17:45–19:20", sat: "17:45–19:20" },
];

export const TIMES = {
  1: { week: ["08:30", "10:05"], sat: ["08:30", "10:05"] },
  2: { week: ["10:15", "11:50"], sat: ["10:15", "11:50"] },
  3: { week: ["12:30", "14:05"], sat: ["12:10", "13:45"] },
  4: { week: ["14:15", "15:50"], sat: ["13:55", "15:30"] },
  5: { week: ["16:00", "17:35"], sat: ["15:40", "17:10"] },
  6: { week: ["17:45", "19:20"], sat: ["17:45", "19:20"] },
};

const DAY_META = [
  { id: 1, short: "пн", name: "понедельник" },
  { id: 2, short: "вт", name: "вторник" },
  { id: 3, short: "ср", name: "среда" },
  { id: 4, short: "чт", name: "четверг" },
  { id: 5, short: "пт", name: "пятница" },
  { id: 6, short: "сб", name: "суббота" },
  { id: 0, short: "вс", name: "воскресенье" },
];

/* Зашитых данных больше нет: всё приходит от парсера. */

// окна проставляются автоматически: все доступные пары звонков дня (1..6)
function buildDays(rawDays) {
  return DAY_META.map((meta) => {
    const items = (rawDays[meta.id] || []).slice().sort((a, b) => a[0] - b[0]);
    const sat = meta.id === 6;
    const isSunday = meta.id === 0;
    const maxBells = isSunday ? 0 : BELLS.length;
    const last = Math.max(maxBells, items.length ? items[items.length - 1][0] : 0);
    const slots = [];
    for (let n = 1; n <= last; n += 1) {
      const times = sat ? TIMES[n] && TIMES[n].sat : TIMES[n] && TIMES[n].week;
      if (!times) continue;
      const hits = items.filter((it) => it[0] === n);
      if (!hits.length) {
        slots.push({ n, from: times[0], to: times[1], empty: true });
        continue;
      }
      hits.forEach((it) => {
        const extra = it[4] || {};
        slots.push({
          n,
          from: times[0],
          to: times[1],
          subject: it[1],
          teacher: it[2] || undefined,
          room: it[3] || undefined,
          self: extra.self ? true : undefined,
          parity: extra.parity || undefined,
        });
      });
    }
    return { id: meta.id, short: meta.short, name: meta.name, slots };
  });
}

export const GROUPS = [];

export const DEFAULT_GROUP = "";

/* Пока парсер не отработал ни разу, список пуст — отдаём заглушку,
   чтобы приложение спокойно показывало пустые дни. */
const EMPTY_GROUP = { id: "", name: "не выбрано", days: buildDays({}) };

export function groupById(id) {
  return GROUPS.find((g) => g.id === id) || EMPTY_GROUP;
}

export function lessonCount(id) {
  return groupById(id).days.reduce((sum, day) => sum + day.slots.filter((s) => !s.empty).length, 0);
}

/* Расписание с сайта колледжа: data/schedule.json замещает встроенные группы. */

/* Номер аудитории посреди названия = склейка колонок PDF, такую пару отбрасываем.
   Лимиты как у парсера: длинные предметы вида «МДК 01.01 …» — легальные. */
function saneSubject(subject) {
  if (subject.length < 3 || subject.length > 175) return false;
  const words = subject.split(/\s+/);
  if (words.length > 20) return false;
  for (let i = 0; i < words.length - 1; i += 1) {
    if (/^\d{2,3}[а-я]?$/.test(words[i])) return false;
  }
  return true;
}

function rawFromRemote(days) {
  const raw = {};
  Object.keys(days || {}).forEach((key) => {
    const dayId = Number(key);
    if (!dayId) return;
    const items = Array.isArray(days[key]) ? days[key] : [];
    const list = [];
    items.forEach((it) => {
      if (!Array.isArray(it) || it.length < 2) return;
      const n = Number(it[0]);
      if (!n || n < 1 || n > 6) return;
      const subject = String(it[1] || "").trim();
      if (!subject || !saneSubject(subject)) return;
      // Keep vacancies in the data. Each user chooses whether to display them.
      const extra = it[4] && typeof it[4] === "object" ? it[4] : {};
      list.push([n, subject, it[2] || "", it[3] || "", extra]);
    });
    if (list.length) raw[dayId] = list;
  });
  return raw;
}

function lessonsIn(group) {
  return group.days.reduce((sum, day) => sum + day.slots.filter((s) => !s.empty).length, 0);
}

export function applyRemoteGroups(payload) {
  if (!payload || !Array.isArray(payload.groups) || !payload.groups.length) return 0;
  const builtIn = new Map(GROUPS.map((g) => [g.id, g]));
  const next = [];
  const seen = new Set();
  payload.groups.forEach((item) => {
    if (!item || !item.id) return;
    const id = String(item.id).trim().toLowerCase();
    if (!id || seen.has(id)) return;
    seen.add(id);
    const group = {
      id,
      name: String(item.name || item.id).trim(),
      days: buildDays(rawFromRemote(item.days)),
    };
    const local = builtIn.get(id);
    /* Если разбор PDF для группы пустой, оставляем проверенные данные сборки. */
    const remoteLessons = lessonsIn(group);
    const localLessons = local ? lessonsIn(local) : 0;
    /* Пустой или подозрительно обрезанный разбор PDF не применяем: остаёмся на данных сборки. */
    next.push(local && localLessons && remoteLessons * 2 < localLessons ? local : group);
  });
  GROUPS.forEach((group) => {
    if (!seen.has(group.id)) next.push(group);
  });
  if (!next.length) return 0;
  next.sort((a, b) => a.name.localeCompare(b.name, "ru"));
  GROUPS.length = 0;
  next.forEach((group) => GROUPS.push(group));
  return GROUPS.length;
}
