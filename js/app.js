import { BELLS, TIMES, GROUPS, DEFAULT_GROUP, groupById, lessonCount } from "./schedule.js";

const KEY = "weekly:groups:v2";
/* Локальная демонстрация никогда не получает облачные права и не пишет в Firebase. */
const LOCAL_PREVIEW = ["localhost", "127.0.0.1", "[::1]", "::1"].includes(location.hostname);
const LOCAL_TG_KEY = "weeqo:local-telegram-demo:v1";
const motionQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
const compactHeaderQuery = window.matchMedia("(max-width: 430px)");
const SHORT = ["пн", "вт", "ср", "чт", "пт", "сб", "вс"];
const MONTHS = [
  "января",
  "февраля",
  "марта",
  "апреля",
  "мая",
  "июня",
  "июля",
  "августа",
  "сентября",
  "октября",
  "ноября",
  "декабря",
];
/* Базовая тема, акцент и градиентный акцент+ выбранного цвета. */
const PALETTES = ["default", "accent", "accent-plus"];
const DEFAULT_ACCENT = "#0A84FF";

const PALETTE_COLORS = {
  default: { light: "#F5F5F7", dark: "#000000" },
  accent: { light: "#F5F5F7", dark: "#000000" },
  "accent-plus": { light: "#F5F5F7", dark: "#000000" },
};
const PALETTE_LABEL = {
  default: "базовая",
  accent: "акцент",
  "accent-plus": "акцент+",
};

/* Цвет текста поверх акцента: светлые оттенки требуют тёмного текста. */
function accentInk(hex) {
  const n = String(hex || "").replace("#", "");
  if (n.length !== 6) return "#ffffff";
  const ch = (i) => parseInt(n.slice(i, i + 2), 16) / 255;
  const lin = (c) => (c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
  const lum = 0.2126 * lin(ch(0)) + 0.7152 * lin(ch(2)) + 0.0722 * lin(ch(4));
  if (1.05 / (lum + 0.05) >= 4.5) return "#ffffff";
  return (lum + 0.05) / (accentLuminance("#101014") + 0.05) >= 4.5 ? "#101014" : "#000000";
}

/* Ведение мышью или пальцем по рулетке рисует точно такую же сцену,
           как колесо мыши: день + блок «следующих дней» с той же анимацией,
           поэтому после отпускания ничего не перерисовывается заново. */
function mixHex(hex, base, ratio) {
  const a = String(hex || "").replace("#", "");
  const b = String(base || "").replace("#", "");
  if (a.length !== 6 || b.length !== 6) return "#" + (a || b || "000000");
  const part = (i) => {
    const x = parseInt(a.slice(i, i + 2), 16);
    const y = parseInt(b.slice(i, i + 2), 16);
    return Math.round(x * ratio + y * (1 - ratio))
      .toString(16)
      .padStart(2, "0");
  };
  return `#${part(0)}${part(2)}${part(4)}`;
}

const ICON_EMPTY =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" aria-hidden="true"><rect x="3" y="5" width="18" height="16" rx="3"/><path d="M8 3v4M16 3v4M3 11h18M10 16l4-4M14 16l-4-4"/></svg>';
const ICON_CLOCK =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="8"/><path d="M12 8v4l3 2"/></svg>';

const $ = (sel) => document.querySelector(sel);

/* Тема по умолчанию — системная; сохранённая переопределяет её в load(). */
const systemTheme = () =>
  typeof window !== "undefined" &&
  window.matchMedia &&
  window.matchMedia("(prefers-color-scheme: light)").matches
    ? "light"
    : "dark";

/* Режим производительности: data-perf на <html>, по CSS остаются только
   прозрачностные анимации, тяжёлые blur/эффекты выключаются. */
function applyPerfMode() {
  if (state.perfMode) document.documentElement.setAttribute("data-perf", "1");
  else document.documentElement.removeAttribute("data-perf");
  const sw = $("#perf-switch");
  if (sw) sw.setAttribute("aria-pressed", state.perfMode ? "true" : "false");
  const hint = $("#perf-hint");
  if (hint)
    hint.textContent = state.perfMode ? "без анимаций и эффектов" : "все эффекты";
}

var state = {
  selected: defaultSelectedDate(),
  tab: "schedule",
  theme: systemTheme(),
  themeManual: false,
  perfMode: false,
  palette: "default",
  accent: DEFAULT_ACCENT,
  windows: false,
  parityMode: "auto",
  settingsOpen: false,
  nowOverride: null,
  light: false,
  /* На телефоне по умолчанию только выбранный день; «вся неделя» — тумблером. */
  scope: (typeof window !== "undefined" && window.matchMedia && window.matchMedia("(max-width: 740px)").matches) ? "day" : "week",
  group: DEFAULT_GROUP,
  draftGroup: DEFAULT_GROUP,
  onboarded: false,
  profileOpen: false,
  onboardingStep: 0,
};
if (typeof window !== "undefined") window.state = state;

let quietMotion = false;
let scrubPendingRender = false;
let sceneTimer = null;
let sceneOutTimer = null;
let brandTimer = null;
let scheduleRevision = 0;
let lastRenderAt = 0;

function cssTimeMs(name, fallback) {
  const raw = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  if (!raw) return fallback;
  const n = Number.parseFloat(raw);
  if (!Number.isFinite(n)) return fallback;
  return raw.endsWith("ms") ? n : raw.endsWith("s") ? n * 1000 : n;
}

function cssVar(name, fallback) {
  const raw = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return raw || fallback;
}

function minAllowedDate() {
  return weekStart(startOfDay(currentDate()));
}

function clampDate(d) {
  const x = startOfDay(d);
  const min = minAllowedDate();
  return x < min ? min : x;
}

function snapshotVisual(el) {
  const cs = getComputedStyle(el);
  return {
    opacity: cs.opacity,
    transform: !cs.transform || cs.transform === "none" ? "translate3d(0,0,0)" : cs.transform,
    filter: !cs.filter || cs.filter === "none" ? "blur(0px)" : cs.filter,
  };
}

function currentGroup() {
  return groupById(state.group);
}

function groupName() {
  return currentGroup().id;
}

function groupOptions(selected) {
  return GROUPS.map(
    (g) => `<option value="${escapeHtml(g.id)}"${g.id === selected ? " selected" : ""}>${escapeHtml(g.id)}</option>`
  ).join("");
}

// ?now=10:40 — подмена времени для проверки карточки «сейчас»
function currentDate() {
  if (typeof state !== "undefined" && state && state.nowOverride !== null) {
    if (state.nowOverride instanceof Date) return new Date(state.nowOverride);
    const d = new Date();
    d.setHours(Math.floor(state.nowOverride / 60), state.nowOverride % 60, 0, 0);
    return d;
  }
  return new Date();
}

let liveKey = "";
let tickTimer = null;

/* ---------- даты ---------- */

function startOfDay(d) {
  const x = new Date(d.getTime());
  x.setHours(0, 0, 0, 0);
  return x;
}

function addDays(d, n) {
  const x = new Date(d.getTime());
  x.setDate(x.getDate() + n);
  return startOfDay(x);
}

function weekStart(d) {
  const x = startOfDay(d);
  const shift = (x.getDay() + 6) % 7;
  return addDays(x, -shift);
}

function defaultSelectedDate() {
  return startOfDay(currentDate());
}

function sameDay(a, b) {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

function isoWeek(d) {
  const x = startOfDay(d);
  const day = (x.getDay() + 6) % 7;
  x.setDate(x.getDate() - day + 3);
  const first = new Date(x.getFullYear(), 0, 4);
  const fd = (first.getDay() + 6) % 7;
  first.setDate(first.getDate() - fd + 3);
  return 1 + Math.round((x - first) / 604800000);
}

function iso(d) {
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function dateLabel(d) {
  return `${dayEntry(d).name}, ${d.getDate()} ${MONTHS[d.getMonth()]}`;
}

function relLabel(d) {
  const today = startOfDay(currentDate());
  const diff = Math.round((d - today) / 86400000);
  if (diff === 0) return "сегодня";
  if (diff === 1) return "завтра";
  if (diff === -1) return "вчера";
  return null;
}

/* ---------- расписание ---------- */

function dayEntry(d) {
  const days = currentGroup().days;
  const id = d.getDay();
  return days.find((x) => x.id === id) || days[days.length - 1];
}

// счёт учебных недель идёт от 1 сентября: неделя с 1 сентября — первая, и она считается чётной
function academicWeek(d) {
  const mondayOf = weekStart(startOfDay(d));
  let year = mondayOf.getFullYear();
  let anchor = weekStart(new Date(year, 8, 1));
  if (mondayOf < anchor) {
    year -= 1;
    anchor = weekStart(new Date(year, 8, 1));
  }
  return Math.round((mondayOf - anchor) / 604800000) + 1;
}

function parityOf(d) {
  if (state.parityMode !== "auto") return state.parityMode;
  // сентябрь стартует с чётной недели
  return academicWeek(d) % 2 === 1 ? "even" : "odd";
}

function parityLabel(p) {
  return p === "odd" ? "нечётная" : "чётная";
}

function subInfo(slot) {
  return { ok: true, teacher: slot.teacher, room: slot.room, tag: null };
}

// все слоты дня с учётом чётности и подгруппы
/* лето — каникулы: июнь, июль, август без пар и красные в полосе */
function isSummer(d) {
  const m = d.getMonth();
  return m === 5 || m === 6 || m === 7;
}

function isDayOff(d) {
  return d.getDay() === 0 || isSummer(d);
}

function slotsForBase(d) {
  if (isSummer(d)) return [];
  const p = parityOf(d);
  const entry = dayEntry(d);
  const sat = d.getDay() === 6;
  const isSunday = d.getDay() === 0;
  const maxN = isSunday ? 0 : 6;

  const filtered = entry.slots
    .filter((s) => !s.parity || s.parity === p)
    .map((s) => {
      const info = subInfo(s);
      const isWindow = Boolean(s.empty) || !info.ok;
      return {
        n: s.n,
        from: s.from,
        to: s.to,
        subject: s.subject,
        self: Boolean(s.self),
        window: isWindow,
        empty: Boolean(s.empty),
        teacher: info.ok ? info.teacher : null,
        room: info.ok ? info.room : null,
        tag: info.ok ? info.tag : null,
      };
    });

  if (maxN === 0) return filtered;

  const result = [];
  for (let n = 1; n <= maxN; n += 1) {
    const existing = filtered.find((s) => s.n === n);
    if (existing) {
      result.push(existing);
    } else {
      const times = sat ? (TIMES[n] && TIMES[n].sat) : (TIMES[n] && TIMES[n].week);
      if (times) {
        result.push({
          n,
          from: times[0],
          to: times[1],
          subject: "",
          self: false,
          window: true,
          empty: true,
          teacher: null,
          room: null,
          tag: null,
        });
      }
    }
  }
  filtered.forEach((s) => {
    if (s.n > maxN && !result.some((r) => r.n === s.n)) {
      result.push(s);
    }
  });
  result.sort((a, b) => a.n - b.n);
  return result;
}

function lessonsFor(d) {
  return slotsFor(d).filter((s) => !s.window);
}

function mins(hhmm) {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
}

function nowMins(now) {
  return now.getHours() * 60 + now.getMinutes() + now.getSeconds() / 60;
}

function fmtLeft(m) {
  const total = Math.max(0, Math.round(m));
  const h = Math.floor(total / 60);
  const r = total % 60;
  if (h && r) return `${h} ч ${r} мин`;
  if (h) return `${h} ч`;
  return `${r} мин`;
}

function plural(n, one, few, many) {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) return few;
  return many;
}

function liveState(d) {
  const now = currentDate();
  if (!sameDay(d, startOfDay(now))) return null;
  const list = lessonsFor(d);
  if (!list.length) return null;
  const cur = nowMins(now);
  for (const s of list) {
    const from = mins(s.from);
    const to = mins(s.to);
    if (cur >= from && cur < to) {
      return {
        kind: "current",
        slot: s,
        left: to - cur,
        passed: cur - from,
        progress: (cur - from) / (to - from),
        now,
      };
    }
  }
  const next = list.find((s) => mins(s.from) > cur);
  if (next) return { kind: "next", slot: next, left: mins(next.from) - cur, progress: 0, now };
  return { kind: "done", slot: list[list.length - 1], left: 0, progress: 1, now };
}

/* ---------- разметка ---------- */

function clockText(now) {
  const p = (n) => String(n).padStart(2, "0");
  return `${p(now.getHours())}:${p(now.getMinutes())}:${p(now.getSeconds())}`;
}

function metaHtml(slot) {
  const parts = [];
  if (slot.teacher) {
    const teacher = escapeHtml(slot.teacher);
    const vacancy = slot.teacher.trim().toLowerCase() === "вакансия";
    parts.push(
      `<span class="lesson-type-accent${vacancy ? " is-vacancy" : ""}">• ${teacher}</span>`
    );
  }
  if (slot.room) parts.push(`<span class="lesson-room">ауд. ${slot.room}</span>`);
  if (slot.tag) parts.push(`<span class="lesson-location">${slot.tag}</span>`);
  if (slot.self) parts.push(`<span class="lesson-origin-mark is-local">сам. работа</span>`);
  if (!slot.teacher && !slot.room && !slot.self) {
    parts.push(`<span class="lesson-location">без аудитории</span>`);
  }
  return parts.join("");
}

function liveCardHtml(live) {
  if (!live || live.kind === "done") return "";
  const s = live.slot;
  const current = live.kind === "current";
  const status = current
    ? `<span><i></i>сейчас · ${s.n} пара</span><time id="live-clock">${clockText(live.now)}</time>`
      : `<span>${ICON_CLOCK}далее · ${s.n} пара</span><time id="live-clock">${s.from}</time>`;
  const progress = current
    ? `<div class="live-card-progress"><i id="live-progress" style="transform:scaleX(${live.progress.toFixed(
        3
      )})"></i></div>`
    : "";
  const timing = current
    ? `<div class="live-card-timing"><span class="live-card-range">${s.from}–${s.to}<small id="live-passed">прошло ${fmtLeft(
        live.passed
      )}</small></span><span id="live-left">осталось ${fmtLeft(live.left)}</span></div>`
    : `<div class="live-card-timing is-next-timing"><strong id="live-left">через ${fmtLeft(
        live.left
      )}</strong><span class="live-next-range">${s.from}–${s.to}</span></div>`;
  const body = `
    <div class="live-card-status">${status}</div>
    <h3>${s.subject}</h3>
    <p class="lesson-meta">${metaHtml(s)}</p>
    ${progress}
    ${timing}`;

  if (!current) {
    return `<article class="live-lesson-card is-next">${body}</article>`;
  }
  return `<article class="live-lesson-card is-current">
    <div class="live-card-glass">
      <div class="live-card-particles" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i><i></i></div>
      ${body}
    </div>
  </article>`;
}

function rowHtml(slot, live, dIso) {
  const isCurrent = live && live.kind === "current" && live.slot.n === slot.n && !slot.window;
  const isNext = live && live.kind === "next" && live.slot.n === slot.n && !slot.window;
  const cls = ["agenda-row"];
  if (isCurrent) cls.push("is-overlap");
  if (isNext) cls.push("is-next");
  if (slot.tag) cls.push("is-subgroup-row");
  if (slot.cancelled) cls.push("is-cancelled");
  if (slot.swapped) cls.push("is-swapped");

  const time = `<div class="agenda-row-time"><time>${slot.from}<span>${slot.to}</span></time></div>`;

  if (slot.window) {
    cls.push("is-window-row");
    return `<div class="${cls.join(" ")}" data-act="swap" data-date="${dIso}" data-n="${slot.n}" role="button" tabindex="0" aria-label="окно, ${slot.n} пара, нажми, чтобы изменить">${time}<div class="agenda-row-content">
      <strong>окно</strong>
    </div><span class="lesson-swap-btn is-window-hint" aria-hidden="true">${ICON_SWAP}</span></div>`;
  }

  const mark = isCurrent
    ? `<span class="lesson-origin-mark is-overlap">сейчас</span>`
    : isNext
      ? `<span class="lesson-origin-mark is-next">далее</span>`
      : "";

  const swapMark = slot.cancelled
    ? `<span class="lesson-origin-mark is-swap">отменена</span>`
    : slot.swapped
      ? `<span class="lesson-origin-mark is-swap">замена</span>`
      : "";

  return `<div class="${cls.join(" ")}">${time}<div class="agenda-row-content">
    <strong>${slot.subject}${swapMark}${mark}</strong>
    <span class="lesson-meta">${metaHtml(slot)}</span>
    <small>${slot.n} пара · 1 ч 35 мин</small>
  </div>${swapButtonHtml(dIso, slot.n)}</div>`;
}

/* Перерыв между парами: маленький чип, встроенный в линию-разделитель
   (в духе подложки аудитории, только на стыке строк). */
function breakChipHtml(gap) {
  return `<div class="agenda-break"><span class="agenda-break-chip">${gap >= 30 ? "большой перерыв" : "перерыв"} · <strong>${bellDuration(gap)}</strong></span></div>`;
}

/* Между соседними парами вставляем чип перерыва.
   Рядом с окном не ставим — строка окна сама про разрыв говорит. */
function withBreaksHtml(slots, live, dIso) {
  const out = [];
  let prev = null;
  slots.forEach((s) => {
    if (prev && !prev.window && !s.window) {
      const gap = mins(s.from) - mins(prev.to);
      if (gap > 0) out.push(breakChipHtml(gap));
    }
    out.push(rowHtml(s, live, dIso));
    prev = s;
  });
  return out.join("");
}

function emptyDayHtml(d) {
  const summer = isSummer(d);
  const off = isDayOff(d);
  const title = summer ? "каникулы" : off ? "выходной" : "пар нет";
  const note = summer
    ? "лето — занятий нет"
    : off
      ? "воскресенье — занятий нет"
      : `в этот день у ${groupName()} пар нет (${parityLabel(parityOf(d))} неделя)`;
  return `<div class="weekly-empty-day">${ICON_EMPTY}<strong>${title}</strong><span>${note}</span></div>`;
}

function headingHtml(d, sub) {
  const today = sameDay(d, startOfDay(currentDate()));
  const title = today
    ? "сегодня"
    : `<span class="weekly-day-weekday">${escapeHtml(dayEntry(d).name)}, </span><span class="weekly-day-date">${d.getDate()} ${MONTHS[d.getMonth()]}</span>`;
  const rel = today ? "" : relLabel(d);
  return `<div class="weekly-day-heading t-stagger is-shown">
    <div class="weekly-day-heading-copy">
      <h2 class="t-stagger-line t-stagger-line--1">${title}</h2>
      <span class="t-stagger-line t-stagger-line--2">${sub}${rel ? ` · ${rel}` : ""}</span>
    </div>
  </div>`;
}

function checkCompactHeading() {
  document.querySelectorAll(".weekly-day-heading.is-compact-date").forEach((h) => {
    h.classList.remove("is-compact-date");
  });
}

function completedLabel(n) {
  if (n === 1) return "1 пара завершена";
  if (n > 1 && n < 5) return `${n} пары завершены`;
  return `${n} пар завершено`;
}

let completedOpen = false;

function completedBlockHtml(slots, dIso) {
  if (!slots.length) return "";
  const open = completedOpen ? "true" : "false";
  return `<div class="completed-lessons t-acc" data-open="${open}">
    <button class="completed-lessons-toggle t-acc-head" type="button" aria-expanded="${open}" data-act="toggle-completed">
      <span class="completed-lessons-label">${ICON_CLOCK}${completedLabel(slots.length)}</span>
      <span class="completed-lessons-chevron t-acc-chevron">${ICON_CHEVRON}</span>
    </button>
    <div class="completed-lessons-panel t-acc-panel" aria-hidden="${completedOpen ? "false" : "true"}">
      <div class="completed-lessons-panel-inner t-acc-panel-inner">
        <div class="agenda-list is-completed">${slots
          .map((s) => rowHtml(s, null, dIso))
          .join("")}</div>
      </div>
    </div>
  </div>`;
}

function renderSlotRuns(slots, live, dIso) {
  if (!slots.length) return "";
  const runs = [];
  let currentRun = [];
  let currentIsWindow = null;

  for (const s of slots) {
    const isWin = Boolean(s.window);
    if (currentIsWindow === null || isWin === currentIsWindow) {
      currentRun.push(s);
      currentIsWindow = isWin;
    } else {
      runs.push({ isWindow: currentIsWindow, items: currentRun });
      currentRun = [s];
      currentIsWindow = isWin;
    }
  }
  if (currentRun.length) {
    runs.push({ isWindow: currentIsWindow, items: currentRun });
  }

  return runs
    .map((run) => {
      if (run.isWindow) {
        return `<div class="agenda-list">${withBreaksHtml(run.items, live, dIso)}</div>`;
      }
      return completedBlockHtml(run.items, dIso);
    })
    .join("");
}

function dayHtml(d, withLive, future) {
  const dIso = iso(d);
  const all = slotsFor(d);
  const lessons = all.filter((s) => !s.window);
  const rows = state.windows ? all : lessons;
  const live = withLive ? liveState(d) : null;
  const count = lessons.length;
  const today = sameDay(d, startOfDay(currentDate()));
  const sub = count
    ? `${count} ${plural(count, "пара", "пары", "пар")} · ${parityLabel(parityOf(d))} неделя`
    : `${parityLabel(parityOf(d))} неделя`;

  let body;
  if (!count && (!state.windows || !rows.length)) {
    body = emptyDayHtml(d);
  } else if (!today || !withLive || future) {
    body = rows.length ? `<div class="agenda-list">${withBreaksHtml(rows, live, dIso)}</div>` : "";
  } else if (live && (live.kind === "current" || live.kind === "next")) {
    const liveN = live.slot.n;
    const earlier = rows.filter((s) => s.n < liveN);
    const later = rows.filter((s) => s.n > liveN);
    const earlierHtml = renderSlotRuns(earlier, live, dIso);
    const liveHost = `<div id="live-host">${liveCardHtml(live)}</div>`;
    const laterHtml = later.length
      ? `<div class="agenda-list">${withBreaksHtml(later, live, dIso)}</div>`
      : "";
    body = `${earlierHtml}${liveHost}${laterHtml}`;
  } else {
    const earlierHtml = renderSlotRuns(rows, live, dIso);
    const liveHost = withLive && live ? `<div id="live-host">${liveCardHtml(live)}</div>` : "";
    body = `${earlierHtml}${liveHost}`;
  }

  return `<div class="weekly-day-block${future ? " is-future" : ""}" data-day="${dIso}">${headingHtml(d, sub)}${body}</div>`;
}

function weekHtml() {
  const ws = weekStart(state.selected);
  const p = parityLabel(parityOf(state.selected));
  const days = [];
  for (let i = 0; i < 7; i += 1) {
    const d = addDays(ws, i);
    const all = slotsFor(d);
    const lessons = all.filter((s) => !s.window);
    const rows = state.windows ? all : lessons;
    days.push(`<div class="weekly-day-block">
      <div class="weekly-day-heading">
        <div class="weekly-day-heading-copy">
          <h2>${dayEntry(d).name}, ${d.getDate()} ${MONTHS[d.getMonth()]}</h2>
          <span>${
            lessons.length
              ? `${lessons.length} ${plural(lessons.length, "пара", "пары", "пар")}`
              : "пар нет"
          }</span>
        </div>
        ${sameDay(d, startOfDay(currentDate())) ? '<span class="weekly-week-badge">сегодня</span>' : ""}
      </div>
      ${
        lessons.length || (state.windows && rows.length)
          ? `<div class="agenda-list">${withBreaksHtml(rows, null, iso(d))}</div>`
          : `<div class="weekly-empty-day compact">${ICON_EMPTY}<strong>${
              isSummer(d) ? "каникулы" : d.getDay() === 0 ? "выходной" : "пар нет"
            }</strong></div>`
      }
    </div>`);
  }
  return `<div class="weekly-day-block">
      <div class="weekly-day-heading">
        <div class="weekly-day-heading-copy">
          <h2>неделя ${academicWeek(state.selected)}</h2>
          <span>${p} неделя · ${groupName()}</span>
        </div>
      </div>
    </div>${days.join("")}`;
}

function bellMinutes(value) {
  const [h, m] = String(value).split(":").map(Number);
  return h * 60 + m;
}

function bellRange(text) {
  if (!text || text === "—") return null;
  const parts = String(text).split("–");
  if (parts.length < 2) return null;
  const from = parts[0].trim();
  const to = parts[1].trim();
  if (!from || !to) return null;
  return { from, to };
}

function bellDuration(minutes) {
  if (minutes >= 60) {
    const h = Math.floor(minutes / 60);
    const rest = minutes % 60;
    return rest ? `${h} ч ${rest} мин` : `${h} ч`;
  }
  return `${minutes} мин`;
}

function bellItems(kind) {
  return BELLS.map((b) => ({
    n: b.n,
    range: bellRange(kind === "sat" ? b.sat : b.week),
  })).filter((item) => item.range);
}

// пары и перерывы между ними о��ним списком
function bellsRows(kind) {
  const items = bellItems(kind);
  const rows = [];
  items.forEach((item, i) => {
    const lesson = bellMinutes(item.range.to) - bellMinutes(item.range.from);
    rows.push(`<div class="agenda-row is-bell-pair">
      <div class="agenda-row-time"><time>${item.n} пара</time></div>
      <div class="agenda-row-content">
        <strong>${item.range.from}–${item.range.to}</strong>
        <small>${bellDuration(lesson)}</small>
      </div>
    </div>`);
    const next = items[i + 1];
    if (!next) return;
    const gap = bellMinutes(next.range.from) - bellMinutes(item.range.to);
    if (gap <= 0) return;
    rows.push(`<div class="agenda-break"><span class="agenda-break-chip" title="${gap >= 30 ? "большой перерыв" : "перерыв"}">перерыв · <strong>${bellDuration(gap)}</strong></span></div>`);
  });
  return rows.join("");
}

function bellsHtml() {
  const weekdayCount = bellItems("week").length;
  const satCount = bellItems("sat").length;
  return `<div class="weekly-day-block">
    <div class="weekly-day-heading">
      <div class="weekly-day-heading-copy">
        <button class="weekly-onboarding-back" type="button" data-act="back-schedule">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M15 6l-6 6 6 6"/></svg>
          к расписанию
        </button>
        <h2>расписание звонков</h2>
        <span>группа ${groupName()} · с перерывами</span>
      </div>
    </div>

    <div class="bells-grid">
      <section class="bells-section">
        <div class="bells-section-head">
          <strong>будни</strong>
          <span>пн–пт · ${weekdayCount} ${plural(weekdayCount, "пара", "пары", "пар")}</span>
        </div>
        <div class="agenda-list">${bellsRows("week")}</div>
      </section>

      <section class="bells-section">
        <div class="bells-section-head">
          <strong>суббота</strong>
          <span>сб · ${satCount} ${plural(satCount, "пара", "пары", "пар")}</span>
        </div>
        <div class="agenda-list">${bellsRows("sat")}</div>
      </section>
    </div>
  </div>`;
}

/* ---------- рендер ---------- */

function setScene(html, direction) {
  const stage = $("#stage");
  const old = $("#day-scene");
  if (old && old._weeqoHtml === html) return;
  if (sceneOutTimer !== null) {
    window.clearTimeout(sceneOutTimer);
    sceneOutTimer = null;
  }

  if (sceneTimer !== null) {
    window.clearTimeout(sceneTimer);
    sceneTimer = null;
  }
  stage.querySelectorAll(".weekly-active-day-scene").forEach((node) => {
    if (node !== old) node.remove();
  });

  if (!old) {
    const first = document.createElement("div");
    first.className = "weekly-active-day-scene";
    first.id = "day-scene";
    first._weeqoHtml = html;
    first.innerHTML = html;
    stage.appendChild(first);
    setupLazyDays();
    return;
  }

  const scene = $("#scene");
  const reduced =
    Boolean(state.perfMode) ||
    window.matchMedia("(prefers-reduced-motion: reduce)").matches ||
    Boolean(scene && scene.classList.contains("is-motion-lite"));

  if (!direction || reduced) {
    old.getAnimations().forEach((a) => a.cancel());
    old.classList.remove("is-leaving", "is-entering");
    old.removeAttribute("data-direction");
    old.style.cssText = "";
    /* При открытии одинаковый контент применяется дважды (кэш, затем сеть) —
       без этого стража анимация появления пар играла два раза подряд. */
    if (old._weeqoHtml !== html) {
      old._weeqoHtml = html;
      old.innerHTML = html;
    }
    old.inert = false;
    old.removeAttribute("aria-hidden");
    setupLazyDays();
    return;
  }

  const from = snapshotVisual(old);
  old.getAnimations().forEach((a) => a.cancel());
  old.classList.remove("is-leaving", "is-entering");
  old.removeAttribute("data-direction");
  old.removeAttribute("id");
  old.classList.add("is-leaving");
  old.inert = true;
  old.setAttribute("aria-hidden", "true");
  old.dataset.direction = direction;
  old.style.animation = "none";

  const next = document.createElement("div");
  next.className = "weekly-active-day-scene is-entering";
  next.id = "day-scene";
  next.dataset.direction = direction;
  next.style.animation = "none";
  next._weeqoHtml = html;
  next.innerHTML = html;
  stage.appendChild(next);
  setupLazyDays();

  const dist = cssVar("--page-slide-distance", "8px");
  const ease = cssVar("--page-slide-ease", "cubic-bezier(0.22, 1, 0.36, 1)");
  const dur = cssTimeMs("--page-slide-dur", 250);
  const outX =
    direction === "forward" ? `translate3d(calc(${dist} * -1), 0, 0)` : `translate3d(${dist}, 0, 0)`;
  const inX =
    direction === "forward" ? `translate3d(${dist}, 0, 0)` : `translate3d(calc(${dist} * -1), 0, 0)`;

  const outAnim = old.animate(
    [
      { opacity: from.opacity, transform: from.transform },
      { opacity: 0, transform: outX },
    ],
    { duration: dur, easing: ease, fill: "forwards" }
  );
  const inAnim = next.animate(
    [
      { opacity: 0, transform: inX },
      { opacity: 1, transform: "translate3d(0, 0, 0)" },
    ],
    { duration: dur, easing: ease, fill: "both" }
  );

  /* Каскадные анимации строк длятся дольше смены подложки: раньше таймер
     обрывал их через dur, и при скролле/быстром листании пары моргали.
     Ждём полного каскада и трогаем только свои WAAPI-анимации. */
  const rowDur = cssTimeMs("--duration-fast", 320);
  const rowStep = cssTimeMs("--duration-stagger", 55);
  const total = Math.max(dur, rowDur + rowStep * 8);

  /* Уходящая неделя больше не остаётся в дереве весь каскад входящих строк. */
  sceneOutTimer = window.setTimeout(() => {
    old.remove();
    outAnim.cancel();
    sceneOutTimer = null;
  }, dur);
  sceneTimer = window.setTimeout(() => {
    old.remove();
    next.classList.remove("is-entering");
    next.removeAttribute("data-direction");
    [outAnim, inAnim].forEach((a) => {
      try {
        a.cancel();
      } catch (err) {
        /* ignore */
      }
    });
    /* Чистим только animation: inline-стили transform/opacity/filter
       не трогаем — commitStyles + их сброс вызывали микро-сдвиг плашки
       аудитории на пару пикселей примерно через секунду после смены дня. */
    next.style.animation = "";
    sceneTimer = null;
  }, total);
}

function renderStrip() {
  const strip = $("#strip");
  const nextArrow = $("#next-week");
  const ws = weekStart(state.selected);
  const today = startOfDay(currentDate());
  const selectedIndex = Math.max(
    0,
    Math.min(6, Math.round((state.selected - ws) / 86400000))
  );
  const existing = Array.from(strip.querySelectorAll("button[data-date-index]"));
  const sameWeek = existing.length === 7 && existing[0].dataset.date === iso(ws);

  if (!sameWeek) {
    existing.forEach((b) => b.remove());
    const frag = document.createDocumentFragment();
    for (let i = 0; i < 7; i += 1) {
      const d = addDays(ws, i);
      const btn = document.createElement("button");
      btn.type = "button";
      btn.dataset.dateIndex = String(i);
      btn.dataset.date = iso(d);
      if (i === selectedIndex) btn.classList.add("is-selected");
      if (sameDay(d, today)) btn.classList.add("is-today");
      if (isDayOff(d)) btn.classList.add("is-day-off");
      btn.innerHTML = `<span>${SHORT[i]}</span><strong>${d.getDate()}</strong>${dotsHtml(d)}`;
      frag.appendChild(btn);
    }
    strip.insertBefore(frag, nextArrow);
  } else {
    existing.forEach((btn, i) => {
      const d = addDays(ws, i);
      btn.classList.toggle("is-selected", i === selectedIndex);
      btn.classList.toggle("is-today", sameDay(d, today));
      btn.classList.toggle("is-day-off", isDayOff(d));
      const dotsEl = btn.querySelector(".date-lesson-dots");
      const lessons = slotsFor(d).filter((sl) => !sl.window && !sl.cancelled);
      const dotCount = Math.min(lessons.length, 6);
      if (dotsEl) {
        if (dotsEl.childElementCount !== dotCount) {
          dotsEl.innerHTML = "<i></i>".repeat(dotCount);
        }
      } else {
        btn.insertAdjacentHTML("beforeend", dotsHtml(d));
      }
    });
  }

  const prevIndex = Number(strip.dataset.selectedIndex);
  strip.dataset.selectedIndex = String(selectedIndex);
  if (
    sameWeek &&
    Number.isFinite(prevIndex) &&
    prevIndex !== selectedIndex &&
    !(scrub && scrub.active)
  ) {
    const sel = $("#selection");
    if (sel) {
      strip.classList.remove("is-hop");
      sel.classList.remove("is-hop");
      void sel.offsetWidth;
      strip.classList.add("is-hop");
      sel.classList.add("is-hop");
      window.clearTimeout(sel._hopTimer);
      sel._hopTimer = window.setTimeout(() => {
        strip.classList.remove("is-hop");
        sel.classList.remove("is-hop");
      }, 380);
    }
  }
  $("#today-btn").classList.toggle("is-visible", !sameDay(state.selected, today));
  const prev = $("#prev-week");
  if (prev) prev.disabled = weekStart(state.selected).getTime() <= weekStart(today).getTime();
}

function renderHeader() {
  const p = parityOf(state.selected);
  $("#week-number").textContent = String(academicWeek(state.selected));
  $("#week-parity").textContent = parityLabel(p);
  $("#week-badge").title = "чётность считается по номеру недели";
  $("#week-switch").classList.toggle("is-second", p === "even");
  $("#theme-hint").textContent = state.theme === "dark" ? "тёмная" : "светлая";
  const paletteHint = $("#palette-hint");
  if (paletteHint) paletteHint.textContent = PALETTE_LABEL[state.palette] || PALETTE_LABEL.default;
  $("#freshness").textContent = `группа ${groupName()}`;
}

function renderTab() {
  const scheduleView = $("#schedule-view");
  const auxView = $("#aux-view");
  const strip = $("#strip");

  if (state.tab === "bells") {
    scheduleView.style.display = "none";
    strip.style.display = "none";
    auxView.hidden = false;
    auxView.innerHTML = bellsHtml();
  } else {
    state.tab = "schedule";
    scheduleView.style.display = "";
    strip.style.display = "";
    auxView.hidden = true;
    auxView.innerHTML = "";
  }
  applyFlags();
}

function render(direction) {
  lastRenderAt = performance.now();
  // быстрые переключения больше не глушат анимацию: каждый день запускает каскад заново.
  // при перемещении рулетки сцену уже меняет selectDate, здесь не дублируем
  quietMotion = Boolean(scrub && scrub.active);
  renderHeader();
  renderStrip();
  renderTab();
  if (state.tab === "schedule") {
    setScene(dayHtml(state.selected, true) + futureDaysHtml(), quietMotion ? null : direction);
    liveKey = liveSignature();
  }
  quietMotion = false;
  save();
  window.requestAnimationFrame(checkCompactHeading);
}
if (typeof window !== "undefined") window.render = render;

function liveSignature() {
  const live = liveState(state.selected);
  const now = currentDate();
  let done = 0;
  if (sameDay(state.selected, startOfDay(now))) {
    const cur = nowMins(now);
    done = lessonsFor(state.selected).filter((s) => mins(s.to) <= cur).length;
  }
  if (!live) return `none:${done}`;
  return `${live.kind}:${live.slot ? live.slot.n : "-"}:${done}`;
}

function tick() {
  if (state.tab !== "schedule" || document.hidden) return;
  /* во время вождения рулетки не рендерим из тика — иначе кадр рвётся */
  if (scrub) return;
  const live = liveState(state.selected);
  // подпись считаем тем же способом, что и при рендере — иначе блок завершённых пар мигал каждую секунду
  const sig = liveSignature();
  if (sig !== liveKey) {
    liveKey = sig;
    render();
    return;
  }
  if (!live || live.kind === "done") return;
  const clock = $("#live-clock");
  const left = $("#live-left");
  const bar = $("#live-progress");
  if (clock && live.kind === "current") clock.textContent = clockText(live.now);
  if (left) {
    left.textContent =
      live.kind === "current" ? `осталось ${fmtLeft(live.left)}` : `через ${fmtLeft(live.left)}`;
  }
  const passed = $("#live-passed");
  if (passed && live.kind === "current") passed.textContent = `прошло ${fmtLeft(live.passed)}`;
  if (bar) bar.style.transform = `scaleX(${live.progress.toFixed(3)})`;
}

/* ---------- тема и палитра ---------- */

function applyTheme() {
  const root = document.documentElement;
  root.dataset.theme = state.theme;
  // Тёмные варианты neutral/opaque больше не переключают тему сами.
  // Для белого режима используем от��ельные светлые варианты этих же палитр.
  if (!PALETTES.includes(state.palette)) state.palette = "default";
  root.dataset.theme = state.theme;
  if (state.palette === "default") root.removeAttribute("data-weekly-palette");
  else root.dataset.weeklyPalette = state.palette;

  if (state.palette === "accent" || state.palette === "accent-plus") {
    root.style.setProperty("--weekly-accent", state.accent);
    const ink = accentInk(state.accent);
    root.style.setProperty("--weekly-on-accent", ink);
    const contrast = (hex) => {
      const a = accentLuminance(hex), b = accentLuminance(ink);
      return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
    };
    const stop = (base, amount) => {
      let color = mixHex(state.accent, base, amount);
      while (contrast(color) < 4.5 && amount < 1) {
        amount = Math.min(1, amount + 0.025);
        color = mixHex(state.accent, base, amount);
      }
      return color;
    };
    root.style.setProperty("--weekly-gradient-light", stop("#ffffff", 0.66));
    root.style.setProperty("--weekly-gradient-dark", stop("#000000", 0.66));
    root.style.setProperty(
      "--weekly-accent-readable",
      readableAccent(state.accent, state.theme),
    );
  } else {
    root.style.removeProperty("--weekly-accent");
    root.style.removeProperty("--weekly-on-accent");
    root.style.removeProperty("--weekly-gradient-light");
    root.style.removeProperty("--weekly-gradient-dark");
    root.style.removeProperty("--weekly-accent-readable");
  }

  $("#dark-switch").setAttribute("aria-pressed", state.theme === "dark" ? "true" : "false");
  const darkRow = $("#dark-switch");
  if (darkRow) darkRow.disabled = false;
  const modes = $("#theme-modes");
  if (modes) {
    modes.querySelectorAll("button[data-mode]").forEach((btn) => {
      const on = btn.dataset.mode === state.palette;
      btn.classList.toggle("is-active", on);
      btn.setAttribute("aria-pressed", on ? "true" : "false");
    });
  }
  const accentRow = $("#accent-row");
  if (accentRow) accentRow.hidden = state.palette !== "accent" && state.palette !== "accent-plus";
  const accentInput = $("#accent-color");
  if (accentInput && accentInput.value.toLowerCase() !== state.accent.toLowerCase()) {
    accentInput.value = state.accent;
  }
  const accentHint = $("#accent-hint");
  if (accentHint) accentHint.textContent = state.accent.toUpperCase();

  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) {
    const colors = PALETTE_COLORS[state.palette] || PALETTE_COLORS.default;
    let tint = state.theme === "light" ? colors.light : colors.dark;
    /* Акцентная тема красит и сам фон — строка статуса должна совпадать. */
    if (state.palette === "accent" || state.palette === "accent-plus") {
      tint =
        state.theme === "light"
          ? mixHex(state.accent, "#ffffff", 0.2)
          : mixHex(state.accent, "#05050a", 0.18);
    }
    meta.setAttribute("content", tint);
  }
  applyFlags();
}

/* ---------- состояние ---------- */

function save() {
  try {
    localStorage.setItem(
      KEY,
      JSON.stringify({
        theme: state.theme,
        themeManual: state.themeManual,
        perfMode: state.perfMode,
        palette: state.palette,
        accent: state.accent,
        windows: state.windows,
        tab: state.tab,
        light: state.light,
        scope: state.scope,
        group: state.group,
        onboarded: state.onboarded,
      })
    );
  } catch (e) {
    /* приватный режим */
  }
}

function load() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return;
    const data = JSON.parse(raw);
    if (data.theme === "dark" || data.theme === "light") state.theme = data.theme;
    /* Старые сохранения без флага — тема уже была выбрана вручную, не трогаем. */
    if (typeof data.themeManual === "boolean") state.themeManual = data.themeManual;
    else if (data.theme === "dark" || data.theme === "light") state.themeManual = true;
    if (typeof data.perfMode === "boolean") state.perfMode = data.perfMode;
    if (PALETTES.includes(data.palette)) state.palette = data.palette;
    if (typeof data.accent === "string" && /^#[0-9a-f]{6}$/i.test(data.accent)) {
      state.accent = data.accent;
    }
    if (typeof data.windows === "boolean") state.windows = data.windows;
    if (["schedule", "bells"].includes(data.tab)) state.tab = data.tab;
    if (typeof data.light === "boolean") state.light = data.light;
    if (data.scope === "day" || data.scope === "week") state.scope = data.scope;
    /* Не проверяем GROUPS: на старте там только зашитая группа, остальные
       подъедут из data/schedule.json позже. Если группы в итоге нет —
       applySchedulePayload сам откатит на группу по умолчанию. */
    if (typeof data.group === "string") {
      state.group = data.group;
      state.draftGroup = data.group;
    }
    if (typeof data.onboarded === "boolean") state.onboarded = data.onboarded;
  } catch (e) {
    /* повреждённые данные */
  }
}

/* ---------- настройки ---------- */

function openSettings() {
  state.settingsOpen = true;
  $("#settings").classList.add("is-open");
  $("#app").classList.add("is-settings-open");
  const pop = $("#settings-popover");
  pop.classList.remove("is-closing");
  pop.classList.add("is-open");
  $("#settings-trigger").setAttribute("aria-expanded", "true");
}

function closeSettings() {
  if (!state.settingsOpen) return;
  state.settingsOpen = false;
  const pop = $("#settings-popover");
  pop.classList.remove("is-open");
  pop.classList.add("is-closing");
  $("#settings").classList.remove("is-open");
  $("#app").classList.remove("is-settings-open");
  $("#settings-trigger").setAttribute("aria-expanded", "false");
  window.setTimeout(() => pop.classList.remove("is-closing"), 220);
}

/* ---------- действия ---------- */

function selectDate(d, direction, options) {
  const next = clampDate(d);
  if (sameDay(next, state.selected)) {
    renderStrip();
    return;
  }
  if (options && options.silent) {
    const scrubDir = next > state.selected ? "forward" : "backward";
    state.selected = next;
    renderHeader();
    if (state.tab === "schedule") {
      if (options.preview) {
        /* Во время вождения по рулетке сцена следует за пилюлей сразу,
           но дёшево: без анимации смены и без блока «следующих дней» —
           их дорисует полный рендер при отпускании. */
        scrubPendingRender = false;
        quietMotion = true;
        setScene(
          dayHtml(state.selected, true) + futureDaysHtml(),
          options.animated ? scrubDir : null
        );
        quietMotion = false;
        liveKey = liveSignature();
      } else {
        setScene(dayHtml(state.selected, true) + futureDaysHtml(), scrubDir);
        liveKey = liveSignature();
      }
    }
    const strip = $("#strip");
    const key = iso(state.selected);
    strip.querySelectorAll("button[data-date-index]").forEach((btn) => {
      btn.classList.toggle("is-selected", btn.dataset.date === key);
    });
    strip.dataset.selectedIndex = String(
      Math.round((state.selected - weekStart(state.selected)) / 86400000)
    );
    const todayButton = $("#today-btn");
    if (todayButton) {
      todayButton.classList.toggle(
        "is-visible",
        !sameDay(state.selected, startOfDay(currentDate()))
      );
    }
    window.requestAnimationFrame(checkCompactHeading);
    return;
  }
  const dir =
    direction || (next > state.selected ? "forward" : next < state.selected ? "backward" : null);
  const weekChanged = weekStart(next).getTime() !== weekStart(state.selected).getTime();
  state.selected = next;
  /* Внешнее переключение даты (стрелки недель, «сегодня», колесо) во время
     доводки тапа: доводку завершаем, чтобы пилюля не уезжала к старому дню. */
  if (scrub && scrub.tapGlide) {
    const glideTarget = addDays(scrub.week, scrub.targetIndex);
    if (!sameDay(glideTarget, next)) endScrub({ skipRender: true });
  }
  if (weekChanged) {
    const sel = $("#selection");
    sel.classList.add("is-week-reset");
    render(dir);
    void sel.offsetWidth;
    window.setTimeout(() => $("#selection").classList.remove("is-week-reset"), 40);
  } else {
    render(dir);
  }
}

function shiftDay(delta) {
  selectDate(addDays(state.selected, delta), delta > 0 ? "forward" : "backward");
}

/* ---------- зажать и вести выделение по дням ---------- */

let scrub = null;
let scrubFrame = null;
let holdTimer = null;
/* Флаг вместо таймера: глушится только клик от самого перетаскивания,
   а не всё, что попадёт в окно 400 мс после него. */
let dragClick = false;

function springStep(position, velocity, target, dt, stiffness, damping) {
  let pos = position;
  let vel = velocity;
  let rest = Math.min(0.05, Math.max(0.001, dt));
  while (rest > 0.0001) {
    const step = Math.min(1 / 120, rest);
    const accel = (target - pos) * stiffness - vel * damping;
    vel += accel * step;
    pos += vel * step;
    rest -= step;
  }
  return { position: pos, velocity: vel };
}

function dayButtons() {
  return Array.from($("#strip").querySelectorAll("button[data-date-index]"));
}

function paintScrub() {
  if (!scrub || !scrub.selection) return;
  scrub.selection.style.transform = `translate3d(${scrub.position.toFixed(2)}px, 0, 0)`;
  const under = Math.max(0, Math.min(6, Math.round(scrub.position / scrub.step)));
  if (under !== scrub.underIndex) {
    scrub.buttons[scrub.underIndex]?.removeAttribute("data-under-selection");
    scrub.buttons[under]?.setAttribute("data-under-selection", "true");
    scrub.underIndex = under;
  }
}

function scrubFrameStep(now) {
  scrubFrame = null;
  if (!scrub) return;

  if (!scrub.pointerDown) {
    /* Плавное выравнивание на день после отпускания пальца */
    const elapsed = Math.max(0, now - (scrub.settleStartTime || now));
    const duration = scrub.settleDuration || 260;
    const progress = Math.min(1, elapsed / duration);
    /* Мягкая прогрессивная кривая (smooth ease-out), обеспечивающая шелковистую доводку */
    const ease = scrub.reducedMotion ? 1 : 1 - Math.pow(1 - progress, 2.8);
    scrub.position = scrub.settleStartPos + (scrub.target - scrub.settleStartPos) * ease;
    scrub.position = Math.max(0, Math.min(scrub.max, scrub.position));
    paintScrub();

    if (progress >= 1 || scrub.position === scrub.target) {
      scrub.position = scrub.target;
      paintScrub();
      /* Доводка после тапа: пилюля уже стоит ровно на новом дне, поэтому
         инлайн-трансформ снимается в этом же кадре без видимого скачка,
         а опускание идёт по сценарию отпускания вождения. Рендер не нужен —
         selectDate уже отработал в момент отпускания. */
      if (scrub.tapGlide) endScrub({ skipRender: true });
      else endScrub();
      return;
    }
    startScrubLoop();
    return;
  }

  /* Палец нажат */
  if (scrub.isDragging) {
    /* Интерактивное ведение: плотно следует за пальцем без задержки */
    const dt = Math.max(0.001, (now - (scrub.lastFrame || now - 16.7)) / 1000);
    scrub.lastFrame = now;
    const alpha = scrub.reducedMotion ? 1 : 1 - Math.exp(-52 * dt);
    scrub.position += (scrub.target - scrub.position) * alpha;
    scrub.position = Math.max(0, Math.min(scrub.max, scrub.position));
  } else {
    /* Тап без движения: плавный переезд выделения к нажатому дню */
    const elapsed = Math.max(0, now - (scrub.tapStartTime || now));
    const duration = scrub.tapDuration || 260;
    const progress = Math.min(1, elapsed / duration);
    const ease = scrub.reducedMotion ? 1 : 1 - Math.pow(1 - progress, 2.8);
    scrub.position = scrub.tapStartPos + (scrub.target - scrub.tapStartPos) * ease;
    scrub.position = Math.max(0, Math.min(scrub.max, scrub.position));
  }
  paintScrub();

  /* Во время перетаскивания: смена сцены с полноценной анимацией пар */
  if (scrub.isDragging && scrub.renderedIndex !== scrub.targetIndex) {
    scrub.renderedIndex = scrub.targetIndex;
    selectDate(addDays(scrub.week, scrub.targetIndex), null, {
      silent: true, preview: true, animated: previewAnimated(),
    });
  }

  if (scrub.position !== scrub.target || scrub.isDragging) startScrubLoop();
}

function startScrubLoop() {
  if (scrubFrame === null) scrubFrame = window.requestAnimationFrame(scrubFrameStep);
}

function moveScrub(clientX) {
  if (!scrub) return;
  scrub.target = Math.max(0, Math.min(scrub.max, clientX - scrub.firstCenter - scrub.grabOffset));
  scrub.targetIndex = Math.max(0, Math.min(6, Math.round(scrub.target / scrub.step)));
  startScrubLoop();
}

function endScrub(options = {}) {
  const keepVisual = Boolean(options.keepVisual);
  const skipRender = Boolean(options.skipRender);
  /* Работает и без активного scrub: используется как полный сброс состояния,
     чтобы после резкого отпускания не оставались инлайн-трансформ и блюр. */
  const stripEl = (scrub && scrub.strip) || $("#strip");
  if (!stripEl) return;
  const wasActive = Boolean(scrub && (scrub.active || scrub.targetIndex !== undefined));
  const wasDragging = Boolean(scrub && scrub.isDragging);
  const wasTapGlide = Boolean(scrub && scrub.tapGlide);
  const finalTargetIndex = scrub ? scrub.targetIndex : undefined;
  const scrubWeek = scrub ? scrub.week : undefined;
  const selection = $("#selection");

  dayButtons().forEach((btn) => btn.removeAttribute("data-under-selection"));
  window.clearTimeout(stripEl._releaseTimer);
  if (selection) window.clearTimeout(selection._hopTimer);
  stripEl.classList.remove("is-pressing", "is-scrubbing", "is-motion-lite", "is-releasing");
  stripEl.classList.remove("is-settling");
  if (wasActive && (wasDragging || wasTapGlide) && !keepVisual) {
    // Оставляем полный прямоугольник хотя бы на один кадр, затем переводим
    // в фазу отпускания, где он задерживается на выбранном дне и плавно опускается.
    stripEl.classList.add("is-settling");
    window.requestAnimationFrame(() => {
      /* Если пользователь уже начал новый жест, дожимать старую анимацию нельзя. */
      if (scrub) return;
      stripEl.classList.remove("is-settling");
      stripEl.classList.add("is-releasing");
      stripEl._releaseTimer = window.setTimeout(() => {
        stripEl.classList.remove("is-releasing");
      }, 420);
    });
  }
  const scene = $("#scene");
  if (scene) {
    scene.classList.remove("is-date-scrubbing", "is-date-settling", "is-motion-lite");
    scene.style.removeProperty("--scrub-scene-blur");
    scene.style.removeProperty("--scrub-scene-scale");
    scene.style.removeProperty("--scrub-scene-opacity");
    scene.style.removeProperty("--scrub-scene-x");
  }
  if (stripEl) {
    stripEl.dataset.selectedIndex = String(
      Math.round((state.selected - weekStart(state.selected)) / 86400000)
    );
  }
  if (selection && !keepVisual) {
    selection.classList.add("is-week-reset");
    selection.style.removeProperty("transform");
    window.requestAnimationFrame(() => {
      if (!scrub) selection.classList.remove("is-week-reset");
    });
  }
  scrub = null;
  $("#stage")?.style.removeProperty("min-height");
  if (holdTimer !== null) {
    window.clearTimeout(holdTimer);
    holdTimer = null;
  }
  if (scrubFrame !== null) {
    window.cancelAnimationFrame(scrubFrame);
    scrubFrame = null;
  }
  if (keepVisual || skipRender) {
    scrubPendingRender = false;
    save();
    return;
  }
  if (wasDragging && finalTargetIndex !== undefined && scrubWeek) {
    const finalDate = addDays(scrubWeek, finalTargetIndex);
    if (!sameDay(finalDate, state.selected)) {
      selectDate(finalDate);
    } else {
      render();
    }
  } else {
    renderStrip();
  }
  save();
}

function settleScrub() {
  if (holdTimer !== null) {
    window.clearTimeout(holdTimer);
    holdTimer = null;
  }
  if (!scrub) return;
  scrub.pointerDown = false;
  scrub.target = scrub.targetIndex * scrub.step;
  scrub.settleStartPos = scrub.position;
  scrub.settleStartTime = performance.now();
  const dist = Math.abs(scrub.target - scrub.settleStartPos);
  /* Плавное выравнивание на день: длительность пропорциональна оставшемуся расстоянию,
     от 220 мс при микродовороте до 320 мс при смене дня */
  scrub.settleDuration = scrub.reducedMotion ? 1 : Math.max(220, Math.min(320, 180 + dist * 2.5));
  scrub.velocity = 0;
  scrub.strip.classList.remove("is-scrubbing", "is-pressing");
  scrub.strip.classList.add("is-settling");
  const scene = $("#scene");
  if (scene) {
    scene.classList.remove("is-date-scrubbing");
    scene.classList.add("is-date-settling");
  }
  dragClick = true;
  startScrubLoop();
}

function bindStrip() {
  const strip = $("#strip");

  strip.addEventListener("pointerdown", (e) => {
    if (!e.isPrimary || (e.pointerType === "mouse" && e.button !== 0)) return;
    const btn = e.target.closest("button[data-date-index]");
    if (!btn) return;
    /* Предыдущий жест мог не успеть доиграть (резко отпустили и сразу нажали
       другой день) — завершаем его, чтобы квадратик и блюр не залипали. */
    if (scrub || scrubFrame !== null) endScrub({ keepVisual: true, skipRender: true });
    dragClick = false;
    const index = Number(btn.dataset.dateIndex);
    const selectedIndex = Number(strip.dataset.selectedIndex);
    const buttons = dayButtons();
    const first = buttons[0];
    const second = buttons[1];
    const last = buttons[6];
    if (!first || !second || !last) return;

    /* Захватываем указатель синхронно в pointerdown. В iOS WebKit вызов
       setPointerCapture из setTimeout всегда отклоняется (InvalidStateError),
       из-за чего Safari задерживает touchmove на 300–400 мс для распознавания жестов.
       Синхронный захват исключает эту задержку и передаёт перемещения мгновенно. */
    try {
      strip.setPointerCapture(e.pointerId);
    } catch (err) {
      /* ignore */
    }

    const firstRect = first.getBoundingClientRect();
    const secondRect = second.getBoundingClientRect();
    const lastRect = last.getBoundingClientRect();
    const step = secondRect.left - firstRect.left;
    const selection = $("#selection");
    const matrix = new DOMMatrixReadOnly(getComputedStyle(selection).transform);
    const position = Number.isFinite(matrix.m41) ? matrix.m41 : selectedIndex * step;
    const pressedPosition = index * step;

    window.clearTimeout(strip._releaseTimer);
    strip.classList.remove("is-releasing", "is-hop");
    selection.classList.remove("is-hop");
    window.clearTimeout(selection._hopTimer);
    strip.classList.add("is-pressing");

    /* Резервируем высоту один раз: браузер не сдвигает страницу при замене дней. */
    const stage = $("#stage");
    if (stage) stage.style.minHeight = `${stage.offsetHeight}px`;

    dragClick = false;

    const tapDist = Math.abs(pressedPosition - position);
    const reducedMotion = motionQuery.matches || Boolean(state.perfMode);

    scrub = {
      pointerId: e.pointerId,
      pointerType: e.pointerType,
      pointerDown: true,
      active: true,
      isDragging: false,
      strip,
      startX: e.clientX,
      startY: e.clientY,
      pointerX: e.clientX,
      lastPointerX: e.clientX,
      lastPointerTime: performance.now(),
      pointerVelocity: 0,
      position,
      target: pressedPosition,
      tapStartPos: position,
      tapStartTime: performance.now(),
      tapDuration: reducedMotion ? 1 : Math.max(220, Math.min(320, 180 + tapDist * 2.5)),
      velocity: 0,
      step,
      max: lastRect.left - firstRect.left,
      firstCenter: firstRect.left + firstRect.width / 2,
      /* Курсор цепляет любую нажатую ячейку а не только текущую. */
      grabOffset: e.clientX - (firstRect.left + firstRect.width / 2 + pressedPosition),
      /* Запоминаем именно нажатый день: к нему плавно едет выделение,
         и на нём же фиксируется выбор при резком отпускании без движения. */
      targetIndex: index,
      renderedIndex: selectedIndex,
      underIndex: selectedIndex,
      /* Тап-режим: после отпускания пилюля доводится до нажатого дня,
         а не телепортируется на него сбросом трансформа. */
      tapGlide: false,
      week: weekStart(state.selected),
      selection,
      buttons,
      reducedMotion,
      lastFrame: 0,
      frameInterval: 1000 / 60,
      slowFrameCount: 0,
      fastFrameCount: 0,
      lowFrameRate: false,
    };

    holdTimer = window.setTimeout(() => {
      if (scrub && scrub.pointerDown && !scrub.isDragging) {
        scrub.isDragging = true;
        strip.classList.add("is-scrubbing");
        const scene = $("#scene");
        if (scene) {
          scene.classList.remove("is-date-settling");
          scene.classList.add("is-date-scrubbing");
        }
        if (scrub.renderedIndex !== scrub.targetIndex) {
          scrub.renderedIndex = scrub.targetIndex;
          selectDate(addDays(scrub.week, scrub.targetIndex), null, {
            silent: true, preview: true, animated: previewAnimated(),
          });
        }
      }
    }, 180);

    startScrubLoop();
  });

  strip.addEventListener("pointermove", (e) => {
    if (!scrub || scrub.pointerId !== e.pointerId || !scrub.pointerDown) return;
    scrub.pointerX = e.clientX;
    const dx = e.clientX - scrub.startX;
    if (!scrub.isDragging && Math.abs(dx) > 3) {
      if (holdTimer !== null) {
        window.clearTimeout(holdTimer);
        holdTimer = null;
      }
      scrub.isDragging = true;
      strip.classList.add("is-scrubbing");
      const scene = $("#scene");
      if (scene) {
        scene.classList.remove("is-date-settling");
        scene.classList.add("is-date-scrubbing");
      }
    }
    if (scrub.isDragging) {
      e.preventDefault();
      const now = performance.now();
      const dtPointer = Math.max(8, now - (scrub.lastPointerTime || now)) / 1000;
      const vel = (e.clientX - (scrub.lastPointerX ?? e.clientX)) / dtPointer;
      scrub.pointerVelocity = (scrub.pointerVelocity || 0) * 0.48 + vel * 0.52;
      scrub.lastPointerX = e.clientX;
      scrub.lastPointerTime = now;
      moveScrub(e.clientX);
    }
  });

  strip.addEventListener("touchmove", (e) => {
    if (scrub?.active && scrub.pointerDown && e.cancelable) e.preventDefault();
  }, { passive: false });

  const release = (e) => {
    if (!scrub || scrub.pointerId !== e.pointerId) return;
    if (holdTimer !== null) {
      window.clearTimeout(holdTimer);
      holdTimer = null;
    }
    if (strip.hasPointerCapture(e.pointerId)) {
      try {
        strip.releasePointerCapture(e.pointerId);
      } catch (err) {
        /* ignore */
      }
    }
    if (!scrub.isDragging) {
      /* Тап по дню: пилюля не телепортируется, а плавно доезжает до нажатого
         дня той же доводкой, что после вождения. Сцена при этом переключается
         сразу, каскадной анимацией. Инлайн-трансформ снимается только по
         прибытии, когда он совпадает с CSS-позицией нового дня, — скачка нет.
         Быстрые повторные тапы перехватывают доводку на лету: pointerdown
         завершает прежний жест с keepVisual и стартует от текущей позиции. */
      const targetIdx = scrub.targetIndex;
      const targetDate = addDays(scrub.week, targetIdx);
      const currentIdx = Number(strip.dataset.selectedIndex);
      const dir = targetIdx > currentIdx ? "forward" : targetIdx < currentIdx ? "backward" : null;
      dragClick = true;
      if (scrub.reducedMotion) {
        endScrub();
        if (!sameDay(targetDate, state.selected)) selectDate(targetDate, dir);
        return;
      }
      scrub.tapGlide = true;
      scrub.pointerDown = false;
      scrub.target = targetIdx * scrub.step;
      scrub.settleStartPos = scrub.position;
      scrub.settleStartTime = performance.now();
      const glideDist = Math.abs(scrub.target - scrub.settleStartPos);
      /* Та же формула, что в settleScrub: 220–320 мс в зависимости от остатка пути. */
      scrub.settleDuration = Math.max(220, Math.min(320, 180 + glideDist * 2.5));
      scrub.velocity = 0;
      strip.classList.remove("is-pressing");
      strip.classList.add("is-settling");
      if (!sameDay(targetDate, state.selected)) {
        selectDate(targetDate, dir);
      }
      startScrubLoop();
      return;
    }
    settleScrub();
  };

  strip.addEventListener("pointerup", release);
  strip.addEventListener("pointercancel", () => {
    /* Если браузер отобрал жест посреди ведения — доводим выбор до конца,
       а не сбрасываем его назад. */
    if (scrub && scrub.active) settleScrub();
    else endScrub();
  });
  strip.addEventListener("lostpointercapture", (e) => {
    if (scrub && scrub.pointerId === e.pointerId && scrub.pointerDown) {
      if (scrub.active) settleScrub();
      else endScrub();
    }
  });
  /* Отпустили курсор вне полосы или ушли из окна — состояние всё равно чистим / доводим. */
  window.addEventListener("pointerup", (e) => {
    if (scrub && scrub.pointerId === e.pointerId) {
      if (scrub.active) release(e);
      else endScrub();
    }
  });
  window.addEventListener("blur", () => {
    if (scrub || scrubFrame !== null) endScrub();
  });

  strip.addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-date-index]");
    if (!btn) return;
    /* Глушим только клик того же жеста, что был перетаскиванием. */
    if (dragClick) {
      dragClick = false;
      return;
    }
    const [y, m, d] = btn.dataset.date.split("-").map(Number);
    selectDate(new Date(y, m - 1, d));
  });

  /* колесо мыши: шаг без задержки и без очереди — анимация перехватывается на лету */
  const WHEEL_STEP = 24;
  let wheelAcc = 0;
  let wheelFrame = null;
  let wheelDirection = 0;
  strip.addEventListener(
    "wheel",
    (e) => {
      e.preventDefault();
      if (scrub && scrub.active) return;
      const raw = Math.abs(e.deltaY) >= Math.abs(e.deltaX) ? e.deltaY : e.deltaX;
      const scale = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? window.innerHeight : 1;
      wheelAcc += raw * scale;
      if (Math.abs(wheelAcc) < WHEEL_STEP) return;
      const steps = Math.trunc(wheelAcc / WHEEL_STEP);
      wheelAcc -= steps * WHEEL_STEP;
      wheelDirection = steps > 0 ? 1 : -1;
      if (wheelFrame === null) wheelFrame = window.requestAnimationFrame(() => {
        wheelFrame = null;
        if (!scrub) shiftDay(wheelDirection);
      });
    },
    { passive: false }
  );
}

function bindEvents() {
  bindStrip();

  const arrow = (el, delta) => {
    el.addEventListener("click", () => {
      el.classList.add("is-triggered");
      window.setTimeout(() => el.classList.remove("is-triggered"), 260);
      selectDate(addDays(state.selected, delta), delta > 0 ? "forward" : "backward");
    });
  };
  arrow($("#prev-week"), -7);
  arrow($("#next-week"), 7);

  $("#today-btn").addEventListener("click", () => selectDate(defaultSelectedDate()));

  /* завершённые пары: раскрытие с плавной анимацией высоты и проявления */
  $("#scene").addEventListener("click", (e) => {
    const head = e.target.closest('[data-act="toggle-completed"]');
    if (!head) return;
    const acc = head.closest(".t-acc");
    if (!acc) return;
    completedOpen = acc.dataset.open !== "true";
    const flag = completedOpen ? "true" : "false";
    document.querySelectorAll(".completed-lessons.t-acc").forEach((item) => {
      item.dataset.open = flag;
      const h = item.querySelector('[data-act="toggle-completed"]');
      if (h) h.setAttribute("aria-expanded", flag);
      const p = item.querySelector(".t-acc-panel");
      if (p) p.setAttribute("aria-hidden", completedOpen ? "false" : "true");
    });
  });

  $("#dark-switch").addEventListener("click", () => {
    state.theme = state.theme === "dark" ? "light" : "dark";
    state.themeManual = true; /* ручной выбор — больше не следуем системе */
    applyTheme();
    renderHeader();
    save();
  });

  const perfSwitch = $("#perf-switch");
  if (perfSwitch)
    perfSwitch.addEventListener("click", () => {
      state.perfMode = !state.perfMode;
      applyPerfMode();
      save();
      toast(state.perfMode ? "режим производительности включён" : "режим производительности выключен");
    });

  const modes = $("#theme-modes");
  if (modes) {
    modes.addEventListener("click", (e) => {
      const btn = e.target.closest("button[data-mode]");
      if (!btn) return;
      const mode = btn.dataset.mode;
      if (!PALETTES.includes(mode) || mode === state.palette) return;
      state.palette = mode;
      applyTheme();
      renderHeader();
      save();
    });
  }

  const accentInput = $("#accent-color");
  if (accentInput) {
    const onAccent = (e) => {
      const value = e.target.value;
      if (!/^#[0-9a-f]{6}$/i.test(value)) return;
      state.accent = value;
      if (state.palette !== "accent") state.palette = "accent";
      applyTheme();
      renderHeader();
      save();
    };
    accentInput.addEventListener("input", onAccent);
    accentInput.addEventListener("change", onAccent);
  }

  $("#windows-switch").addEventListener("click", () => {
    state.windows = !state.windows;
    $("#windows-switch").setAttribute("aria-pressed", state.windows ? "true" : "false");
    save();
    render();
  });

  $("#settings-trigger").addEventListener("click", (e) => {
    e.stopPropagation();
    if (state.settingsOpen) closeSettings();
    else openSettings();
  });

  $("#go-bells").addEventListener("click", () => {
    closeSettings();
    state.tab = "bells";
    render();
  });

  document.addEventListener("click", (e) => {
    if (!state.settingsOpen) return;
    if (state.profileOpen) return;
    if (
      e.target.closest("#settings") ||
      e.target.closest("#profile-backdrop") ||
      e.target.closest(".weekly-replace-backdrop")
    )
      return;
    closeSettings();
  });

  document.addEventListener("click", (e) => {
    const row = e.target.closest(".weekly-settings-row");
    if (!row || e.target.closest("button, a, input, select, label")) return;
    const sw = row.querySelector(".weekly-setting-switch");
    if (sw) {
      sw.click();
      return;
    }
    const colorInput = row.querySelector(".weekly-accent-input");
    if (colorInput) {
      colorInput.click();
    }
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      const rep = document.getElementById("report-backdrop");
      if (rep) {
        closeReportSheet();
        return;
      }
      const reps = document.getElementById("reports-backdrop");
      if (reps) {
        closeReportsSheet();
        return;
      }
      const tg = document.getElementById("tg-backdrop");
      if (tg) {
        closeTgSheet();
        return;
      }
      if (state.profileOpen) {
        closeProfile();
        openSettings();
      } else {
        closeSettings();
      }
      return;
    }
    if (state.tab !== "schedule" || state.profileOpen || state.settingsOpen ||
        e.target.closest("input, textarea, select, [contenteditable=true], [role=dialog]")) return;
    if (e.key === "ArrowRight") shiftDay(1);
    if (e.key === "ArrowLeft") shiftDay(-1);
  });

  /* Свайп по дням: палец тянет сцену за собой, а день меняется уже на
     отпускании — с обычной анимацией листания. Раньше день переключался
     прямо посреди жеста, и анимацию съедал активный скролл. */
  const scene = $("#scene");
  const swipeStage = $("#stage");
  let swipe = null;

  const setSwipeShift = (value) => {
    if (!swipeStage) return;
    swipeStage.style.setProperty("--swipe-x", `${value.toFixed(2)}px`);
  };

  const clearSwipe = (animated) => {
    if (!swipeStage) return;
    scene.classList.remove("is-swiping");
    if (animated) {
      scene.classList.add("is-swipe-return");
      swipeStage.style.setProperty("--swipe-x", "0px");
      window.setTimeout(() => {
        scene.classList.remove("is-swipe-return");
        swipeStage.style.removeProperty("--swipe-x");
      }, 220);
      return;
    }
    scene.classList.remove("is-swipe-return");
    swipeStage.style.removeProperty("--swipe-x");
  };

  scene.addEventListener(
    "touchstart",
    (e) => {
      if (e.touches.length !== 1) {
        swipe = null;
        return;
      }
      const t = e.touches[0];
      const target = t.target;
      if (
        target &&
        target.closest &&
        target.closest("#strip, button, a, input, textarea, select, .weekly-replace-sheet")
      ) {
        swipe = null;
        return;
      }
      swipe = { x: t.clientX, y: t.clientY, dx: 0, axis: null };
    },
    { passive: true }
  );

  scene.addEventListener(
    "touchmove",
    (e) => {
      if (!swipe || e.touches.length !== 1) return;
      const t = e.touches[0];
      const dx = t.clientX - swipe.x;
      const dy = t.clientY - swipe.y;
      if (!swipe.axis) {
        if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return;
        swipe.axis = Math.abs(dx) > Math.abs(dy) ? "x" : "y";
        if (swipe.axis === "x") {
          scene.classList.remove("is-swipe-return");
          scene.classList.add("is-swiping");
        }
      }
      if (swipe.axis !== "x") return;
      swipe.dx = dx;
      /* резинка: сцена идёт мягче пальца и не улетает за край */
      const eased = Math.sign(dx) * Math.min(Math.abs(dx) * 0.42, 52);
      setSwipeShift(eased);
    },
    { passive: true }
  );

  const endSwipe = (commit) => {
    if (!swipe) return;
    const dx = swipe.dx;
    const axis = swipe.axis;
    swipe = null;
    if (axis !== "x") {
      clearSwipe(false);
      return;
    }
    if (commit && Math.abs(dx) >= 40) {
      clearSwipe(false);
      shiftDay(dx < 0 ? 1 : -1);
      return;
    }
    clearSwipe(true);
  };

  scene.addEventListener("touchend", () => endSwipe(true), { passive: true });
  scene.addEventListener("touchcancel", () => endSwipe(false), { passive: true });

  /* На iOS Safari innerHeight меняется при скролле (прячется/показывается тулбар) —
     если пересчитывать высоту на каждый resize, вся раскладка «подпрыгивает».
     Пересчитываем только при реальной смен�� ширины (поворот, сплит-вью). */
  let lastViewportWidth = window.innerWidth;
  const vh = (force) => {
    if (!force && window.innerWidth === lastViewportWidth) return;
    lastViewportWidth = window.innerWidth;
    document.documentElement.style.setProperty("--weekly-viewport-height", `${window.innerHeight}px`);
  };
  window.addEventListener("resize", () => {
    vh(false);
    checkCompactHeading();
  });
  window.addEventListener("orientationchange", () => {
    vh(true);
    checkCompactHeading();
  });
  vh(true);
  checkCompactHeading();
}

/* ---------- старт ---------- */

function applyQuery() {
  const q = new URLSearchParams(location.search);
  const day = q.get("day");
  if (day) {
    if (/^\d{4}-\d{2}-\d{2}$/.test(day)) {
      const [y, m, d] = day.split("-").map(Number);
      state.selected = startOfDay(new Date(y, m - 1, d));
    } else if (/^[0-6]$/.test(day)) {
      const target = Number(day);
      const ws = weekStart(state.selected);
      state.selected = addDays(ws, target === 0 ? 6 : target - 1);
    }
  }
  const group = q.get("group");
  if (group && GROUPS.some((g) => g.id === group)) {
    state.group = group;
    state.draftGroup = group;
  }
  const theme = q.get("theme");
  if (theme === "dark" || theme === "light") state.theme = theme;
  const palette = q.get("palette");
  if (PALETTES.includes(palette)) state.palette = palette;
  const tab = q.get("tab");
  if (["schedule", "bells"].includes(tab)) state.tab = tab;
  if (q.get("light") === "1") state.light = true;
  if (["day", "week"].includes(q.get("scope"))) state.scope = q.get("scope");
  if (["0", "1"].includes(q.get("windows"))) state.windows = q.get("windows") === "1";
  if (/^#[0-9a-f]{6}$/i.test(q.get("accent") || "")) state.accent = q.get("accent");
  if (q.get("onboarding") === "1") state.onboarded = false;
  if (q.get("ostep") === "1") state.onboardingStep = 1;
  if (q.get("onboarding") === "0") state.onboarded = true;
  if (q.get("profile") === "1") state.profileOpen = true;
  const now = q.get("now");
  if (now && /^\d{1,2}:\d{2}$/.test(now)) state.nowOverride = mins(now);
  if (q.get("settings") === "1") state.settingsOpen = true;
}

/* ---------- оформление: флаги ---------- */

function applyFlags() {
  const root = document.documentElement;
  if (state.light) root.dataset.weeklyScheduleView = "light";
  else root.removeAttribute("data-weekly-schedule-view");
  const ls = $("#light-switch");
  if (ls) ls.setAttribute("aria-pressed", state.light ? "true" : "false");
  const ss = $("#scope-switch");
  if (ss) ss.setAttribute("aria-pressed", state.scope === "week" ? "true" : "false");
  const li = $("#light-hint");
  if (li) li.textContent = state.light ? "плоские и компактные пары" : "обычные карточки";
  const sh = $("#scope-hint");
  if (sh) sh.textContent = state.scope === "week" ? "следующие дни ниже" : "только выбранный день";
  const ph = $("#profile-hint");
  if (ph) ph.textContent = `группа ${groupName()} · без входа`;
}

/* ---------- даты в полосе ---------- */

function dotsHtml(d) {
  const lessons = slotsFor(d).filter((sl) => !sl.window && !sl.cancelled);
  const count = Math.min(lessons.length, 6);
  return `<span class="date-lesson-dots" aria-hidden="true">${"<i></i>".repeat(count)}</span>`;
}

function futureDaysHtml() {
  if (state.scope !== "week") return "";
  const ws = weekStart(state.selected);
  const days = [];
  for (let i = 0; i < 6; i += 1) {
    const d = addDays(ws, i);
    if (d <= state.selected) continue;
    days.push(d);
  }
  /* На субботе неделя заканчивается — показываем понедельник следующей. */
  if (!days.length) days.push(addDays(ws, 7));
  /* На телефоне раньше ближайший день рендерили сразу, а остальные — лениво
     через IntersectionObserver. Заполнение плейсхолдера реальной вёрсткой
     давало скачок высоты (мин-height считался по числу пар, а реальная
     высота отличается из-за заголовка/перерывов/live-карточки). Поэтому
     рендерим все будущие дни сразу — список короткий, скачка нет. */
  const lazy = false;
  const out = days.map((d, i) =>
    lazy && i > 0
      ? '<div class="weekly-lazy-day" data-lazy="' + iso(d) + '" style="min-height:' +
        (110 + (state.windows ? slotsFor(d).length : lessonsFor(d).length) * (state.light ? 76 : 96)) +
        'px" aria-hidden="true"></div>'
      : cachedFutureDay(d)
  );
  /* Обёртка нужна, чтобы будущие дни проявлялись каскадом,
     а не возникали резко вместе со сменой сцены. */
  return `<div class="weekly-future-days">${out.join("")}</div>`;
}

/* Отложенная дорисовка наблюдает только текущую сцену, а не каждую мутацию
   секундомера/анимации. Не больше одного невидимого дня за кадр. */
let lazyDayObserver = null;
let lazyDayFrame = null;
let lazyDayGeneration = 0;
const futureMarkupCache = new Map();
let futureMarkupKey = "";

function cachedFutureDay(d) {
  const context = [scheduleRevision, state.group, state.windows, state.parityMode,
    iso(startOfDay(currentDate())), JSON.stringify(loadSwaps())].join("|");
  if (context !== futureMarkupKey) {
    futureMarkupKey = context;
    futureMarkupCache.clear();
  }
  const key = iso(d);
  if (!futureMarkupCache.has(key)) {
    if (futureMarkupCache.size > 28) futureMarkupCache.clear();
    futureMarkupCache.set(key, dayHtml(d, false, true));
  }
  return futureMarkupCache.get(key);
}

function setupLazyDays() {
  lazyDayObserver?.disconnect();
  if (lazyDayFrame !== null) cancelAnimationFrame(lazyDayFrame);
  lazyDayFrame = null;
  const generation = ++lazyDayGeneration;
  const host = $("#day-scene");
  if (!host) return;
  const targets = host.querySelectorAll(".weekly-lazy-day[data-lazy]");
  if (!targets.length) return;
  const fill = (el) => {
    if (!el.isConnected || !host.contains(el) || generation !== lazyDayGeneration) return;
    const template = document.createElement("template");
    template.innerHTML = cachedFutureDay(dateFromIso(el.dataset.lazy));
    el.replaceWith(template.content);
  };
  if (typeof IntersectionObserver === "undefined") {
    targets.forEach(fill);
    return;
  }
  const pending = new Set();
  const drain = () => {
    lazyDayFrame = null;
    if (generation !== lazyDayGeneration) return;
    const el = pending.values().next().value;
    if (el) { pending.delete(el); fill(el); }
    if (pending.size) lazyDayFrame = requestAnimationFrame(drain);
  };
  lazyDayObserver = new IntersectionObserver((entries) => {
    if (generation !== lazyDayGeneration) return;
    for (const en of entries) {
      if (!en.isIntersecting) continue;
      lazyDayObserver.unobserve(en.target);
      pending.add(en.target);
    }
    if (pending.size && lazyDayFrame === null) lazyDayFrame = requestAnimationFrame(drain);
  }, { rootMargin: "240px 0px" });
  targets.forEach((el) => lazyDayObserver.observe(el));
}

const ICON_CHECK =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" aria-hidden="true"><path d="M5 13l4 4 10-10"/></svg>';
const ICON_PLUS =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>';
const ICON_CHEVRON =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg>';
const ICON_GIFT =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><rect x="3" y="8" width="18" height="12" rx="2"/><path d="M3 12h18M12 8v12M8.5 8a2.5 2.5 0 1 1 3.5-2.3A2.5 2.5 0 1 1 15.5 8z"/></svg>';
const ICON_SHIELD =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3l7 3v5c0 4.6-3 7.7-7 9.2-4-1.5-7-4.6-7-9.2V6z"/><path d="M9.3 11.8l2 2 3.4-3.9"/></svg>';
const ICON_BELL =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.7 21a2 2 0 0 1-3.4 0"/></svg>';
const ICON_LOGIN =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4"/><path d="M10 17l5-5-5-5"/><path d="M15 12H3"/></svg>';

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/* ---------- профиль ---------- */

function notifPreferencesHtml() {
  const prefs = loadNotifPrefs();
  const rows = [
    ["swaps", "замены и отмены", "в колокольчике и в telegram"],
    ["schedule", "обновления расписания", "когда появляется новое расписание"],
    ["pending", "заявки на проверку", "для владельца и редакторов"],
    ["telegram", "дублировать в telegram", LOCAL_PREVIEW ? "локальная проверка, без отправки сообщений" :
      TELEGRAM_BOT_NAME ? "бот @" + TELEGRAM_BOT_NAME + " — сначала нажми /start" : "личные сообщения от бота"],
  ];
  return rows.map(([key, title, hint]) => `<div class="weekly-settings-row">
    <span class="weekly-settings-row-main"><span class="weekly-settings-copy">
      <strong>${title}</strong><span>${escapeHtml(hint)}</span>
    </span></span>
    <button class="weekly-setting-switch" type="button" data-npref="${key}" aria-label="${title}"
      aria-pressed="${prefs[key] ? "true" : "false"}"><span aria-hidden="true"></span></button>
  </div>`).join("");
}

function toggleProfileNotifs(button) {
  const panel = document.getElementById(button.getAttribute("aria-controls"));
  if (!panel) return;
  const open = button.getAttribute("aria-expanded") !== "true";
  button.setAttribute("aria-expanded", String(open));
  panel.setAttribute("aria-hidden", String(!open));
  panel.inert = !open;
  panel.classList.toggle("is-open", open);
}

function closeNotifsSheet() {
  const backdrop = document.getElementById("notifs-backdrop");
  if (!backdrop) return;
  backdrop.classList.remove("is-open");
  window.setTimeout(() => backdrop.remove(), 180);
}

function openNotifsSheet() {
  closeNotifsSheet();
  const backdrop = document.createElement("div");
  backdrop.id = "notifs-backdrop";
  backdrop.className = "weekly-replace-backdrop";
  backdrop.innerHTML = `
    <div class="weekly-replace-sheet weekly-tg-sheet" role="dialog" aria-label="настройки уведомлений">
      <div class="weekly-replace-head">
        <strong>настроить уведомления</strong>
        <span>что показывать и куда дублировать</span>
      </div>
      <div class="weekly-tg-section" style="margin-top: 6px;">
        ${notifPreferencesHtml()}
      </div>
      <div class="weekly-replace-actions" style="margin-top: 8px;">
        <button type="button" data-notifs-act="close">готово</button>
      </div>
    </div>`;
  document.body.appendChild(backdrop);
  window.requestAnimationFrame(() => backdrop.classList.add("is-open"));

  backdrop.addEventListener("click", (e) => {
    if (e.target === backdrop) {
      closeNotifsSheet();
      return;
    }
    const sw = e.target.closest("[data-npref]");
    if (sw) {
      toggleNotifPref(sw.dataset.npref, sw);
      return;
    }
    const closeBtn = e.target.closest('[data-notifs-act="close"]');
    if (closeBtn) {
      closeNotifsSheet();
    }
  });
}

function openProfile() {
  const backdrop = $("#profile-backdrop");
  const count = lessonCount(state.group);
  const role = myRole();
  const canReview = role === "owner" || role === "editor";
  const pendingCount = Object.keys(pendingMap).length;

  /* После входа — карточка-«герой» с аватаркой, именем и бейджем роли. */
  let heroBlock = "";
  let accountBlock = "";
  if (tgSession) {
    const roleLabel = tgSession?.isLocalDemo ? "владелец" : role === "owner" ? "владелец" : role === "editor" ? "редактор" : "студент";
    const avatarInner = tgSession.photo_url
      ? '<img src="' + escapeHtml(String(tgSession.photo_url)) + '" alt="">'
      : "<b>" + escapeHtml((tgDisplayName(tgSession) || "?").trim().charAt(0).toUpperCase() || "?") + "</b>";
    heroBlock = `
    <div class="weekly-profile-hero">
      <span class="weekly-profile-hero-avatar">${avatarInner}</span>
      <strong class="weekly-profile-hero-name">${escapeHtml(tgDisplayName(tgSession))}</strong>
      ${tgSession.username ? '<span class="weekly-profile-hero-username">@' + escapeHtml(String(tgSession.username)) + "</span>" : ""}
      <span class="weekly-profile-hero-role is-${role}">${ICON_SHIELD}<span>${roleLabel}</span></span>
      <button type="button" class="weekly-profile-hero-id is-copy" data-act="copy-id" data-id="${escapeHtml(String(tgSession.id))}" title="нажми, чтобы скопировать">мой id: <b>${escapeHtml(String(tgSession.id))}</b></button>
      <div class="weekly-profile-hero-actions">
        <button type="button" class="weekly-profile-mini" data-act="tg-logout">выйти</button>
      </div>
    </div>`;
  } else {
    accountBlock = `
      <div class="weekly-profile-group">
        <div class="weekly-profile-group-heading"><span>аккаунт telegram</span></div>
        <div class="weekly-profile-auth">
          ${
            LOCAL_PREVIEW
              ? `<button type="button" class="weekly-profile-auth-btn" data-act="local-tg-login">
                  <span class="weekly-profile-auth-icon">${ICON_LOGIN}</span>
                  <span class="weekly-profile-auth-text"><strong>тестовый вход Telegram</strong>
                    <small>демо-профиль в этом браузере</small></span>${ICON_CHEVRON}
                </button>`
              : TELEGRAM_BOT_ID
              ? `<button type="button" class="weekly-profile-auth-btn" data-act="tg-login">
              <span class="weekly-profile-auth-icon">${ICON_LOGIN}</span>
              <span class="weekly-profile-auth-text">
                <strong>войти через Telegram</strong>
                <small>общие замены и синхронизация профиля</small>
              </span>
              ${ICON_CHEVRON}
            </button>`
              : `<div class="weekly-profile-auth-legacy" id="profile-tg-widget"></div>`
          }
          <small>${
            LOCAL_PREVIEW ? "только localhost · без настоящей авторизации и без записи в общую базу"
              : tgConfigured() || TELEGRAM_BOT_ID
              ? "откроется приложение telegram — подтверди вход и вернись сюда, вход дойдёт сам"
              : "вход через telegram не настроен"
          }</small>
        </div>
      </div>`;
  }

  const content = `
      <div class="weekly-profile-group">
        <div class="weekly-profile-group-heading"><span>учебная группа</span></div>
        <div class="weekly-profile-select">
          <select id="profile-group">${groupOptions(state.group)}</select>
          ${ICON_CHEVRON}
        </div>
      </div>
      <div class="weekly-profile-group">
        <button class="weekly-settings-row weekly-profile-notifs-head" type="button" data-act="toggle-notifs"
          id="profile-notifs-toggle" aria-expanded="false" aria-controls="profile-notifs-panel">
          <span class="weekly-settings-row-main">
            <span class="weekly-settings-icon is-theme">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.7 21a2 2 0 0 1-3.4 0"/></svg>
            </span>
            <span class="weekly-settings-copy">
              <strong>настроить уведомления</strong>
              <span>что показывать и куда дублировать</span>
            </span>
          </span>
          ${ICON_CHEVRON}
        </button>
        <div class="weekly-profile-notifs-panel" id="profile-notifs-panel" role="region"
          aria-labelledby="profile-notifs-toggle" aria-hidden="true" inert>
          <div class="weekly-profile-notifs-panel-inner"><div class="weekly-profile-notifs-options">
            ${notifPreferencesHtml()}
          </div></div>
        </div>
        ${
          canReview
            ? `<button class="weekly-settings-row" type="button" data-act="open-tg">
          <span class="weekly-settings-row-main">
            <span class="weekly-settings-icon is-editor">${ICON_SHIELD}</span>
            <span class="weekly-settings-copy">
              <strong>заявки и редакторы</strong>
              <span>${pendingCount ? "ждут проверки: " + pendingCount : "проверка замен и права"}</span>
            </span>
          </span>
          ${ICON_CHEVRON}
        </button>`
            : ""
        }
      </div>
      ${accountBlock}`;

  backdrop.innerHTML = `<div class="weekly-profile" role="dialog" aria-modal="true" aria-label="профиль">
    <div class="weekly-profile-header">
      <button type="button" data-act="back">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M15 6l-6 6 6 6"/></svg>
        назад
      </button>
      <h1>профиль</h1>
      <span></span>
    </div>
    ${heroBlock}
    <div class="weekly-profile-identity">
      <div>
        <h2>${groupName()}</h2>
        <p>${count} ${plural(count, "пара", "пары", "пар")} в неделю</p>
      </div>
    </div>
    <div class="weekly-profile-content">
      ${content}
    </div>
    <div class="weekly-profile-footer">
      <button type="button" data-act="close">готово</button>
    </div>
  </div>`;
  backdrop.hidden = false;
  state.profileOpen = true;
  if (!LOCAL_PREVIEW && !tgSession && !TELEGRAM_BOT_ID && tgConfigured()) mountTelegramWidget(document.getElementById("profile-tg-widget"));
  if (!LOCAL_PREVIEW && !tgSession && TELEGRAM_BOT_ID) preloadTgLoginLib();
}

function closeProfile() {
  const backdrop = $("#profile-backdrop");
  backdrop.hidden = true;
  backdrop.innerHTML = "";
  state.profileOpen = false;
  closeTgMemo();
  closeNotifsSheet();
  closeTgSheet();
}

/* ---------- онбординг ---------- */

function onboardingHtml() {
  const total = 2;
  const offset = `-${state.onboardingStep * (100 / total)}%`;
  const dots = [];
  for (let i = 0; i < total; i += 1) {
    dots.push(
      `<button type="button" class="${i === state.onboardingStep ? "is-active" : ""}" data-step="${i}" aria-label="шаг ${
        i + 1
      }"></button>`
    );
  }
  const draft = state.draftGroup;
  const count = lessonCount(draft);
  return `<div class="weekly-onboarding-top">
    <div class="weekly-onboarding-progress">${dots.join("")}</div>
  </div>
  <div class="weekly-onboarding-slides" style="--onboarding-count:${total};--onboarding-slide-width:${
    100 / total
  }%;--onboarding-offset:${offset}">
    <div class="weekly-onboarding-slide is-welcome" aria-hidden="${state.onboardingStep === 0 ? "false" : "true"}">
      <div class="weekly-onboarding-copy is-centered">
        <div class="weekly-onboarding-mark">
          <svg class="weeqo-mark" viewBox="0 0 24 24" aria-hidden="true"><path d="M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.937A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .962 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.581a.5.5 0 0 1 0 .964L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.963 0z"/></svg>
        </div>
        <span class="weekly-onboarding-kicker">weeqo beta</span>
        <h1>только расписание</h1>
        <p>как это работает? каждые 3 ча��а мы берём расписание с сайта sustec.ru машиностроительного колледжа и загружаем его сюда</p>
      </div>
      <button class="weekly-onboarding-action" type="button" data-act="next">выбрать группу</button>
    </div>
    <div class="weekly-onboarding-slide is-profile" aria-hidden="${state.onboardingStep === 1 ? "false" : "true"}">
      <div class="weekly-onboarding-copy">
        <button class="weekly-onboarding-back" type="button" data-act="back">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M15 6l-6 6 6 6"/></svg>
          назад
        </button>
        <h1>какая группа?</h1>
        <p>выбор можно по��енять потом в настройках</p>
        <div class="weekly-profile-fields">
          <label class="weekly-profile-field">учебная группа
            <div class="weekly-profile-control">
              <select id="onboarding-group">${groupOptions(draft)}</select>
              ${ICON_CHEVRON}
            </div>
            <small>${draft} · ${count} ${plural(count, "пара", "пары", "пар")} в неделю</small>
          </label>
        </div>
      </div>
      <button class="weekly-onboarding-action" type="button" data-act="finish">подтвердить группу</button>
    </div>
  </div>`;
}

function renderOnboarding() {
  const host = $("#onboarding");
  /* Тему не форсируем: первый запуск следует системной (или выбранной ранее). */
  applyTheme();
  host.innerHTML = onboardingHtml();
  host.hidden = false;
}

function closeOnboarding() {
  const host = $("#onboarding");
  host.classList.add("is-closing");
  window.setTimeout(() => {
    host.hidden = true;
    host.classList.remove("is-closing");
    host.innerHTML = "";
    playBrandIntro(); /* главный экран появился — теперь интро лого */
  }, 320);
  state.onboarded = true;
  save();
  applyTheme();
}

/* ---------- события разделов ---------- */

function bindExtra() {
  $("#light-switch").addEventListener("click", () => {
    state.light = !state.light;
    applyFlags();
    save();
  });

  $("#scope-switch").addEventListener("click", () => {
    state.scope = state.scope === "week" ? "day" : "week";
    applyFlags();
    save(); /* запоминаем выбор */
    render();
  });

  $("#aux-view").addEventListener("click", (e) => {
    const act = e.target.closest("[data-act]");
    if (!act) return;
    if (act.dataset.act === "back-schedule") {
      state.tab = "schedule";
      render();
    }
  });

  $("#profile-backdrop").addEventListener("click", (e) => {
    e.stopPropagation();
    if (e.target === e.currentTarget) {
      closeProfile();
      closeSettings();
      return;
    }
    const sw = e.target.closest("[data-npref]");
    if (sw) {
      toggleNotifPref(sw.dataset.npref, sw);
      return;
    }
    /* Действия заявок/редакторов внутри профиля — те же data-tg, что в шторке. */
    const tgEl = e.target.closest("[data-tg]");
    if (tgEl) {
      const tgAct = tgEl.dataset.tg;
      if (tgAct === "copy-id") copyTextToClipboard(tgEl.dataset.id || "");
      else if (tgAct === "approve") approvePending(tgEl.dataset.key);
      else if (tgAct === "reject") rejectPending(tgEl.dataset.key);
      else if (tgAct === "grant") {
        const entry = pendingMap[tgEl.dataset.key] || {};
        grantEditor(tgEl.dataset.tgid, entry.byName);
      } else if (tgAct === "revoke") revokeEditor(tgEl.dataset.tgid);
      else if (tgAct === "add-editor") {
        const inp = document.getElementById("tg-add-editor-id");
        const id = inp ? inp.value.trim() : "";
        if (!/^\d{3,32}$/.test(id)) {
          toast("нужен числовой id — он есть в профиле у человека");
          return;
        }
        grantEditor(id, "редактор " + id);
      }
      return;
    }
    const act = e.target.closest("[data-act]");
    if (!act) return;
    if (act.dataset.act === "back") {
      closeProfile();
      openSettings();
      return;
    }
    if (act.dataset.act === "close") {
      closeProfile();
      closeSettings();
      return;
    }
    else if (act.dataset.act === "copy-id") copyTextToClipboard(act.dataset.id || "");
    else if (act.dataset.act === "tg-login") {
      /* Красивая кнопка есть только при настроенном Client ID — открываем
         страницу входа Telegram (OIDC-попап). */
      if (TELEGRAM_BOT_ID) startOidcLogin();
    } else if (act.dataset.act === "local-tg-login") {
      startLocalTelegramLogin();
    } else if (act.dataset.act === "toggle-notifs") {
      toggleProfileNotifs(act);
    } else if (act.dataset.act === "open-tg") {
      openTgSheet();
      const role = myRole();
      if (role === "owner" || role === "editor") pullPending();
    } else if (act.dataset.act === "tg-logout") {
      tgLogout();
      openProfile();
    }
  });

  $("#profile-backdrop").addEventListener("change", (e) => {
    if (e.target.id === "profile-group") {
      state.group = e.target.value;
      state.draftGroup = e.target.value;
      save();
      render();
      openProfile();
    }
  });

  const onboarding = $("#onboarding");
  onboarding.addEventListener("change", (e) => {
    if (e.target.id === "onboarding-group") {
      state.draftGroup = e.target.value;
      renderOnboarding();
    }
  });
  onboarding.addEventListener("click", (e) => {
    const act = e.target.closest("[data-act], [data-step]");
    if (!act) return;
    const kind = act.dataset.act;
    if (act.dataset.step !== undefined) {
      state.onboardingStep = Number(act.dataset.step);
      renderOnboarding();
      return;
    }
    if (kind === "next") {
      state.onboardingStep = 1;
      renderOnboarding();
      return;
    }
    if (kind === "back") {
      state.onboardingStep = Math.max(0, state.onboardingStep - 1);
      renderOnboarding();
      return;
    }
    if (kind === "finish") {
      state.group = state.draftGroup;
      closeOnboarding();
      render();
      return;
    }
  });
}

function hideLoader() {
  const loader = $("#loader");
  if (!loader) return;
  loader.style.transition = "opacity .28s ease";
  loader.style.opacity = "0";
  window.setTimeout(() => loader.remove(), 320);
}

/* Интро-анимация лого — запускаем только когда главный экран виден. */
function playBrandIntro() {
  const brand = $("#brand");
  if (!brand || motionQuery.matches) return;
  window.clearTimeout(brandTimer);
  brand.classList.remove("is-playing", "is-word-out");
  void brand.offsetWidth;
  brand.classList.add("is-playing");
  brandTimer = window.setTimeout(() => {
    brand.classList.remove("is-playing", "is-word-out");
    brandTimer = null;
  }, 3200);
}

function syncCompactHeader() {
  const brand = $("#brand");
  if (!brand) return;
  brand.setAttribute("role", "button");
  brand.setAttribute("tabindex", "0");
  brand.setAttribute("aria-label", "воспроизвести анимацию weeqo");
  brand.removeAttribute("aria-disabled");
}

function init() {
  load();
  /* Пока тема не выбрана вручную — следим за системной и подхватываем её смену. */
  (function followSystemTheme() {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const mq = window.matchMedia("(prefers-color-scheme: light)");
    const sync = () => {
      if (state.themeManual) return;
      const sys = mq.matches ? "light" : "dark";
      if (state.theme === sys) return;
      state.theme = sys;
      applyTheme();
      renderHeader();
    };
    if (mq.addEventListener) mq.addEventListener("change", sync);
    else if (mq.addListener) mq.addListener(sync);
  })();
  applyQuery();
  applyTheme();
  applyPerfMode();

  $("#windows-switch").setAttribute("aria-pressed", state.windows ? "true" : "false");

  bindEvents();
  bindExtra();
  syncCompactHeader();
  if (compactHeaderQuery.addEventListener) compactHeaderQuery.addEventListener("change", syncCompactHeader);
  else compactHeaderQuery.addListener(syncCompactHeader);
  render();

  if (!state.onboarded) renderOnboarding();
  if (state.profileOpen) {
    state.profileOpen = false;
    openProfile();
  }

  $("#app").hidden = false;
  hideLoader();

  /* При первом входе экран закрыт онбордингом — интро сыграет в closeOnboarding(). */
  if (state.onboarded) playBrandIntro();

  if (state.settingsOpen) {
    state.settingsOpen = false;
    openSettings();
  }

  tickTimer = window.setInterval(tick, 1000);

  if (!LOCAL_PREVIEW && "serviceWorker" in navigator && location.protocol.startsWith("http")) {
    /* updateViaCache: none — проверка новой версии SW не упирается в HTTP-кэш. */
    navigator.serviceWorker.register("sw.js", { updateViaCache: "none" }).catch(() => {});
  }
}



/* ---------- замена пары ---------- */

/* var намеренно: эти значения нужны раннему рендеру до конца модуля */
var SWAP_KEY = "weekly:swaps:v1";
var swapMap = null;

function loadSwaps() {
  if (swapMap) return swapMap;
  swapMap = {};
  try {
    const raw = localStorage.getItem(SWAP_KEY);
    if (raw) {
      const data = JSON.parse(raw);
      if (data && typeof data === "object") swapMap = migrateSwaps(data);
      let stamped = false;
      for (const sk in swapMap) {
        const entry = swapMap[sk];
        if (entry && typeof entry === "object" && typeof entry.updatedAt !== "number") {
          entry.updatedAt = Date.now();
          stamped = true;
        }
      }
      if (stamped) localStorage.setItem(SWAP_KEY, JSON.stringify(swapMap));
    }
  } catch (e) {
    /* приватный режим */
  }
  return swapMap;
}

function saveSwaps() {
  try {
    localStorage.setItem(SWAP_KEY, JSON.stringify(loadSwaps()));
  } catch (e) {
    /* приватный режим */
  }
}

function swapKey(dIso, n) {
  return (state.group || DEFAULT_GROUP) + "|" + dIso + ":" + n;
}

function swapFor(dIso, n) {
  const entry = loadSwaps()[swapKey(dIso, n)];
  return entry && !entry.deleted ? entry : null;
}

function setSwap(dIso, n, value) {
  const map = loadSwaps();
  if (value) {
    value.updatedAt = Date.now();
    map[swapKey(dIso, n)] = value;
  } else if (sharedSwapsEnabled()) {
    /* В общем режиме удаление тоже должно разойтись по всем —
       оставляем надгробие со свежим штампом времени. */
    map[swapKey(dIso, n)] = { deleted: true, updatedAt: Date.now() };
  } else {
    delete map[swapKey(dIso, n)];
  }
  saveSwaps();
  publishSwapKey(swapKey(dIso, n));
}

/* Базовое расписание лежит в slotsForBase, а здесь накладываются замены. */
function slotsFor(d) {
  const list = slotsForBase(d);
  if (!list.length) return list;
  const map = loadSwaps();
  const dIso = iso(d);
  const prefix = (state.group || DEFAULT_GROUP) + "|" + dIso + ":";
  let hasAny = false;
  for (const key in map) {
    if (key.indexOf(prefix) === 0) {
      hasAny = true;
      break;
    }
  }
  if (!hasAny) return list;
  return list.map((slot) => {
    const sw = map[swapKey(dIso, slot.n)];
    if (!sw || sw.deleted) return slot;
    const next = Object.assign({}, slot);
    if (sw.cancelled) {
      next.cancelled = true;
      next.window = false;
      next.empty = false;
      if (!next.subject) next.subject = "пара отменена";
      return next;
    }
    if (sw.subject) {
      next.subject = sw.subject;
      next.window = false;
      next.empty = false;
    }
    if (sw.teacher !== undefined) next.teacher = sw.teacher;
    if (sw.room !== undefined) next.room = sw.room;
    next.swapped = true;
    return next;
  });
}

var ICON_SWAP =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" aria-hidden="true"><path d="M4 8h13l-3.5-3.5M20 16H7l3.5 3.5"/></svg>';

function swapButtonHtml(dIso, n, isWindow) {
  if (!dIso) return "";
  const title = isWindow ? "добавить или изменить пару" : "замена пары";
  return (
    '<button class="lesson-swap-btn" type="button" data-act="swap" data-date="' +
    dIso +
    '" data-n="' +
    n +
    '" aria-label="' +
    title +
    '" title="' +
    title +
    '">' +
    ICON_SWAP +
    "</button>"
  );
}

function dateFromIso(dIso) {
  const parts = String(dIso).split("-");
  return startOfDay(new Date(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2])));
}

function closeSwapSheet() {
  const backdrop = document.getElementById("swap-backdrop");
  if (!backdrop) return;
  backdrop.classList.remove("is-open");
  window.setTimeout(() => backdrop.remove(), 160);
}

/* Каталог предметов группы: предмет + самые частые преподаватель и аудитория. */
function subjectCatalog() {
  const stats = new Map();
  currentGroup().days.forEach((day) => {
    day.slots.forEach((s) => {
      if (!s.subject) return;
      if (!stats.has(s.subject)) {
        stats.set(s.subject, { subject: s.subject, teachers: new Map(), rooms: new Map() });
      }
      const entry = stats.get(s.subject);
      if (s.teacher) entry.teachers.set(s.teacher, (entry.teachers.get(s.teacher) || 0) + 1);
      if (s.room) entry.rooms.set(s.room, (entry.rooms.get(s.room) || 0) + 1);
    });
  });
  const top = (counts) => {
    let best = "";
    let hits = 0;
    counts.forEach((count, value) => {
      if (count > hits) {
        hits = count;
        best = value;
      }
    });
    return best;
  };
  return Array.from(stats.values())
    .map((entry) => ({
      subject: entry.subject,
      teacher: top(entry.teachers),
      room: top(entry.rooms),
    }))
    .sort((a, b) => a.subject.localeCompare(b.subject, "ru"));
}

function openSwapSheet(dIso, n) {
  closeSwapSheet();
  const d = dateFromIso(dIso);
  const slot = slotsFor(d).find((s) => s.n === n) || null;
  const sw = swapFor(dIso, n) || {};
  const isWindowSlot = Boolean(slot && (slot.window || slot.empty));
  const sheetTitle = isWindowSlot && !sw.subject ? "добавить пару в окно" : "замена пары";
  const subject = sw.subject || (slot && !slot.window ? slot.subject || "" : "");
  const teacher = sw.teacher !== undefined ? sw.teacher : (slot && slot.teacher) || "";
  const room = sw.room !== undefined ? sw.room : (slot && slot.room) || "";
  const timeText = slot ? slot.from + "–" + slot.to : "";
  const catalog = subjectCatalog();
  const known = catalog.find((item) => item.subject === subject) || null;
  const customSubject = subject && !known ? subject : "";

  const options = ['<option value="">не выбран</option>']
    .concat(
      catalog.map(
        (item) =>
          '<option value="' +
          escapeHtml(item.subject) +
          '" data-teacher="' +
          escapeHtml(item.teacher) +
          '" data-room="' +
          escapeHtml(item.room) +
          '"' +
          (known && known.subject === item.subject ? " selected" : "") +
          ">" +
          escapeHtml(item.subject) +
          (item.teacher ? " · " + escapeHtml(item.teacher) : "") +
          "</option>"
      )
    )
    .join("");

  const backdrop = document.createElement("div");
  backdrop.id = "swap-backdrop";
  backdrop.className = "weekly-replace-backdrop";
  backdrop.innerHTML =
    '<div class="weekly-replace-sheet" role="dialog" aria-label="' + sheetTitle + '">' +
    '<div class="weekly-replace-head"><strong>' + sheetTitle + '</strong><span>' +
    escapeHtml(n + " пара" + (timeText ? " · " + timeText : "") + " · " + dateLabel(d)) +
    "</span></div>" +
    '<label class="weekly-replace-field"><span>предмет из расписания</span>' +
    '<div class="weekly-replace-select"><select id="swap-subject">' +
    options +
    "</select></div></label>" +
    '<label class="weekly-replace-field"><span>или свой предмет</span>' +
    '<input id="swap-subject-custom" type="text" value="' +
    escapeHtml(customSubject) +
    '" placeholder="название предмета" /></label>' +
    '<label class="weekly-replace-field"><span>преподаватель</span>' +
    '<input id="swap-teacher" type="text" value="' +
    escapeHtml(teacher) +
    '" placeholder="фамилия" /></label>' +
    '<label class="weekly-replace-field"><span>аудитория</span>' +
    '<input id="swap-room" type="text" value="' +
    escapeHtml(room) +
    '" placeholder="номер" /></label>' +
    '<p class="weekly-replace-hint">выбрал предмет из списка — преподаватель и аудитория подставятся сами; вписал свой предмет — они сбросятся</p>' +
    '<div class="weekly-replace-actions">' +
    '<button class="is-primary" type="button" data-swap="save">' + swapPrimaryLabel() + "</button>" +
    '<button type="button" data-swap="cancel-lesson">отменить пару</button>' +
    '<button type="button" data-swap="reset">сбросить</button>' +
    '<button type="button" data-swap="close">закрыть</button>' +
    "</div>" + swapAccessHint() + "</div>";

  document.body.appendChild(backdrop);
  window.requestAnimationFrame(() => backdrop.classList.add("is-open"));

  const picker = backdrop.querySelector("#swap-subject");
  const custom = backdrop.querySelector("#swap-subject-custom");
  const teacherField = backdrop.querySelector("#swap-teacher");
  const roomField = backdrop.querySelector("#swap-room");
  /* Подставленное автоматически можно сбрасывать, вписанное руками — нет. */
  let autoFilled =
    Boolean(known) && teacher === (known.teacher || "") && room === (known.room || "");

  picker.addEventListener("change", () => {
    const option = picker.options[picker.selectedIndex];
    if (!picker.value || !option) return;
    custom.value = "";
    teacherField.value = option.dataset.teacher || "";
    roomField.value = option.dataset.room || "";
    autoFilled = true;
  });

  custom.addEventListener("input", () => {
    if (!custom.value.trim()) return;
    if (picker.value) picker.value = "";
    if (autoFilled) {
      teacherField.value = "";
      roomField.value = "";
      autoFilled = false;
    }
  });

  const commit = () => {
    closeSwapSheet();
    render();
  };

  backdrop.addEventListener("click", (e) => {
    if (e.target === backdrop) {
      closeSwapSheet();
      return;
    }
    const btn = e.target.closest("button[data-swap]");
    if (!btn) return;
    const act = btn.dataset.swap;
    if (act === "close") {
      closeSwapSheet();
      return;
    }
    if (act === "reset") {
      setSwap(dIso, n, null);
      commit();
      return;
    }
    if (act === "cancel-lesson") {
      setSwap(dIso, n, { cancelled: true });
      commit();
      return;
    }
    const nextSubject = custom.value.trim() || picker.value.trim();
    const nextTeacher = teacherField.value.trim();
    const nextRoom = roomField.value.trim();
    if (!nextSubject && !nextTeacher && !nextRoom) {
      setSwap(dIso, n, null);
      commit();
      return;
    }
    setSwap(dIso, n, { subject: nextSubject, teacher: nextTeacher, room: nextRoom });
    commit();
  });
}

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    closeSwapSheet();
    closeTgSheet();
    closeUpdatesSheet();
  }
});

(() => {
  const scene = document.getElementById("scene");
  if (!scene) return;
  scene.addEventListener("click", (e) => {
    const btn = e.target.closest('[data-act="swap"]');
    if (!btn) return;
    e.preventDefault();
    e.stopPropagation();
    openSwapSheet(btn.dataset.date, Number(btn.dataset.n));
  });
  scene.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      const btn = e.target.closest('[data-act="swap"]');
      if (btn) {
        e.preventDefault();
        e.stopPropagation();
        openSwapSheet(btn.dataset.date, Number(btn.dataset.n));
      }
    }
  });
})();

/* ---------- автообновление расписания ----------
   data/schedule.json пересобирает GitHub Action каждые 3 часа из PDF
   на sustec.ru, а приложение с тем же шагом его перечитывает. */
var SCHEDULE_URL = "data/schedule.json";
var SCHEDULE_CACHE_KEY = "weekly:schedule-cache:v2";
var SCHEDULE_TTL = 3 * 60 * 60 * 1000;
var scheduleFetchedAt = 0;
var SCHEDULE_CHECKED_KEY = "weekly:schedule-checked-at:v1";
/* Момент последней удачной проверки данных — его показывает штамп «обн.».
   Храним в localStorage, чтобы после перезапуска было видно, когда данные проверялись. */
var scheduleCheckedAt = (function () {
  try {
    const v = Number(localStorage.getItem(SCHEDULE_CHECKED_KEY));
    return Number.isFinite(v) && v > 0 ? v : null;
  } catch (e) {
    return null;
  }
})();
var scheduleApply = null;

function previewAnimated() {
  /* Один и тот же сценарий анимаций на компьютере и на телефоне:
     без троттлинга и без облегчённого режима. */
  return Boolean(scrub);
}

function migrateSwaps(data) {
  const out = {};
  Object.keys(data).forEach((key) => {
    out[key.indexOf("|") === -1 ? "\u0442\u043c-303/\u0431|" + key : key] = data[key];
  });
  return out;
}

function scheduleModule() {
  if (scheduleApply) return Promise.resolve(scheduleApply);
  return import("./schedule.js").then((mod) => {
    scheduleApply = mod.applyRemoteGroups;
    return scheduleApply;
  });
}

function scheduleStamp(payload) {
  if (payload && payload.updatedAt) {
    notifyAboutScheduleStamp(payload.updatedAt);
    scheduleUpdatedAt = payload.checkedAt || payload.updatedAt;
  }
  renderDataStamp();
  const el = $("#freshness");
  if (!el || !payload || !(payload.checkedAt || payload.updatedAt)) return;
  const when = new Date(payload.checkedAt || payload.updatedAt);
  if (Number.isNaN(when.getTime())) return;
  const hh = String(when.getHours()).padStart(2, "0");
  const mm = String(when.getMinutes()).padStart(2, "0");
  el.textContent = "\u0440\u0430\u0441\u043f\u0438\u0441\u0430\u043d\u0438\u0435 \u043e\u0431\u043d\u043e\u0432\u043b\u0435\u043d\u043e \u0432 " + hh + ":" + mm;
}

function applySchedulePayload(payload) {
  return scheduleModule().then((apply) => {
    if (typeof apply !== "function") return false;
    if (!apply(payload)) return false;
    scheduleRevision += 1;
    if (!GROUPS.some((g) => g.id === state.group)) {
      state.group = GROUPS.some((g) => g.id === DEFAULT_GROUP) ? DEFAULT_GROUP : (GROUPS[0] ? GROUPS[0].id : DEFAULT_GROUP);
      state.draftGroup = state.group;
      save();
    }
    scheduleStamp(payload);
    render();
    renderStrip();
    return true;
  });
}

function cachedSchedulePayload() {
  try {
    const raw = localStorage.getItem(SCHEDULE_CACHE_KEY);
    if (!raw) return null;
    const data = JSON.parse(raw);
    return data && Array.isArray(data.groups) ? data : null;
  } catch (e) {
    return null;
  }
}

function refreshSchedule(force) {
  if (!force && Date.now() - scheduleFetchedAt < SCHEDULE_TTL) return Promise.resolve(false);
  return fetch(SCHEDULE_URL + "?t=" + Date.now(), { cache: "no-store" })
    .then((res) => (res.ok ? res.json() : null))
    .then((payload) => {
      if (!payload || !Array.isArray(payload.groups)) return false;
      /* Ответ получен — двигаем штамп «обн.», даже если сами данные не изменились. */
      scheduleCheckedAt = Date.now();
      try {
        localStorage.setItem(SCHEDULE_CHECKED_KEY, String(scheduleCheckedAt));
      } catch (e) {
        /* приватный режим */
      }
      renderDataStamp();
      /* Файл пришёл, но групп нет — парсер на GitHub ещё ни разу не записал данные. */
      if (!payload.groups.length) return "empty";
      scheduleFetchedAt = Date.now();
      try {
        localStorage.setItem(SCHEDULE_CACHE_KEY, JSON.stringify(payload));
      } catch (e) {
        /* приватный режим */
      }
      return applySchedulePayload(payload);
    })
    .catch(() => false);
}

/* Пока на сервере пусто, проверяем каждые 5 минут, а не раз в час. */
var scheduleRetryTimer = null;

function planScheduleRetry() {
  window.clearTimeout(scheduleRetryTimer);
  scheduleRetryTimer = null;
  if (GROUPS.length) return;
  scheduleRetryTimer = window.setTimeout(function () {
    refreshSchedule(true).then(planScheduleRetry);
  }, 5 * 60 * 1000);
}

(function startScheduleUpdates() {
  const cached = cachedSchedulePayload();
  if (cached) applySchedulePayload(cached);
  refreshSchedule(true).then(planScheduleRetry);
  window.setInterval(() => refreshSchedule(true), SCHEDULE_TTL);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) refreshSchedule(false);
  });
  window.addEventListener("online", () => refreshSchedule(true));
})();

/* Слишком светлый акцент на светлом фоне и слишком тёмный на тёмном
   не читаются, поэтому для текста и иконок берём подправленный оттенок */
function accentLuminance(hex) {
  const n = String(hex || "").replace("#", "");
  if (n.length !== 6) return 0.5;
  const ch = (i) => parseInt(n.slice(i, i + 2), 16) / 255;
  const lin = (c) => (c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
  return 0.2126 * lin(ch(0)) + 0.7152 * lin(ch(2)) + 0.0722 * lin(ch(4));
}

function readableAccent(hex, theme) {
  const light = theme === "light";
  const background = mixHex(hex, light ? "#ffffff" : "#05050a", light ? 0.32 : 0.28);
  const bg = accentLuminance(background);
  let color = hex;
  for (let step = 0; step <= 20; step += 1) {
    const fg = accentLuminance(color);
    if ((Math.max(fg, bg) + 0.05) / (Math.min(fg, bg) + 0.05) >= 4.5) return color;
    color = mixHex(hex, light ? "#000000" : "#ffffff", Math.max(0, 1 - (step + 1) * 0.05));
  }
  return color;
}

/* ---------- общие замены через облако ---------- */

/* Чтобы замена, поставленная одним человеком, была видна всем на тот же день,
   сюда вставляется адрес общего хранилища. Два варианта:
   1) Firebase Realtime Database (сервис Google):
      "https://ТВОЙ-ПРОЕКТ-default-rtdb.РЕГИОН.firebasedatabase.app/weeqo-swaps.json"
   2) корзина Pantry (getpantry.cloud):
      "https://getpantry.cloud/apiv1/pantry/ТВОЙ-ID/basket/weeqo-swaps";
   Пустая строка = замены хранятся только на устройстве, как раньше.
   Проверить без правки кода можно параметром ?swaps-cloud=адрес. */
/* Конфиг переехал в js/config.js — правь там, этот файл больше не трогай.
   Читаем из window с запасными значениями на случай если config.js не загрузился. */
var SHARED_SWAPS_URL = window.SHARED_SWAPS_URL || "";
var FIREBASE_API_KEY = window.FIREBASE_API_KEY || "";
var TELEGRAM_BOT_NAME = window.TELEGRAM_BOT_NAME || "";
var TELEGRAM_BOT_ID = String(window.TELEGRAM_BOT_ID || "").trim(); /* trim: пробел в переменной окружения ломал сверку aud */
var TELEGRAM_BOT_TOKEN_SHA256 = window.TELEGRAM_BOT_TOKEN_SHA256 || "";
/* Жёсткое назначение ролей через переменные окружения (без облака):
   TELEGRAM_OWNER_ID — один telegram id владельца, TELEGRAM_ADMIN_IDS — id редакторов через запятую. */
var TELEGRAM_OWNER_ID = String(window.TELEGRAM_OWNER_ID || "").trim();
var TELEGRAM_ADMIN_IDS = String(window.TELEGRAM_ADMIN_IDS || "").split(",").map(function (s) { return s.trim(); }).filter(Boolean);
var sharedSync = { pushing: false, again: false, poll: null };

/* ---------- анонимный вход Firebase ----------
   Окон логина нет: приложение само молча получает временный токен через REST,
   а правила базы (".write": "auth != null") пускают запись только с ним.
   Токен живёт час, дальше тихо обновляется по refresh-токену. */
var fbAuth = { token: null, refresh: null, uid: null, expiresAt: 0, pending: null };

function firebaseAuthEnabled() {
  return (
    Boolean(FIREBASE_API_KEY) &&
    /\.(firebaseio\.com|firebasedatabase\.app)/.test(sharedSwapsUrl())
  );
}

function fbAuthLoad() {
  try {
    const raw = localStorage.getItem("weekly:fb-auth:v1");
    if (raw) {
      const data = JSON.parse(raw);
      if (data && typeof data.refresh === "string") fbAuth.refresh = data.refresh;
      if (data && typeof data.uid === "string") fbAuth.uid = data.uid;
    }
  } catch (e) {
    /* приватный режим */
  }
}

function fbAuthSave() {
  try {
    localStorage.setItem("weekly:fb-auth:v1", JSON.stringify({ refresh: fbAuth.refresh, uid: fbAuth.uid }));
  } catch (e) {
    /* приватный режим */
  }
}

async function fbAuthPost(url, body) {
  const resp = await fetch(url + "?key=" + FIREBASE_API_KEY, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!resp.ok) throw new Error("firebase auth: " + resp.status);
  return resp.json();
}

async function ensureFbToken() {
  if (!firebaseAuthEnabled()) return null;
  /* Параллельные вызовы ждут один и тот же запрос. */
  if (fbAuth.pending) return fbAuth.pending;
  fbAuth.pending = (async () => {
    /* Запас 5 минут, чтобы токен не протух на середине записи. */
    if (fbAuth.token && Date.now() < fbAuth.expiresAt - 5 * 60 * 1000) {
      return fbAuth.token;
    }
    if (!fbAuth.refresh) fbAuthLoad();
    if (fbAuth.refresh) {
      try {
        const renewed = await fbAuthPost("https://securetoken.googleapis.com/v1/token", {
          grant_type: "refresh_token",
          refresh_token: fbAuth.refresh,
        });
        fbAuth.token = renewed.id_token;
        fbAuth.refresh = renewed.refresh_token;
        fbAuth.uid = renewed.user_id || fbAuth.uid;
        fbAuth.expiresAt = Date.now() + Number(renewed.expires_in) * 1000;
        fbAuthSave();
        return fbAuth.token;
      } catch (e) {
        fbAuth.refresh = null;
      }
    }
    const fresh = await fbAuthPost("https://identitytoolkit.googleapis.com/v1/accounts:signUp", {
      returnSecureToken: true,
    });
    fbAuth.token = fresh.idToken;
    fbAuth.refresh = fresh.refreshToken;
    fbAuth.uid = fresh.localId || null;
    fbAuth.expiresAt = Date.now() + Number(fresh.expiresIn) * 1000;
    fbAuthSave();
    return fbAuth.token;
  })();
  try {
    return await fbAuth.pending;
  } finally {
    fbAuth.pending = null;
  }
}

/* Тот же адрес базы, но с токеном. Без настроенного ключа возвращает как есть. */
async function sharedUrlWithAuth(url) {
  let token = null;
  try {
    token = await ensureFbToken();
  } catch (e) {
    if (!sharedUrlWithAuth._warned) {
      /* Один раз за сессию: без токена база отвечает 401 на всё, что требует auth. */
      sharedUrlWithAuth._warned = true;
      console.warn("weeqo: не смог получить firebase-токен — запросы идут без auth. Проверь FIREBASE_API_KEY (посимвольно ли совпадает с Web API key в Firebase Console) и что включён Anonymous (Authentication → Sign-in method):", e);
    }
    /* auth недоступен офлайн не настроен) — пробуем без токена */
  }
  if (!token) return url;
  return url + (url.indexOf("?") === -1 ? "?" : "&") + "auth=" + token;
}

function sharedSwapsUrl() {
  if (LOCAL_PREVIEW) return "";
  try {
    const forced = new URLSearchParams(window.location.search).get("swaps-cloud");
    if (forced) return forced;
  } catch (e) {}
  return SHARED_SWAPS_URL;
}

function sharedSwapsEnabled() {
  return Boolean(sharedSwapsUrl());
}

/* Записи по уже прошедшим дням выкидываем, чтобы корзина не разрасталась. */
function pruneSwapMap(map) {
  let changed = false;
  const horizon = Date.now() - 86400000;
  for (const key in map) {
    const datePart = (key.split("|")[1] || "").slice(0, 10);
    const end = new Date(datePart + "T23:59:59");
    if (!isNaN(end) && end.getTime() < horizon) {
      delete map[key];
      changed = true;
    }
  }
  return changed;
}

/* Склейка двух карт замен: у каждого ключа побеждает запись со свежим updatedAt. */
function mergeSwapMaps(base, incoming) {
  let changed = false;
  for (const key in incoming) {
    const inc = incoming[key];
    if (!inc || typeof inc !== "object") continue;
    const incT = typeof inc.updatedAt === "number" ? inc.updatedAt : 0;
    const cur = base[key];
    const curT = cur && typeof cur.updatedAt === "number" ? cur.updatedAt : 0;
    if (!cur || incT >= curT) {
      if (JSON.stringify(cur) !== JSON.stringify(inc)) {
        base[key] = inc;
        changed = true;
      }
    }
  }
  return changed;
}

/* ---------- вход через Telegram и роли ----------
   Виджет Telegram вызывает window.onTelegramAuth; подпись проверяем по
   sha256 токена бота (сам токен в коде не хранится!). Роль живёт в облаке:
   первый вошедший становится владельцем, владелец выдаёт редакторов.
   Права дополнительно режутся правилами базы (firebase-rules.json). */
var TG_SESSION_KEY = "weekly:tg-session:v1";
var tgSession = null;
var tgRoles = { owner: null, editors: {}, boundTg: null };
var pendingMap = {};
var tgRegisterState = "idle";

function localTelegramIdentity() {
  return { id: "local-demo", first_name: "Тестовый", last_name: "профиль",
    username: "weeqo_local", isLocalDemo: true };
}

function startLocalTelegramLogin() {
  if (!LOCAL_PREVIEW) return;
  tgSession = localTelegramIdentity();
  tgRoles = { owner: null, editors: {}, boundTg: null };
  saveTgSession();
  updateTgButton();
  if (state.profileOpen) openProfile();
  toast("тестовый вход · данные остаются в этом браузере");
}

function tgConfigured() {
  return Boolean(TELEGRAM_BOT_NAME && TELEGRAM_BOT_TOKEN_SHA256);
}

function tgDisplayName(user) {
  const full = [user.first_name, user.last_name].filter(Boolean).join(" ").trim();
  return full || (user.username ? "@" + user.username : "участник");
}

function hexToBytes(hex) {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
  return out;
}

async function hmacSha256Hex(keyBytes, text) {
  const key = await crypto.subtle.importKey("raw", keyBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(text));
  return Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

/* Подпись виджета: строка "key=value" по алфавиту через \n, HMAC-SHA256 от sha256(токена). */
async function verifyTgAuth(payload) {
  try {
    if (!payload || !payload.id || !payload.hash || !payload.auth_date) return false;
    /* OIDC-сессия (вход через telegram-login.js): вместо HMAC проверяем
       подпись JWT по публичным ключам Telegram (JWKS). */
    /* id_token живёт час, сессия — 30 дней: при перепроверке сохранённой
       сессии проверяем подпись и кле��мы, но не срок жизни токена. */
    if (payload.hash === "oidc") return Boolean(await verifyTgIdToken(payload.id_token, null, true));
    const keys = Object.keys(payload)
      .filter((k) => k !== "hash" && payload[k] !== undefined && payload[k] !== null && payload[k] !== "")
      .sort();
    const check = keys.map((k) => k + "=" + payload[k]).join("\n");
    const hex = await hmacSha256Hex(hexToBytes(TELEGRAM_BOT_TOKEN_SHA256), check);
    return hex === String(payload.hash).toLowerCase();
  } catch (e) {
    return false;
  }
}

/* ---------- вход через страницу oauth.telegram.org (как на csu) ----------
   Библиотека telegram-login.js открывает официальную страницу входа Telegram
   в попапе (на телефоне — с переходом в приложение), сама делает PKCE-обмен
   и возвращает готовый id_token через postMessage. Бэкенд не нужен: подпись
   JWT проверяем на клиенте по публичным ключам Telegram (JWKS). */
var TG_JWKS_URL = "https://oauth.telegram.org/.well-known/jwks.json";
var tgJwksCache = null;

function tgB64urlBytes(s) {
  s = String(s).replace(/-/g, "+").replace(/_/g, "/");
  while (s.length % 4) s += "=";
  return Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
}

function tgB64urlJson(s) {
  return JSON.parse(new TextDecoder().decode(tgB64urlBytes(s)));
}

/* Проверка id_token: подпись RS256 по JWKS + iss/aud/exp (+ nonce при свежем входе). */
/* Если JWKS не скачивается из браузера (CORS/сеть), проверить подпись нельзя.
   true — впускать по уже проверенным клеймам (iss/aud/exp/nonce),
   false — считать вход неудачным. Когда ключи доступны, подпись
   проверяется всегда. */
var TG_TRUST_CLAIMS_WHEN_JWKS_UNREACHABLE = true;

async function verifyTgIdToken(token, expectedNonce, allowExpired) {
  try {
    if (!token || !TELEGRAM_BOT_ID) { console.warn("tg-login: нет id_token или TELEGRAM_BOT_ID пуст"); return null; }
    const parts = String(token).split(".");
    if (parts.length !== 3) { console.warn("tg-login: id_token не похож на JWT"); return null; }
    const header = tgB64urlJson(parts[0]);
    const payload = tgB64urlJson(parts[1]);
    console.log("tg-login: header", header, "payload", payload);
    if (!header || header.alg !== "RS256" || !header.kid) {
      console.warn("tg-login: alg не RS256 (BotFather → Login Widget → Advanced):", header && header.alg);
      return null;
    }
    if (!payload || payload.iss !== "https://oauth.telegram.org") {
      console.warn("tg-login: iss не совпал:", payload && payload.iss);
      return null;
    }
    if (String(payload.aud) !== String(TELEGRAM_BOT_ID)) {
      console.warn("tg-login: aud не совпал:", JSON.stringify(payload.aud), "≠", JSON.stringify(String(TELEGRAM_BOT_ID)));
      return null;
    }
    if (!allowExpired && (!payload.exp || Number(payload.exp) * 1000 < Date.now())) {
      console.warn("tg-login: токен протух:", payload && payload.exp, "сейчас", Math.floor(Date.now() / 1000));
      return null;
    }
    if (expectedNonce && payload.nonce !== expectedNonce) {
      console.warn("tg-login: nonce не совпал:", JSON.stringify(payload.nonce), "≠", JSON.stringify(expectedNonce));
      return null;
    }
    let jwksUnreachable = false;
    async function fetchJwks() {
      try {
        const resp = await fetch(TG_JWKS_URL, { cache: "no-store" });
        if (!resp.ok) { jwksUnreachable = true; console.warn("tg-login: JWKS ответил", resp.status); return; }
        tgJwksCache = await resp.json();
      } catch (err) {
        jwksUnreachable = true;
        console.warn("tg-login: JWKS не скачался (CORS или сеть):", err);
      }
    }
    if (!tgJwksCache) await fetchJwks();
    let jwk = tgJwksCache && (tgJwksCache.keys || []).find((k) => k && k.kid === header.kid);
    if (!jwk) {
      /* ключ могли заротировать — сбрасываем кэш и пробуем ещё раз */
      await fetchJwks();
      jwk = tgJwksCache && (tgJwksCache.keys || []).find((k) => k && k.kid === header.kid);
      if (!jwk) {
        if (jwksUnreachable && TG_TRUST_CLAIMS_WHEN_JWKS_UNREACHABLE) {
          console.warn("tg-login: подпись НЕ проверялась (JWKS недоступен) — впускаю по клеймам");
          return payload;
        }
        console.warn("tg-login: ключ не найден в JWKS:", header.kid);
        return null;
      }
    }
    const key = await crypto.subtle.importKey(
      "jwk",
      jwk,
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["verify"]
    );
    const data = new TextEncoder().encode(parts[0] + "." + parts[1]);
    const ok = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, tgB64urlBytes(parts[2]), data);
    if (!ok) console.warn("tg-login: подпись RS256 не сошлась");
    return ok ? payload : null;
  } catch (e) {
    console.warn("tg-login: исключение при проверке:", e);
    return null;
  }
}

/* Сессия weeqo из клеймов OIDC id_token. */
function oidcSessionFromPayload(payload, idToken) {
  return {
    id: Number(payload.id || payload.sub),
    first_name: payload.given_name || payload.name || "",
    last_name: payload.family_name || "",
    username: payload.preferred_username || "",
    photo_url: payload.picture || "",
    auth_date: Number(payload.iat) || Math.floor(Date.now() / 1000),
    hash: "oidc",
    id_token: idToken,
  };
}

var tgLoginLibLoading = false;

/* Библиотека входа грузится заранее (при открытии профиля/шторки), чтобы
   по клику попап открывался сразу — в жесте пользователя, иначе браузер
   может заблокировать окно. */
function preloadTgLoginLib() {
  if (!TELEGRAM_BOT_ID) return;
  if ((window.Telegram && window.Telegram.Login) || tgLoginLibLoading) return;
  tgLoginLibLoading = true;
  const s = document.createElement("script");
  s.src = "https://oauth.telegram.org/js/telegram-login.js";
  s.onload = () => {
    tgLoginLibLoading = false;
  };
  s.onerror = () => {
    tgLoginLibLoading = false;
  };
  document.head.appendChild(s);
}

/* Открывает официальную страницу входа Telegram (та же, что на csu.noteven.dev). */
function startOidcLogin() {
  if (LOCAL_PREVIEW) { startLocalTelegramLogin(); return; }
  if (!TELEGRAM_BOT_ID) return false;
  const run = () => {
    try {
      const nonce = String(Date.now()) + "x" + Math.random().toString(36).slice(2);
      Telegram.Login.auth(
        { client_id: Number(TELEGRAM_BOT_ID), scope: ["profile"], nonce: nonce },
        (data) => {
          if (!data) return; /* окно закрыли без входа */
          if (data.error) {
            console.warn("tg-login: ошибка от Telegram:", data.error);
            toast("вход не удался — попробуй ещё раз");
            return;
          }
          if (!data.id_token) { console.warn("tg-login: в ответе нет id_token:", data); return; }
          verifyTgIdToken(data.id_token, nonce).then((payload) => {
            if (!payload || !(payload.id || payload.sub)) {
              toast("вход не подтвердился — попробуй ещё раз");
              return;
            }
            applyTgSession(oidcSessionFromPayload(payload, data.id_token));
          });
        }
      );
    } catch (e) {
      toast("не получилось открыть вход — проверь интернет");
    }
  };
  if (window.Telegram && window.Telegram.Login) {
    run();
  } else {
    /* Библиотека ещё не успела загрузиться — догружаем и ждём её. */
    preloadTgLoginLib();
    toast("секунду…");
    const wait = window.setInterval(() => {
      if (window.Telegram && window.Telegram.Login) {
        window.clearInterval(wait);
        run();
      }
    }, 120);
    window.setTimeout(() => window.clearInterval(wait), 8000);
  }
  return true;
}

function saveTgSession() {
  if (LOCAL_PREVIEW) {
    try {
      if (tgSession?.isLocalDemo) sessionStorage.setItem(LOCAL_TG_KEY, "1");
      else sessionStorage.removeItem(LOCAL_TG_KEY);
    } catch (e) { /* приватный режим */ }
    return;
  }
  try {
    if (tgSession) localStorage.setItem(TG_SESSION_KEY, JSON.stringify(tgSession));
    else localStorage.removeItem(TG_SESSION_KEY);
  } catch (e) {
    /* приватный режим */
  }
}

/* Вход через приложение Telegram: после подтверждения виджет возвращает
   на data-auth-url с параметрами (?id=...&hash=...) — завершаем вход здесь. */
function checkTgAuthRedirect() {
  if (LOCAL_PREVIEW) return;
  try {
    let raw = window.location.search;
    if (raw.indexOf("id=") === -1 && window.location.hash.indexOf("id=") !== -1)
      raw = "?" + window.location.hash.replace(/^#/, "");
    if (raw.indexOf("id=") === -1) return;
    const q = new URLSearchParams(raw);
    if (!q.get("id") || !q.get("hash") || !q.get("auth_date")) return;
    const payload = {};
    ["id", "first_name", "last_name", "username", "photo_url", "auth_date", "hash"].forEach((k) => {
      const v = q.get(k);
      if (v !== null && v !== "") payload[k] = v;
    });
    payload.id = Number(payload.id);
    payload.auth_date = Number(payload.auth_date);
    verifyTgAuth(payload).then((ok) => {
      /* Чистим адресную строку в любом случае, чтобы параметры не висели в URL. */
      window.history.replaceState({}, document.title, window.location.origin + window.location.pathname);
      if (!ok) {
        toast("вход не подтвердился — попробуй ещё раз");
        return;
      }
      if (tgSession && String(tgSession.id) === String(payload.id)) return; /* уже вошли */
      applyTgSession(payload);
    });
  } catch (e) {
    /* кривые параметры — игнорируем */
  }
}

function loadTgSession() {
  if (LOCAL_PREVIEW) {
    try { if (sessionStorage.getItem(LOCAL_TG_KEY) === "1") tgSession = localTelegramIdentity(); } catch (e) {}
    return;
  }
  try {
    const raw = localStorage.getItem(TG_SESSION_KEY);
    if (!raw) return;
    const data = JSON.parse(raw);
    if (!data || !data.id || !data.hash || !data.auth_date) return;
    /* Сессия живёт 30 дней, потом попросим войти заново. */
    if (Math.abs(Date.now() / 1000 - Number(data.auth_date)) > 30 * 86400) return;
    tgSession = data;
    /* Фоново перепроверяем подпись — мало ли, кто-то правил localStorage. */
    verifyTgAuth(data).then((ok) => {
      if (!ok) tgLogout();
      else tgSyncRoles(); /* роли самовосстанавливаются при перезагрузке */
    });
  } catch (e) {
    /* приватный режим */
  }
}

function tgLogout() {
  tgSession = null;
  tgRoles = { owner: tgRoles.owner, editors: tgRoles.editors, boundTg: null };
  tgRegisterState = "idle";
  pendingMap = {};
  saveTgSession();
  updateTgButton();
}

/* Общее завершение входа: сессия, UI, роли. */
function applyTgSession(payload) {
  tgSession = payload;
  tgRegisterState = "idle";
  saveTgSession();
  updateTgButton();
  renderTgSheetBody();
  if (state.profileOpen) openProfile();
  toast("привет, " + tgDisplayName(payload) + "!");
  tgSyncRoles().then(() => {
    pullSharedSwaps();
    if (loadNotifPrefs().telegram) syncTgSub();
  });
}

window.onTelegramAuth = function (payload) {
  verifyTgAuth(payload).then((ok) => {
    if (!ok) {
      toast("вход не подтвердился — попробуй ещё раз");
      return;
    }
    applyTgSession(payload);
  });
};

function myRole() {
  if (!tgSession) return "anon";
  /* Тестовый вход — это владелец: полный доступ к правкам и публикациям. */
  if (tgSession.isLocalDemo) return "owner";
  if (LOCAL_PREVIEW) return "user";
  const tg = String(tgRoles.boundTg || tgSession.id);
  /* Роль из конфига (variables) сильнее облачной — работает даже при пустой базе. */
  if (TELEGRAM_OWNER_ID && tg === TELEGRAM_OWNER_ID) return "owner";
  if (TELEGRAM_ADMIN_IDS.indexOf(tg) !== -1) return "editor";
  if (tgRoles.owner && String(tgRoles.owner) === tg) return "owner";
  if (tgRoles.editors && tgRoles.editors[tg]) return "editor";
  return "user";
}

function swapPrimaryLabel() {
  const role = myRole();
  if (role === "owner" || role === "editor") return "опубликовать";
  if (role === "user") return "предложить";
  return "сохранить �� себя";
}

function swapAccessHint() {
  if (!sharedSwapsEnabled()) return "";
  const role = myRole();
  if (role === "anon") {
    return '<p class="weekly-replace-hint">сохранится только на этом устройстве. войди через Telegram (шестерёнка → аккаунт) — замена уйдёт редактору на проверку и станет общей</p>';
  }
  if (role === "user") {
    return '<p class="weekly-replace-hint">у тебя применится сразу, всем остальным — после проверки редактором</p>';
  }
  return "";
}

/* Регистрация: привязываем анонимный uid устройства к Telegram id (один раз),
   первый вошедший клеймит владельца. Права проверяются правилами базы. */
async function tgRegister() {
  if (LOCAL_PREVIEW) return;
  if (tgRegisterState === "done" || tgRegisterState === "pending") return;
  tgRegisterState = "pending";
  try {
    const fbOn = firebaseAuthEnabled();
    if (fbOn) {
      const token = await ensureFbToken();
      if (!token || !fbAuth.uid) {
        console.warn("tg-roles: нет firebase-сессии — проверь FIREBASE_API_KEY и что в Firebase включён Anonymous (Authentication → Sign-in method)");
        throw new Error("нет firebase-сессии");
      }
    } else {
      console.warn("tg-roles: firebase auth не настроен — роли пишутся без токена");
    }
    const mine = String(tgSession.id);
    const deviceKey = fbAuth.uid || "tg-" + mine;
    const regUrl = await sharedUrlWithAuth(cloudRoot() + "/weeqo-users/" + deviceKey + ".json");
    const regResp = await fetch(regUrl, { headers: { Accept: "application/json" }, cache: "no-store" });
    if (!regResp.ok) console.warn("tg-roles: чтение привяз����и отклонено базой:", regResp.status);
    const bound = regResp.ok ? await regResp.json() : null;
    if (bound === null) {
      const put = await fetch(regUrl, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(mine),
      });
      if (!put.ok) {
        console.warn("tg-roles: регистрация отклонена базой:", put.status, "— опубликуй правила из firebase-rules.json в Firebase Console");
        throw new Error("регистрация отклонена: " + put.status);
      }
      tgRoles.boundTg = mine;
    } else {
      /* На этом устройстве уже входили в другой Telegram — права по старой привязке. */
      tgRoles.boundTg = String(bound);
    }
    const ownerUrl = await sharedUrlWithAuth(cloudRoot() + "/weeqo-meta/owner.json");
    const ownerResp = await fetch(ownerUrl, { headers: { Accept: "application/json" }, cache: "no-store" });
    if (!ownerResp.ok) console.warn("tg-roles: чтение owner отклонено базой:", ownerResp.status);
    const owner = ownerResp.ok ? await ownerResp.json() : null;
    if (owner === null) {
      /* Правила пропускают только самую первую запись — гонка не страшна. */
      const claim = await fetch(ownerUrl, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(tgRoles.boundTg),
      });
      if (claim.ok) console.log("tg-roles: место владельца было свободно — теперь это ты");
      else console.warn("tg-roles: база отклонила запись владельца:", claim.status);
    } else if (String(owner) === String(tgRoles.boundTg)) {
      console.log("tg-roles: владелец — это ты");
    } else {
      console.warn("tg-roles: владелец уже занят другим id. Если это ошибка — удали узел weeqo-meta/owner в Firebase Console и перезагрузи страницу первым");
    }
    tgRegisterState = "done";
  } catch (e) {
    tgRegisterState = "idle"; /* повторим в следующий тик опроса */
    throw e;
  }
}

/* Промис, который резолвится, когда синк ролей завершился (любым исходом).
   Публикации ждут его: правила требуют, чтобы регистрация уже лежала в базе. */
var tgRolesReadyResolve;
var tgRolesReady = new Promise(function (resolve) { tgRolesReadyResolve = resolve; });
function waitTgRoles() {
  return Promise.race([tgRolesReady, new Promise(function (r) { setTimeout(r, 8000); })]);
}

async function tgSyncRoles() {
  /* Роли живут в облаке (SHARED_SWAPS_URL), а не в конфиге виджета. Раньше тут
     стоял tgConfigured(), и при OIDC-входе синк молча пропускался —
     владелец не назначался никому. */
  if (!tgSession || !sharedSwapsEnabled()) { tgRolesReadyResolve(); return; }
  try {
    await tgRegister();
    const root = cloudRoot();
    const [ownerResp, editorsResp] = await Promise.all([
      fetch(await sharedUrlWithAuth(root + "/weeqo-meta/owner.json"), { headers: { Accept: "application/json" }, cache: "no-store" }),
      fetch(await sharedUrlWithAuth(root + "/weeqo-editors.json"), { headers: { Accept: "application/json" }, cache: "no-store" }),
    ]);
    if (ownerResp.ok) tgRoles.owner = await ownerResp.json();
    else console.warn("tg-roles: не смог прочитать владельца:", ownerResp.status);
    const editors = editorsResp.ok ? await editorsResp.json() : null;
    tgRoles.editors = editors && typeof editors === "object" ? editors : {};
    updateTgButton();
  } catch (e) {
    console.warn("tg-roles: синк ролей не удался (офлайн или база отклонила):", e);
  } finally {
    tgRolesReadyResolve();
  }
}

/* Корень базы без имени файла: из ".../weeqo-swaps.json" делаем "...". */
function cloudRoot() {
  return sharedSwapsUrl().replace(/\/[^/]*\.json.*$/, "");
}

/* В ключах замен есть "/" (группы вида "т��-303/б") и могут быть точки —
   Firebase такое в ключах не принимает поэтому кодируем. */
function encodeSwapKey(key) {
  /* Слеш в ключе (тм-303/б|...) для Firebase — разделитель пути: %2F в REST
     раскодируется обратно в "/", запись уходит глубже $key, и .validate правил
     проверяет родительскую мапу вместо записи — отсюда вечный 401. Заменяем
     "/" на "~" (разрешён в ключах Firebase) и получаем плоский ключ. Точки
     по-прежнему экранируем — они в ключах Firebase запрещены. */
  return encodeURIComponent(String(key).replace(/\//g, "~")).replace(/\./g, "%2E");
}
function decodeSwapKey(enc) {
  try {
    return decodeURIComponent(enc).replace(/~/g, "/");
  } catch (e) {
    return enc;
  }
}

function decodeSwapEntries(data) {
  const out = {};
  for (const enc in data) out[decodeSwapKey(enc)] = data[enc];
  return out;
}

/* Единая точка записи: PUT с телом или DELETE (body === null). true = база приняла. */
/* Статус последней ошибки облака: 401/403 = права/правила, -1 = сеть. */
var lastCloudStatus = 0;

async function cloudWrite(path, body) {
  if (LOCAL_PREVIEW) return false;
  try {
    const url = await sharedUrlWithAuth(cloudRoot() + "/" + path + ".json");
    const resp = await fetch(
      url,
      body === null
        ? { method: "DELETE" }
        : { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }
    );
    if (!resp.ok) {
      lastCloudStatus = resp.status;
      console.warn("weeqo: база отклонила запись (" + resp.status + ") " + path +
        (resp.status === 401 || resp.status === 403
          ? " — опубликуй правила из firebase-rules.json (Realtime Database → Правила) и включи Anonymous в Authentication → Sign-in method"
          : ""));
      if (resp.status === 401 || resp.status === 403) diagnoseCloudWrite();
    } else {
      lastCloudStatus = 0;
    }
    return resp.ok;
  } catch (e) {
    lastCloudStatus = -1;
    return false;
  }
}

/* Тост при неудачной записи: при 401/403 дело в правах базы, а не в интернете. */
function cloudFailHint() {
  if (lastCloudStatus === 401 || lastCloudStatus === 403)
    return "база отклонила запись (" + lastCloudStatus + ") — проверь правила Firebase и Anonymous-вход";
  return "не отправилось — проверь интернет";
}

/* Разбор 401/403 при живом токене: какое именно условие пр��вил не сошлось. */
async function diagnoseCloudWrite() {
  if (diagnoseCloudWrite._ran) return;
  diagnoseCloudWrite._ran = true;
  if (!firebaseAuthEnabled() || !fbAuth.uid) return;
  try {
    const root = cloudRoot();
    const probe = async (p) => {
      const r = await fetch(await sharedUrlWithAuth(root + "/" + p), { headers: { Accept: "application/json" }, cache: "no-store" });
      return { status: r.status, data: r.ok ? await r.json().catch(() => null) : null };
    };
    const users = await probe("weeqo-users.json");
    if (users.status === 401 || users.status === 403) {
      console.warn("weeqo-диагностика: чтение weeqo-users С ТОКЕНОМ отклонено (" + users.status + ") — значит правила реально не опубликованы. Realtime Database → Правила → вставь текст firebase-rules.json → Опубликовать.");
      return;
    }
    const me = await probe("weeqo-users/" + fbAuth.uid + ".json");
    const owner = await probe("weeqo-meta/owner.json");
    if (!me.data) {
      console.warn("weeqo-диагностика: правила опубликованы, но твоей регистрации нет (weeqo-users/" + fbAuth.uid + " пуст) — запись её не прошла. Ищи выше строку tg-roles с причиной и пришли скрин консоли.");
    } else if (owner.data == null) {
      console.warn("weeqo-диагностика: ты зарегистрирован (" + me.data + "), но место владельца пустое — перезагрузи страницу, приложение займёт его само.");
    } else if (String(owner.data) !== String(me.data)) {
      console.warn("weeqo-диагностика: владелец в базе = " + JSON.stringify(owner.data) + ", а твоя привязка = " + JSON.stringify(me.data) + ". Если это ошибка (например, узел создан руками) — удали weeqo-meta/owner в Firebase Console (Realtime Database → Данные) и перезагрузи страницу первым.");
    } else {
      console.warn("weeqo-диагностика: ты зарегистрирован и ты владелец (" + owner.data + "), а запись всё равно отклонена — опубликованные правила отличаются от firebase-rules.json. Сверь вкладку «Правила» посимвольно и пришли её скрин.");
    }
  } catch (e) {
    /* диагностика не обязана срабатывать */
  }
}

/* Приводим запись к виду, который пропускает .validate в правилах базы:
   updatedAt — число не из будущего, строки — строками и в пределах лимитов. */
function sanitizeSwapPayload(entry) {
  const e = Object.assign({}, entry);
  delete e.pendingSync;
  if (typeof e.updatedAt !== "number" || !isFinite(e.updatedAt) || e.updatedAt > Date.now() + 60000)
    e.updatedAt = Date.now();
  ["subject", "teacher", "room", "by", "byName"].forEach((k) => {
    if (e[k] != null && typeof e[k] !== "string") e[k] = String(e[k]);
  });
  if (typeof e.subject === "string") e.subject = e.subject.slice(0, 120);
  if (typeof e.teacher === "string") e.teacher = e.teacher.slice(0, 120);
  if (typeof e.room === "string") e.room = e.room.slice(0, 40);
  return e;
}

/* Редактор/владелец: замена уходит сразу в опубликованные, по одной записи. */
async function pushSwapEntry(key, entry) {
  await waitTgRoles();
  const payload = sanitizeSwapPayload(entry);
  if (tgSession) {
    payload.by = String(tgSession.id);
    payload.byName = tgDisplayName(tgSession);
  }
  const ok = await cloudWrite("weeqo-swaps/" + encodeSwapKey(key), payload);
  if (ok) {
    if (entry.pendingSync) {
      delete entry.pendingSync;
      saveSwaps();
    }
  } else {
    entry.pendingSync = true;
    saveSwaps();
  }
  return ok;
}

/* Обычный участник: замена уходит заявкой на проверку. */
async function proposeSwapEntry(key, entry) {
  if (!tgSession) return false;
  await waitTgRoles();
  const payload = sanitizeSwapPayload(Object.assign({}, entry, {
    by: String(tgSession.id),
    byName: tgDisplayName(tgSession),
  }));
  const ok = await cloudWrite("weeqo-pending/" + encodeSwapKey(key), payload);
  if (!ok) toast(cloudFailHint());
  return ok;
}

/* Куда уходит замена после сохранения — зависит от роли. */
function publishSwapKey(key) {
  if (!sharedSwapsEnabled()) return;
  const entry = loadSwaps()[key];
  if (!entry) return;
  const role = myRole();
  if (role === "owner" || role === "editor") {
    pushSwapEntry(key, entry);
  } else if (role === "user") {
    proposeSwapEntry(key, entry).then((ok) => {
      if (ok) toast("отправлено на проверку");
    });
  }
  /* anon: остаётся локально, подсказка уже есть в окне замены */
}

async function pullPending() {
  try {
    const resp = await fetch(await sharedUrlWithAuth(cloudRoot() + "/weeqo-pending.json"), {
      headers: { Accept: "application/json" },
      cache: "no-store",
    });
    const data = resp.ok ? await resp.json() : null;
    pendingMap = data && typeof data === "object" ? data : {};
    notifyAboutPending();
  } catch (e) {
    /* офлайн */
  }
  updateTgButton();
  renderTgSheetBody();
}

async function approvePending(enc) {
  const entry = pendingMap[enc];
  if (!entry) return;
  const ok = await cloudWrite("weeqo-swaps/" + enc, entry);
  if (!ok) {
    toast("не получилось опубликовать");
    return;
  }
  await cloudWrite("weeqo-pending/" + enc, null);
  delete pendingMap[enc];
  /* Применяем локально сразу, не дожидаясь опроса. */
  const map = loadSwaps();
  const key = decodeSwapKey(enc);
  const cur = map[key];
  if (!cur || typeof cur.updatedAt !== "number" || cur.updatedAt <= entry.updatedAt) {
    map[key] = Object.assign({}, entry);
    saveSwaps();
  }
  updateTgButton();
  renderTgSheetBody();
  render();
  toast("замена опубликована");
}

async function rejectPending(enc) {
  const ok = await cloudWrite("weeqo-pending/" + enc, null);
  if (!ok) {
    toast("не получилось отклонить");
    return;
  }
  delete pendingMap[enc];
  updateTgButton();
  renderTgSheetBody();
}

async function grantEditor(tgId, name) {
  const ok = await cloudWrite("weeqo-editors/" + tgId, name || "редактор");
  if (!ok) {
    toast("не получилось выдать доступ");
    return;
  }
  toast("редактор добавлен");
  await tgSyncRoles();
  renderTgSheetBody();
}

async function revokeEditor(tgId) {
  const ok = await cloudWrite("weeqo-editors/" + tgId, null);
  if (!ok) {
    toast("не получилось убрать");
    return;
  }
  await tgSyncRoles();
  renderTgSheetBody();
}

/* Копирование telegram id в буфер: современный API + запасной через textarea. */
function copyTextToClipboard(text) {
  const done = () => toast("id скопирован");
  const fallback = () => {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    try {
      document.execCommand("copy");
      done();
    } catch (e) {
      toast("не скопировалось — id: " + text);
    }
    ta.remove();
  };
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(done, fallback);
  } else {
    fallback();
  }
}

/* ---------- тосты ---------- */
function toast(text) {
  let container = document.getElementById("weeqo-toast-container");
  if (!container) {
    container = document.createElement("div");
    container.id = "weeqo-toast-container";
    container.setAttribute("aria-live", "polite");
    document.body.appendChild(container);
  }
  const item = document.createElement("div");
  item.className = "weeqo-toast-item";
  item.textContent = text;
  container.appendChild(item);

  window.requestAnimationFrame(() => {
    item.classList.add("is-visible");
  });

  while (container.children.length > 5) {
    container.removeChild(container.firstChild);
  }

  window.setTimeout(() => {
    item.classList.remove("is-visible");
    item.classList.add("is-leaving");
    window.setTimeout(() => {
      if (item.parentNode) item.parentNode.removeChild(item);
    }, 240);
  }, 2600);
}

async function pullSharedSwaps() {
  const url = sharedSwapsUrl();
  if (!url) return;
  /* Пока открыт редактор замены, сеть не дёргаем, чтобы не потерять ввод. */
  if (document.getElementById("swap-backdrop")) return;
  try {
    const resp = await fetch(await sharedUrlWithAuth(url), { headers: { Accept: "application/json" }, cache: "no-store" });
    if ((resp.status === 401 || resp.status === 403) && !pullSharedSwaps._warned) {
      /* Один раз за сессию подсвечиваем в консоли, почему облако молчит. */
      pullSharedSwaps._warned = true;
      console.warn("weeqo: облако отклоняет чтение (" + resp.status + ") — опубликуй правила из firebase-rules.json в Firebase Console и включи Anonymous-вход");
    }
    let remote = {};
    if (resp.ok) {
      const data = await resp.json();
      if (data && typeof data === "object") remote = decodeSwapEntries(data);
    }
    notifyAboutRemoteSwaps(remote);
    const map = loadSwaps();
    const changedLocal = mergeSwapMaps(map, remote) || pruneSwapMap(map);
    if (changedLocal) {
      saveSwaps();
      if (!scrub && !document.getElementById("swap-backdrop")) render();
    }
    /* Редакторы дожимают записи, не ушедшие из-за офлайна. */
    if (myRole() === "owner" || myRole() === "editor") {
      for (const key in map) {
        if (map[key] && map[key].pendingSync) pushSwapEntry(key, map[key]);
      }
    }
  } catch (e) {
    /* офлайн — повторим в следующий тик */
  }
  if (tgSession && sharedSwapsEnabled()) {
    await tgSyncRoles();
    if (myRole() === "owner" || myRole() === "editor") pullPending();
  }
}

/* ---------- окно Telegram: вход, заявки, редакторы ---------- */

function updateTgButton() {
  /* Вход живёт в профиле (шестерёнка → аккаунт); шестерёнка после входа
     становится аватаркой. */
  updateSettingsAvatar();
  renderAccountRow();
}

/* Аватар из Telegram вместо шестерёнки настроек. */
function updateSettingsAvatar() {
  const trigger = document.getElementById("settings-trigger");
  if (!trigger) return;
  const url = tgSession && tgSession.photo_url ? String(tgSession.photo_url) : "";
  let img = trigger.querySelector("img.weekly-trigger-avatar");
  if (url) {
    if (!img) {
      img = document.createElement("img");
      img.className = "weekly-trigger-avatar";
      img.alt = "";
      trigger.appendChild(img);
    }
    if (img.getAttribute("src") !== url) img.setAttribute("src", url);
    trigger.classList.add("is-avatar");
  } else {
    if (img) img.remove();
    trigger.classList.remove("is-avatar");
  }
}

/* Строка аккаунта в самом верху настроек и строки управления (заявки/отчёты). */
function renderAccountRow() {
  const title = document.getElementById("account-title");
  if (!title) return;
  const hint = document.getElementById("account-hint");
  const icon = document.getElementById("account-icon");
  const role = myRole();
  const canReview = role === "owner" || role === "editor";
  const pendingCount = Object.keys(pendingMap).length;

  if (tgSession) {
    title.textContent = tgDisplayName(tgSession);
    const roleLabel = tgSession?.isLocalDemo ? "владелец" : role === "owner" ? "владелец" : role === "editor" ? "редактор" : "студент";
    if (hint) hint.textContent = roleLabel + (tgSession.username ? " · @" + tgSession.username : "");
    if (icon && tgSession.photo_url)
      icon.innerHTML = '<img class="weekly-account-avatar" src="' + escapeHtml(String(tgSession.photo_url)) + '" alt="">';
  } else {
    title.textContent = "профиль";
    if (hint) hint.textContent = tgConfigured() ? "группа, уведомления, вход через telegram" : "группа и уведомления";
  }

  const tgBtn = document.getElementById("go-tg-sheet");
  if (tgBtn) {
    tgBtn.hidden = !canReview;
    const pHint = document.getElementById("settings-pending-hint");
    if (pHint) pHint.textContent = pendingCount ? "ждут проверки: " + pendingCount : "проверка замен и права";
  }

  const repBtn = document.getElementById("go-reports-sheet");
  if (repBtn) {
    repBtn.hidden = role !== "owner";
  }
}

function mountTelegramWidget(container) {
  if (!container) return;
  container.innerHTML = "";
  const script = document.createElement("script");
  script.src = "https://telegram.org/js/telegram-widget.js?22";
  script.setAttribute("data-telegram-login", TELEGRAM_BOT_NAME);
  script.setAttribute("data-size", "large");
  script.setAttribute("data-onauth", "onTelegramAuth");
  /* Возврат из приложения Telegram: виджет редиректит на страницу с параметрами
     входа (?id=...&hash=...), их при загрузке ловит checkTgAuthRedirect(). */
  script.setAttribute("data-auth-url", window.location.origin + window.location.pathname);
  script.async = true;
  container.appendChild(script);
}

function closeTgSheet() {
  const backdrop = document.getElementById("tg-backdrop");
  if (!backdrop) return;
  backdrop.classList.remove("is-open");
  window.setTimeout(() => backdrop.remove(), 180);
}

function pendingRowHtml(enc, entry, role) {
  const key = decodeSwapKey(enc);
  const m = key.match(/\|(\d{4}-\d{2}-\d{2}):(\d+)$/);
  let when = key;
  if (m) when = dateLabel(dateFromIso(m[1])) + " · " + m[2] + " пара";
  let what = "изменение";
  if (entry.deleted) what = "сброс замены";
  else if (entry.cancelled) what = "отмена пары";
  else {
    const parts = [entry.subject, entry.teacher, entry.room].filter(Boolean);
    if (parts.length) what = parts.join(" · ");
  }
  const who = entry.byName || "без имени";
  /* Сегмент пары без времени: предмет, преподаватель · кабинет, «N пара · 1 ч 35 мин». */
  const frag = m ? buildNotifFrag(key, entry) : null;
  const dur = frag ? lessonDurationLabel(frag.d, frag.n) : "";
  const segHtml = frag
    ? '<div class="weekly-pending-segment">' +
      "<strong>" + escapeHtml(frag.subject || frag.n + " пара") + "</strong>" +
      ([frag.teacher, frag.room].filter(Boolean).length
        ? "<span>" + escapeHtml([frag.teacher, frag.room].filter(Boolean).join(" · ")) + "</span>"
        : "") +
      "<small>" + escapeHtml(frag.n + " пара" + (dur ? " · " + dur : "")) + "</small>" +
      "</div>"
    : "";
  let actions =
    '<button class="is-primary" type="button" data-tg="approve" data-key="' + escapeHtml(enc) + '">принять</button>' +
    '<button type="button" data-tg="reject" data-key="' + escapeHtml(enc) + '">отклонить</button>';
  if (role === "owner" && entry.by && entry.by !== String(tgRoles.owner) && !tgRoles.editors[entry.by]) {
    actions +=
      '<button type="button" data-tg="grant" data-key="' + escapeHtml(enc) + '" data-tgid="' +
      escapeHtml(String(entry.by)) + '">+ редактор</button>';
  }
  return (
    '<div class="weekly-tg-row"><div class="weekly-tg-row-text"><strong>' + escapeHtml(what) + "</strong>" +
    segHtml +
    "<span>" + escapeHtml(when) + " · предложил(а): " + escapeHtml(who) + "</span>" +
    '</div><div class="weekly-tg-row-actions">' + actions + "</div></div>"
  );
}

/* Контент окна Telegram; inline=true — панель внутри профиля (без шапки и нижних кнопок). */
function tgSheetBodyHtml(inline) {
  const role = myRole();
  let html = "";
  if (!inline) {
    const roleLabel = tgSession?.isLocalDemo ? "владелец" : role === "owner" ? "владелец" : role === "editor" ? "редактор" : "студент";
    html +=
      '<div class="weekly-replace-head"><strong>' + escapeHtml(tgDisplayName(tgSession)) + "</strong><span>" + roleLabel + "</span></div>";
  }
  if (role === "user")
    html +=
      '<p class="weekly-replace-hint"><button type="button" class="weekly-tg-copy-id" data-tg="copy-id" data-id="' +
      escapeHtml(String(tgSession.id)) +
      '" title="нажми, чтобы скопировать">мой id: <b>' +
      escapeHtml(String(tgSession.id)) +
      "</b></button></p>";
  if (role === "owner" || role === "editor") {
    const keys = Object.keys(pendingMap).sort((a, b) => (pendingMap[b].updatedAt || 0) - (pendingMap[a].updatedAt || 0));
    html += '<div class="weekly-tg-section"><span>заявки (' + keys.length + ")</span>";
    if (!keys.length) html += '<p class="weekly-replace-hint">пока пусто</p>';
    keys.forEach((enc) => {
      html += pendingRowHtml(enc, pendingMap[enc], role);
    });
    html += "</div>";
  }
  if (role === "owner") {
    const ids = Object.keys(tgRoles.editors);
    html += '<div class="weekly-tg-section is-editors"><span>редакторы</span>';
    if (!ids.length) html += '<p class="weekly-replace-hint">пока нет. добавь по id ниже или кнопкой «+ редактор» в любой заявке.</p>';
    ids.forEach((tg) => {
      html +=
        '<div class="weekly-tg-row"><div class="weekly-tg-row-text"><strong>' + escapeHtml(String(tgRoles.editors[tg])) +
        '</strong><span>id: ' + escapeHtml(String(tg)) + '</span></div><div class="weekly-tg-row-actions"><button type="button" data-tg="revoke" data-tgid="' +
        escapeHtml(tg) + '">убрать</button></div></div>';
    });
    html +=
      '<div class="weekly-tg-add"><input type="text" inputmode="numeric" id="tg-add-editor-id" placeholder="id редактора" autocomplete="off">' +
      '<button type="button" data-tg="add-editor">добавить</button></div>' +
      '<p class="weekly-replace-hint weekly-tg-add-hint">человек видит свой id у себя в профиле — строка «мой id», по тапу копируется.</p>' +
      '<p class="weekly-replace-hint weekly-tg-add-hint">редактор проверяет заявки, а его замены уходят всем сразу.</p>';
    html += "</div>";
  }
  if (inline) return html;
  html +=
    '<div class="weekly-replace-actions"><button type="button" data-tg="logout">выйти</button>' +
    '<button type="button" data-tg="close">закрыть</button></div>';
  return html;
}

function renderTgSheetBody() {
  const body = document.getElementById("tg-sheet-body");
  const inline = document.getElementById("profile-tg-inline");
  if (!body && !inline) return;
  if (!tgSession) {
    if (body) {
      body.innerHTML =
        '<div class="weekly-replace-head"><strong>вход через Telegram</strong><span>чтобы предлагать замены</span></div>' +
        (TELEGRAM_BOT_ID
          ? '<div class="weekly-tg-widget"><button type="button" class="weekly-profile-auth-btn" data-tg="oidc-login">' +
            '<span class="weekly-profile-auth-icon">' + ICON_LOGIN + "</span>" +
            '<span class="weekly-profile-auth-text"><strong>войти через Telegram</strong><small>общие замены и синхронизация профиля</small></span>' +
            ICON_CHEVRON + "</button></div>"
          : '<div class="weekly-tg-widget" id="tg-widget-mount"></div>') +
        '<p class="weekly-replace-hint">кнопка работает на опубликованном сайте. после входа твои замены уходят редактору на проверку.</p>' +
        '<div class="weekly-replace-actions"><button type="button" data-tg="close">закрыть</button></div>';
      if (!TELEGRAM_BOT_ID) mountTelegramWidget(body.querySelector("#tg-widget-mount"));
      else preloadTgLoginLib();
    }
    if (inline) inline.innerHTML = "";
    return;
  }
  if (body) body.innerHTML = tgSheetBodyHtml(false);
  if (inline) inline.innerHTML = tgSheetBodyHtml(true);
}

function openTgSheet() {
  closeTgSheet();
  /* Шторка нужна и вошедшим (заявки/редакторы), пускаем при живой
     сессии или настроенном OIDC, а не только при старом виджете. */
  if (!tgConfigured() && !TELEGRAM_BOT_ID && !tgSession) {
    toast("вход через Telegram не настроен");
    return;
  }
  const backdrop = document.createElement("div");
  backdrop.id = "tg-backdrop";
  backdrop.className = "weekly-replace-backdrop";
  backdrop.innerHTML =
    '<div class="weekly-replace-sheet weekly-tg-sheet" role="dialog" aria-label="Telegram"><div id="tg-sheet-body"></div></div>';
  document.body.appendChild(backdrop);
  window.requestAnimationFrame(() => backdrop.classList.add("is-open"));
  backdrop.addEventListener("click", (e) => {
    if (e.target === backdrop) {
      closeTgSheet();
      return;
    }
    const el = e.target.closest("[data-tg]");
    if (!el) return;
    const act = el.dataset.tg;
    if (act === "close") closeTgSheet();
    else if (act === "copy-id") copyTextToClipboard(el.dataset.id || "");
    else if (act === "oidc-login") startOidcLogin();
    else if (act === "logout") {
      tgLogout();
      closeTgSheet();
      render();
    } else if (act === "approve") approvePending(el.dataset.key);
    else if (act === "reject") rejectPending(el.dataset.key);
    else if (act === "grant") {
      const entry = pendingMap[el.dataset.key] || {};
      grantEditor(el.dataset.tgid, entry.byName);
    } else if (act === "revoke") revokeEditor(el.dataset.tgid);
    else if (act === "add-editor") {
      const inp = document.getElementById("tg-add-editor-id");
      const id = inp ? inp.value.trim() : "";
      if (!/^\d{3,32}$/.test(id)) {
        toast("нужен числовой id — он есть в окне входа у человека");
        return;
      }
      grantEditor(id, "редактор " + id);
    }
  });
  renderTgSheetBody();
  if (myRole() === "owner" || myRole() === "editor") pullPending();
}

/* ---------- уведомления (колокольчик в шапке) ----------
   Лента в localStorage: кто-то опубликовал замену/отмену, обновилось базовое
   расписание, редактору пришла новая заявка. Бейдж = непрочитанные. */
var NOTIF_KEY = "weekly:notifs:v1";
var NOTIF_SEEN_SWAPS_KEY = "weekly:notif-seen-swaps:v1";
var NOTIF_SEEN_SCHEDULE_KEY = "weekly:notif-seen-schedule:v1";
var NOTIF_SEEN_PENDING_KEY = "weekly:notif-seen-pending:v1";
var notifList = null;

/* Настройки уведомлений: что показывать в колокольчике и дублировать в Telegram. */
var NOTIF_PREFS_KEY = LOCAL_PREVIEW ? "weekly:notif-prefs:local:v1" : "weekly:notif-prefs:v1";
var notifPrefs = null;

function loadNotifPrefs() {
  if (notifPrefs) return notifPrefs;
  notifPrefs = { swaps: true, schedule: true, pending: true, telegram: false };
  try {
    const raw = localStorage.getItem(NOTIF_PREFS_KEY);
    if (raw) {
      const data = JSON.parse(raw);
      if (data && typeof data === "object")
        for (const k in notifPrefs) if (typeof data[k] === "boolean") notifPrefs[k] = data[k];
    }
  } catch (e) {}
  return notifPrefs;
}

function saveNotifPrefs() {
  try {
    localStorage.setItem(NOTIF_PREFS_KEY, JSON.stringify(notifPrefs));
  } catch (e) {}
}

/* Переключатель категории уведомлений в профиле. */
function toggleNotifPref(key, el) {
  const p = loadNotifPrefs();
  if (!Object.prototype.hasOwnProperty.call(p, key)) return;
  if (LOCAL_PREVIEW && key === "telegram" && tgSession?.isLocalDemo) {
    p.telegram = !p.telegram;
    saveNotifPrefs();
    el?.setAttribute("aria-pressed", String(p.telegram));
    toast("локальный тест · сообщения не отправляются");
    return;
  }
  if (key === "telegram" && !p.telegram && !tgSession) {
    toast("сначала войди через Telegram — кнопка тут ��е, в профиле");
    return;
  }
  if (key === "telegram" && !p.telegram) {
    /* Памятка перед включением: бот не может написать первым,
       пока человек не нажал у него /start. */
    showTgMemo(() => {
      p.telegram = true;
      saveNotifPrefs();
      if (el) el.setAttribute("aria-pressed", "true");
      syncTgSub().then((ok) => {
        if (p.telegram) toast(ok ? "бот пришлёт уведомления лично" : "не получилось — проверь интернет");
      });
    });
    return;
  }
  p[key] = !p[key];
  saveNotifPrefs();
  if (el) el.setAttribute("aria-pressed", p[key] ? "true" : "false");
  if (key === "telegram") syncTgSub();
  else if (p.telegram) syncTgSub();
}

/* Памятка про /start при включении дублирования в Telegram. */
function showTgMemo(onConfirm) {
  closeTgMemo();
  const bot = "@" + (TELEGRAM_BOT_NAME || "weeqobot");
  const wrap = document.createElement("div");
  wrap.className = "weekly-tg-memo-backdrop";
  wrap.id = "tg-memo";
  wrap.innerHTML =
    '<div class="weekly-tg-memo" role="dialog" aria-label="памятка про телеграм-бота">' +
    '<span class="weekly-tg-memo-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21.9 4.6c.3-1.1-.8-2-1.9-1.6L2.6 10.4c-1 .4-.9 1.7.1 2l4.2 1.4 1.6 5c.3.9 1.4 1.1 2 .4l2.2-2.6 4 3c.7.5 1.8.1 2-.8l2.6-14.6z"/><path d="M7 14.5 18 6"/></svg></span>' +
    "<strong>напиши боту " + escapeHtml(bot) + " в телеграме /start</strong>" +
    "<p>телеграм не разрешает боту писать первым. открой " + escapeHtml(bot) + ' и напиши любое сообщение — иначе уведомления до тебя не дойдут.</p>' +
    '<div class="weekly-tg-memo-actions">' +
    (TELEGRAM_BOT_NAME ? '<a href="https://t.me/' + escapeHtml(TELEGRAM_BOT_NAME) + '" target="_blank" rel="noopener noreferrer">открыть бота</a>' : "") +
    '<button type="button" class="is-primary">понятно</button>' +
    "</div></div>";
  document.body.appendChild(wrap);
  wrap.addEventListener("click", (e) => {
    if (e.target === wrap) {
      closeTgMemo();
      return;
    }
    if (e.target.closest("button.is-primary")) {
      closeTgMemo();
      if (onConfirm) onConfirm();
    }
  });
}

function closeTgMemo() {
  const el = document.getElementById("tg-memo");
  if (el) el.remove();
}

/* Подписка на личные уведомления в Telegram: запись уходит в weeqo-tg-subs,
   а рассылает бот через GitHub Action (tools/notify_telegram.py). Перед
   включением человек жмёт /start у бота — иначе TG не даёт написать первым. */
async function syncTgSub() {
  if (!tgSession || !sharedSwapsEnabled()) return false;
  const prefs = loadNotifPrefs();
  const path = "weeqo-tg-subs/" + tgSession.id;
  if (!prefs.telegram) return cloudWrite(path, null);
  const role = myRole();
  return cloudWrite(path, {
    name: tgDisplayName(tgSession),
    swaps: !!prefs.swaps,
    schedule: !!prefs.schedule,
    pending: !!(prefs.pending && (role === "owner" || role === "editor")),
    updatedAt: Date.now(),
  });
}

function loadNotifs() {
  if (notifList) return;
  notifList = [];
  try {
    var raw = localStorage.getItem(NOTIF_KEY);
    if (raw) {
      var data = JSON.parse(raw);
      if (Array.isArray(data))
        notifList = data.filter(function (n) { return n && typeof n.text === "string" && typeof n.at === "number"; });
    }
  } catch (e) {
    notifList = [];
  }
}

function saveNotifs() {
  try {
    localStorage.setItem(NOTIF_KEY, JSON.stringify(notifList || []));
  } catch (e) {
    /* приватный режим */
  }
}

function pushNotif(text, kind, tone, frag) {
  const prefs = loadNotifPrefs();
  if (kind && prefs[kind] === false) return;
  loadNotifs();
  notifList.unshift({ text: text, at: Date.now(), read: false, tone: tone || null, frag: frag || null });
  if (notifList.length > 50) notifList.length = 50;
  saveNotifs();
  updateBellButton();
}

function updateBellButton() {
  var btn = document.getElementById("bell-btn");
  if (!btn) return;
  loadNotifs();
  var unread = 0;
  for (var i = 0; i < notifList.length; i++) if (!notifList[i].read) unread++;
  var badge = document.getElementById("bell-badge");
  if (badge) {
    badge.hidden = unread === 0;
    badge.textContent = String(unread);
  }
}

/* Текстовое описание записи замены для ленты. */
function describeSwapForNotif(key, entry) {
  var m = key.match(/\|(\d{4}-\d{2}-\d{2}):(\d+)$/);
  var n = m ? m[2] : "";
  var what = "замена";
  if (entry.deleted) what = "сброс замены";
  else if (entry.cancelled) what = "отмена пары";
  /* Дата не нужна в заголовке — она отображается в карточке пары (.weekly-notif-frag-day).
     Показываем: тип события · N пара · предмет (если есть) */
  var parts = [entry.subject, entry.teacher, entry.room].filter(Boolean);
  return what + (n ? " · " + n + " пара" : "") + (parts.length ? " · " + parts[0] : "");
}

/* Свежие записи из облака -> лента. Первый прогон только запоминает состояние. */
function notifyAboutRemoteSwaps(remote) {
  if (!remote || typeof remote !== "object") return;
  var seen = null;
  var firstRun = false;
  try {
    var raw = localStorage.getItem(NOTIF_SEEN_SWAPS_KEY);
    seen = raw ? JSON.parse(raw) : null;
  } catch (e) {
    seen = null;
  }
  if (!seen || typeof seen !== "object") {
    seen = {};
    firstRun = true;
  }
  var myId = tgSession ? String(tgSession.id) : null;
  var gprefix = (state.group || DEFAULT_GROUP) + "|";
  var changed = false;
  for (var key in remote) {
    var entry = remote[key];
    if (!entry || typeof entry !== "object") continue;
    var t = typeof entry.updatedAt === "number" ? entry.updatedAt : 0;
    if (!t) continue;
    var prev = typeof seen[key] === "number" ? seen[key] : 0;
    if (t <= prev) continue;
    seen[key] = t;
    changed = true;
    if (!firstRun && key.indexOf(gprefix) === 0 && (!myId || String(entry.by || "") !== myId)) {
      pushNotif(
        describeSwapForNotif(key, entry),
        "swaps",
        entry.deleted ? "reset" : entry.cancelled ? "cancel" : "swap",
        buildNotifFrag(key, entry)
      );
    }
  }
  if (changed) {
    try {
      localStorage.setItem(NOTIF_SEEN_SWAPS_KEY, JSON.stringify(seen));
    } catch (e) {}
  }
}

/* Новые заявки -> лента владельца/редактора. */
function notifyAboutPending() {
  var role = myRole();
  if (role !== "owner" && role !== "editor") return;
  var seen = null;
  var firstRun = false;
  try {
    var raw = localStorage.getItem(NOTIF_SEEN_PENDING_KEY);
    seen = raw ? JSON.parse(raw) : null;
  } catch (e) {
    seen = null;
  }
  if (!seen || typeof seen !== "object") {
    seen = {};
    firstRun = true;
  }
  var nowMap = {};
  Object.keys(pendingMap).forEach(function (enc) {
    nowMap[enc] = (pendingMap[enc] && pendingMap[enc].updatedAt) || 0;
  });
  if (!firstRun) {
    Object.keys(nowMap).forEach(function (enc) {
      if (!(enc in seen)) {
        var pEntry = pendingMap[enc] || {};
        pushNotif(
          "заявка · " + describeSwapForNotif(decodeSwapKey(enc), pEntry),
          "pending",
          pEntry.cancelled ? "cancel" : "pending",
          buildNotifFrag(decodeSwapKey(enc), pEntry)
        );
      }
    });
  }
  try {
    localStorage.setItem(NOTIF_SEEN_PENDING_KEY, JSON.stringify(nowMap));
  } catch (e) {}
}

/* Смена штампа данных -> «обновились пары». */
function notifyAboutScheduleStamp(updatedAt) {
  if (!updatedAt) return;
  try {
    var prev = localStorage.getItem(NOTIF_SEEN_SCHEDULE_KEY);
    if (prev && prev !== updatedAt) pushNotif("обновились пары — базовое расписание обновлено", "schedule", "schedule");
    localStorage.setItem(NOTIF_SEEN_SCHEDULE_KEY, updatedAt);
  } catch (e) {}
}

/* Визуальный тип записи ленты: отмена — красным, замена — синим и т.д.
   У старых записей без tone определяем тип по тексту. */
function notifTone(n) {
  if (n && n.tone) return n.tone;
  var t = (n && n.text) || "";
  if (t.indexOf("отмена пары") !== -1) return "cancel";
  if (t.indexOf("заявка") === 0) return "pending";
  if (t.indexOf("сброс замены") === 0) return "reset";
  if (t.indexOf("замена") === 0) return "swap";
  return "schedule";
}

var NOTIF_ICONS = {
  cancel:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="8.5"/><path d="M9.5 9.5l5 5M14.5 9.5l-5 5"/></svg>',
  swap:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7 16V4M7 4 3.5 7.5M7 4l3.5 3.5M17 8v12m0 0 3.5-3.5M17 20l-3.5-3.5"/></svg>',
  reset:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 14 4 9l5-5"/><path d="M4 9h10a6 6 0 0 1 0 12h-3"/></svg>',
  pending: ICON_SHIELD,
  schedule: ICON_BELL,
};

/* Структурированный фрагмент дня для карточки уведомления/заявки.
   У отмены/сброса в облаке нет полей пары — берём её из базового расписания. */
function buildNotifFrag(key, entry) {
  const m = key.match(/\|(\d{4}-\d{2}-\d{2}):(\d+)$/);
  if (!m) return null;
  const dIso = m[1];
  const n = Number(m[2]);
  let subject = entry.subject || "";
  let teacher = entry.teacher || "";
  let room = entry.room || "";
  if (!subject && !teacher && !room) {
    try {
      const slot = slotsForBase(dateFromIso(dIso)).find((s) => s.n === n);
      if (slot) {
        subject = slot.subject || "";
        teacher = slot.teacher || "";
        room = slot.room || "";
      }
    } catch (e) {}
  }
  return {
    d: dIso,
    n: n,
    subject: subject,
    teacher: teacher,
    room: room,
    cancelled: !!entry.cancelled,
    deleted: !!entry.deleted,
  };
}

/* Длительность пары из расписания звонков: «1 ч 35 мин». Без времени начала/конца. */
function lessonDurationLabel(dIso, n) {
  const d = dateFromIso(dIso);
  const bell = BELLS.find((b) => b.n === Number(n));
  if (!d || Number.isNaN(d.getTime()) || !bell) return "";
  const t = d.getDay() === 6 ? bell.sat : bell.week;
  const m = String(t).match(/(\d{1,2}):(\d{2})\D+(\d{1,2}):(\d{2})/);
  if (!m) return "";
  const mins = Number(m[3]) * 60 + Number(m[4]) - (Number(m[1]) * 60 + Number(m[2]));
  if (mins <= 0) return "";
  const h = Math.floor(mins / 60);
  const mm = mins % 60;
  return h ? h + " ч" + (mm ? " " + mm + " мин" : "") : mm + " мин";
}

/* Мини-карточка дня в уведомлении: дата, время и сама пара —
   отменённая зачёркнута. Вместо «полотна текста». */
function notifFragHtml(n) {
  const f = n && n.frag;
  if (!f || !f.d || !f.n) return "";
  const d = dateFromIso(f.d);
  if (!d || Number.isNaN(d.getTime())) return "";
  const bell = BELLS.find((b) => b.n === Number(f.n));
  const time = bell ? (d.getDay() === 6 ? bell.sat : bell.week) : "";
  const meta = [f.teacher, f.room].filter(Boolean).join(" · ");
  return (
    '<span class="weekly-notif-frag">' +
    '<span class="weekly-notif-frag-day">' +
    escapeHtml(dateLabel(d)) +
    '</span><span class="weekly-notif-frag-lesson' +
    (f.cancelled ? " is-cancelled" : "") +
    '">' +
    (time ? "<time>" + escapeHtml(time) + "</time>" : "") +
    '<span class="weekly-notif-frag-main"><b>' +
    escapeHtml(f.n + " пара" + (f.subject ? " · " + f.subject : "")) +
    "</b>" +
    (meta ? "<i>" + escapeHtml(meta) + "</i>" : "") +
    "</span></span></span>"
  );
}

function closeBellSheet() {
  var backdrop = document.getElementById("bell-backdrop");
  if (!backdrop) return;
  backdrop.classList.remove("is-open");
  window.setTimeout(function () { backdrop.remove(); }, 160);
}

function renderBellBody() {
  var body = document.getElementById("bell-sheet-body");
  if (!body) return;
  loadNotifs();
  var html = '<div class="weekly-replace-head"><strong>уведомления</strong><span>замены и обновления</span></div>';
  if (!notifList.length) {
    html +=
      '<p class="weekly-replace-hint weekly-updates-empty">пока тихо. как только кто-то опубликует замену, отменит пару или обновится расписание — здесь появится запись.</p>';
  } else {
    html += '<div class="weekly-tg-section">';
    notifList.forEach(function (n) {
      var tone = notifTone(n);
      html +=
        '<div class="weekly-tg-row weekly-notif-row is-' + tone + '">' +
        '<span class="weekly-notif-ico" aria-hidden="true">' +
        (NOTIF_ICONS[tone] || NOTIF_ICONS.schedule) +
        '</span><div class="weekly-tg-row-text"><strong>' +
        escapeHtml(n.text) +
        "</strong>" +
        notifFragHtml(n) +
        "<span>" +
        escapeHtml(fmtDateTime(n.at)) +
        "</span></div></div>";
    });
    html += "</div>";
  }
  html +=
    '<div class="weekly-replace-actions">' +
    (notifList.length ? '<button type="button" data-bell="clear">очистить</button>' : "") +
    '<button type="button" data-bell="close">закрыть</button></div>';
  body.innerHTML = html;
}

function openBellSheet() {
  closeBellSheet();
  var backdrop = document.createElement("div");
  backdrop.id = "bell-backdrop";
  backdrop.className = "weekly-replace-backdrop";
  backdrop.innerHTML =
    '<div class="weekly-replace-sheet weekly-tg-sheet" role="dialog" aria-label="уведомления"><div id="bell-sheet-body"></div></div>';
  document.body.appendChild(backdrop);
  window.requestAnimationFrame(function () { backdrop.classList.add("is-open"); });
  backdrop.addEventListener("click", function (e) {
    if (e.target === backdrop) {
      closeBellSheet();
      return;
    }
    var el = e.target.closest("[data-bell]");
    if (!el) return;
    if (el.dataset.bell === "close") closeBellSheet();
    else if (el.dataset.bell === "clear") {
      notifList = [];
      saveNotifs();
      updateBellButton();
      renderBellBody();
    }
  });
  /* Открытие = всё прочитано. */
  loadNotifs();
  notifList.forEach(function (n) { n.read = true; });
  saveNotifs();
  updateBellButton();
  renderBellBody();
}

/* ---------- журнал обновлений расписания («?» внизу настроек) ---------- */
var scheduleUpdatedAt = null;

/* Компактный штамп данных в шапке под бейджем чётности: число и время. */
function fmtStamp(isoValue) {
  const d = new Date(isoValue);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString("ru", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}

/* true, пока идёт ручное обновление — штамп у чётности показывает «обновляем…». */
var dataRefreshing = false;

function renderDataStamp() {
  const el = $("#data-stamp");
  if (!el) return;
  const offline = typeof navigator !== "undefined" && !navigator.onLine;
  if (dataRefreshing) {
    el.textContent = "обновляем…";
    el.hidden = false;
    return;
  }
  const stamp = scheduleCheckedAt || scheduleUpdatedAt;
  const when = stamp ? fmtStamp(stamp) : "";
  if (!when) {
    /* Данных ещё нет: показываем, что приложение их ищет (или «офлайн»). */
    el.textContent = offline ? "офлайн" : "ищем данные…";
    el.hidden = false;
    return;
  }
  el.hidden = false;
  el.textContent = offline ? "офлайн · " + when : "обн. " + when;
}

function fmtDateTime(isoValue) {
  const d = new Date(isoValue);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString("ru", { day: "numeric", month: "long", hour: "2-digit", minute: "2-digit" });
}

function closeUpdatesSheet() {
  const backdrop = document.getElementById("updates-backdrop");
  if (!backdrop) return;
  backdrop.classList.remove("is-open");
  window.setTimeout(() => backdrop.remove(), 160);
}

function updatesRowHtml(entry) {
  const when = fmtDateTime(entry.at);
  const details = Array.isArray(entry.details) ? entry.details : [];
  return (
    '<div class="weekly-tg-row"><div class="weekly-tg-row-text"><strong>' +
    escapeHtml((entry.group || "?") + (entry.summary ? " · " + entry.summary : "")) +
    "</strong><span>" + escapeHtml(when) + "</span>" +
    details.map((d) => "<span>" + escapeHtml(d) + "</span>").join("") +
    "</div></div>"
  );
}

function renderUpdatesBody(data) {
  const body = document.getElementById("updates-sheet-body");
  if (!body) return;
  const stamp = scheduleUpdatedAt
    ? "данные обновлены: " + fmtDateTime(scheduleUpdatedAt)
    : "данные ещё не загружались";
  let html =
    '<div class="weekly-replace-head"><strong>обновления расписания</strong><span>' +
    escapeHtml(stamp) + "</span></div>";
  const entries = data && Array.isArray(data.entries) ? data.entries : [];
  if (!entries.length) {
    html +=
      '<p class="weekly-replace-hint weekly-updates-empty">изменений пока не было. как только парсер найдёт отличия в PDF колледжа, они появятся здесь — по каждой группе отдельно.</p>';
  } else {
    html += '<div class="weekly-tg-section"><span>изменения по всем группам (' + entries.length + ")</span>";
    entries.forEach((entry) => {
      html += updatesRowHtml(entry);
    });
    html += "</div>";
  }
  html += '<div class="weekly-replace-actions"><button type="button" data-updates="close">закрыть</button></div>';
  body.innerHTML = html;
}

function openUpdatesSheet() {
  closeUpdatesSheet();
  const backdrop = document.createElement("div");
  backdrop.id = "updates-backdrop";
  backdrop.className = "weekly-replace-backdrop";
  backdrop.innerHTML =
    '<div class="weekly-replace-sheet weekly-tg-sheet" role="dialog" aria-label="обновления расписания"><div id="updates-sheet-body"></div></div>';
  document.body.appendChild(backdrop);
  window.requestAnimationFrame(() => backdrop.classList.add("is-open"));
  backdrop.addEventListener("click", (e) => {
    /* Клики по этому окну не должны закрывать настройки под ним —
       у поповера закрытие по клику вне его, стопаем всплытие. */
    e.stopPropagation();
    if (e.target === backdrop || e.target.closest('[data-updates="close"]')) closeUpdatesSheet();
  });
  renderUpdatesBody(null);
  fetch("data/changelog.json?t=" + Date.now(), { cache: "no-store" })
    .then((res) => (res.ok ? res.json() : null))
    .then(renderUpdatesBody)
    .catch(() => renderUpdatesBody(null));
}

/* Ручное обновление из настроек: перечитывает расписание и замены. */
var refreshInFlight = false;

function manualRefresh(btn) {
  playBrandIntro();
  if (refreshInFlight) return;
  refreshInFlight = true;
  btn.disabled = true;
  const icon = btn.querySelector(".weekly-settings-icon svg") || btn.querySelector("svg");
  if (icon) icon.classList.add("is-spinning");
  /* Штамп у чётности на время обновления показывает «обновляем…». */
  dataRefreshing = true;
  renderDataStamp();
  /* Замены тянем параллельно, у них своя защита от ошибок сети. */
  Promise.resolve(pullSharedSwaps()).catch(() => {});
  refreshSchedule(true)
    .then((result) => {
      if (result === true) toast("данные обновлены");
      else if (result === "empty") toast("на сервере пока пусто — парсер ещё не отработал");
      else toast("не удалось обновить — проверь интернет");
    })
    .catch(() => toast("не удалось обновить — проверь интернет"))
    .finally(() => {
      refreshInFlight = false;
      btn.disabled = false;
      if (icon) icon.classList.remove("is-spinning");
      /* Возвращаем штампу свежее время данных. */
      dataRefreshing = false;
      renderDataStamp();
    });
}

/* ---------- форма сообщения об ошибке (баг-репорт с файлом до 20 МБ) ---------- */
var reportSelectedFile = null;
const MAX_REPORT_FILE_SIZE = 20 * 1024 * 1024; // 20 МБ

function closeReportSheet() {
  const backdrop = document.getElementById("report-backdrop");
  if (!backdrop) return;
  backdrop.classList.remove("is-open");
  window.setTimeout(() => {
    reportSelectedFile = null;
    backdrop.remove();
  }, 160);
}

function formatReportFileSize(bytes) {
  if (bytes < 1024) return bytes + " Б";
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(0) + " КБ";
  return (bytes / (1024 * 1024)).toFixed(1) + " МБ";
}

function getSystemDiagnosticsText() {
  return [
    "weeqo v78", 
    "группа: " + groupName(),
    "тема: " + state.theme + " (" + state.palette + ")",
    "режим производительности: " + (state.perfMode ? "включён" : "выключен"),
    "показывать окна: " + (state.windows ? "да" : "нет"),
    "время: " + new Date().toLocaleString("ru-RU"),
    "экран: " + window.innerWidth + "x" + window.innerHeight + " (dpr " + (window.devicePixelRatio || 1) + ")",
    "UA: " + (navigator.userAgent || "?"),
    tgSession ? ("tg: " + (tgSession.username ? "@" + tgSession.username : tgSession.id)) : "tg: не авторизован",
  ].join("\n");
}

function openReportSheet() {
  closeReportSheet();
  reportSelectedFile = null;

  const backdrop = document.createElement("div");
  backdrop.id = "report-backdrop";
  backdrop.className = "weekly-replace-backdrop";
  backdrop.innerHTML =
    '<div class="weekly-replace-sheet weekly-report-sheet" role="dialog" aria-label="сообщить об ошибке">' +
      '<div id="report-sheet-content">' +
        '<div class="weekly-replace-head">' +
          '<strong>сообщить об ошибке</strong>' +
          '<span>опишите проблему или идею — мы обязательно разберёмся</span>' +
        '</div>' +

        '<div class="weekly-replace-field">' +
          '<span>что произошло?</span>' +
          '<textarea class="weekly-report-textarea" id="report-message" rows="4" placeholder="опишите, что пошло не так, на каком шаге возникла ошибка или что хотелось бы предложить..."></textarea>' +
        '</div>' +

        '<div class="weekly-replace-field">' +
          '<span>прикрепить файл (до 20 МБ)</span>' +
          '<input type="file" id="report-file-input" hidden accept="image/*,video/*,.txt,.log,.json,.pdf,.doc,.docx" />' +
          '<div class="weekly-report-dropzone" id="report-dropzone" role="button" tabindex="0">' +
            '<span class="weekly-report-dropzone-icon">' +
              '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
                '<path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />' +
              '</svg>' +
            '</span>' +
            '<div class="weekly-report-dropzone-text">' +
              '<strong>выбрать или перетащить файл</strong>' +
              '<small>скриншот, запись экрана или лог до 20 МБ</small>' +
            '</div>' +
          '</div>' +

          '<div class="weekly-report-file-preview" id="report-file-preview" hidden>' +
            '<span class="weekly-report-file-icon">' +
              '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>' +
            '</span>' +
            '<div class="weekly-report-file-info">' +
              '<strong id="report-file-name">—</strong>' +
              '<small id="report-file-size">—</small>' +
            '</div>' +
            '<button type="button" class="weekly-report-file-remove" id="report-file-remove" aria-label="удалить файл">' +
              '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>' +
            '</button>' +
          '</div>' +

          '<div class="weekly-report-file-error" id="report-file-error" hidden></div>' +
        '</div>' +

        '<details class="weekly-report-details">' +
          '<summary>диагностика системы (прикрепится автоматически)</summary>' +
          '<pre class="weekly-report-diag-pre">' + escapeHtml(getSystemDiagnosticsText()) + '</pre>' +
        '</details>' +

        '<div class="weekly-report-form-error" id="report-form-error" hidden></div>' +

        '<div class="weekly-replace-actions">' +
          '<button type="button" data-report="close">отмена</button>' +
          '<button type="button" class="is-primary" id="report-submit-btn">отправить</button>' +
        '</div>' +
      '</div>' +
    '</div>';

  document.body.appendChild(backdrop);
  window.requestAnimationFrame(() => backdrop.classList.add("is-open"));

  backdrop.addEventListener("click", (e) => {
    e.stopPropagation();
    if (e.target === backdrop || e.target.closest('[data-report="close"]')) closeReportSheet();
  });

  const fileInput = backdrop.querySelector("#report-file-input");
  const dropzone = backdrop.querySelector("#report-dropzone");
  const preview = backdrop.querySelector("#report-file-preview");
  const nameEl = backdrop.querySelector("#report-file-name");
  const sizeEl = backdrop.querySelector("#report-file-size");
  const removeBtn = backdrop.querySelector("#report-file-remove");
  const fileError = backdrop.querySelector("#report-file-error");

  const setFile = (file) => {
    fileError.hidden = true;
    fileError.textContent = "";
    if (!file) {
      reportSelectedFile = null;
      if (fileInput) fileInput.value = "";
      preview.hidden = true;
      dropzone.hidden = false;
      return;
    }
    if (file.size > MAX_REPORT_FILE_SIZE) {
      fileError.textContent = "Файл слишком большой (" + formatReportFileSize(file.size) + "). Максимальный размер — 20 МБ.";
      fileError.hidden = false;
      if (fileInput) fileInput.value = "";
      reportSelectedFile = null;
      preview.hidden = true;
      dropzone.hidden = false;
      return;
    }
    reportSelectedFile = file;
    nameEl.textContent = file.name;
    sizeEl.textContent = formatReportFileSize(file.size);
    preview.hidden = false;
    dropzone.hidden = true;
  };

  if (dropzone && fileInput) {
    dropzone.addEventListener("click", () => fileInput.click());
    dropzone.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        fileInput.click();
      }
    });
    fileInput.addEventListener("change", () => {
      if (fileInput.files && fileInput.files[0]) {
        setFile(fileInput.files[0]);
      }
    });

    ["dragenter", "dragover"].forEach((evt) => {
      dropzone.addEventListener(evt, (e) => {
        e.preventDefault();
        e.stopPropagation();
        dropzone.classList.add("is-dragover");
      });
    });

    ["dragleave", "drop"].forEach((evt) => {
      dropzone.addEventListener(evt, (e) => {
        e.preventDefault();
        e.stopPropagation();
        dropzone.classList.remove("is-dragover");
      });
    });

    dropzone.addEventListener("drop", (e) => {
      const dt = e.dataTransfer;
      if (dt && dt.files && dt.files[0]) {
        setFile(dt.files[0]);
      }
    });
  }

  if (removeBtn) {
    removeBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      setFile(null);
    });
  }

  const submitBtn = backdrop.querySelector("#report-submit-btn");
  const msgInput = backdrop.querySelector("#report-message");
  const formError = backdrop.querySelector("#report-form-error");
  const contentEl = backdrop.querySelector("#report-sheet-content");

  if (submitBtn && msgInput && contentEl) {
    submitBtn.addEventListener("click", async () => {
      const text = (msgInput.value || "").trim();
      if (!text) {
        formError.textContent = "Пожалуйста, опишите, что произошло.";
        formError.hidden = false;
        msgInput.focus();
        return;
      }
      if (LOCAL_PREVIEW) {
        formError.textContent = "локальный режим: тестовый отчёт не отправляется в Telegram или общую базу";
        formError.hidden = false;
        return;
      }
      formError.hidden = true;
      submitBtn.disabled = true;
      submitBtn.textContent = "отправка…";

      const diag = getSystemDiagnosticsText();
      const token = window.TELEGRAM_REPORT_TOKEN || window.TELEGRAM_BOT_TOKEN || "";
      const endpoint = window.REPORT_ENDPOINT || "";
      const ownerId = window.TELEGRAM_OWNER_ID || "5142202213";
      let sentDirectly = false;

      // 1. Прямая отправка через Telegram Bot API (если настроен токен)
      if (token) {
        try {
          if (reportSelectedFile) {
            const fd = new FormData();
            fd.append("chat_id", ownerId);
            fd.append("document", reportSelectedFile);
            const caption = "🐞 Сообщение об ошибке\n\n" + text + "\n\n📋 Диагностика:\n" + diag;
            fd.append("caption", caption.slice(0, 1024));
            const res = await fetch("https://api.telegram.org/bot" + token + "/sendDocument", {
              method: "POST",
              body: fd,
            });
            const json = await res.json();
            if (json && json.ok) sentDirectly = true;
          } else {
            const res = await fetch("https://api.telegram.org/bot" + token + "/sendMessage", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                chat_id: ownerId,
                text: "🐞 Сообщение об ошибке\n\n" + text + "\n\n📋 Диагностика:\n" + diag,
              }),
            });
            const json = await res.json();
            if (json && json.ok) sentDirectly = true;
          }
        } catch (err) {
          console.warn("report bot send error:", err);
        }
      }

      // 2. Отправка через внешний webhook / эндпоинт
      if (!sentDirectly && endpoint) {
        try {
          const fd = new FormData();
          fd.append("message", text);
          fd.append("diagnostics", diag);
          fd.append("group", groupName());
          if (reportSelectedFile) fd.append("file", reportSelectedFile);
          const res = await fetch(endpoint, { method: "POST", body: fd });
          if (res.ok) sentDirectly = true;
        } catch (err) {
          console.warn("report endpoint send error:", err);
        }
      }

      // 3. Сохранение в базу Firebase (weeqo-reports)
      let fileData = null;
      if (reportSelectedFile && reportSelectedFile.size <= 750000) {
        try {
          fileData = await new Promise((resolve) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result);
            reader.onerror = () => resolve(null);
            reader.readAsDataURL(reportSelectedFile);
          });
        } catch (_) {}
      }
      const repId = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
      const reportPayload = {
        createdAt: Date.now(),
        message: text,
        diagnostics: diag,
        group: groupName(),
        hasFile: Boolean(reportSelectedFile),
        fileName: reportSelectedFile ? reportSelectedFile.name : null,
        fileSize: reportSelectedFile ? reportSelectedFile.size : null,
        fileData: fileData,
        by: tgSession ? String(tgSession.id) : null,
        byName: tgSession ? tgDisplayName(tgSession) : null,
      };
      try {
        await cloudWrite("weeqo-reports/" + repId, reportPayload);
      } catch (_) {}

      // Если ушло напрямую боту или на эндпоинт:
      if (sentDirectly) {
        contentEl.innerHTML =
          '<div class="weekly-report-success-view">' +
            '<div class="weekly-report-success-icon">' +
              '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6L9 17l-5-5"/></svg>' +
            '</div>' +
            '<strong>сообщение отправлено!</strong>' +
            '<span>спасибо, мы обязательно всё проверим</span>' +
            '<div class="weekly-replace-actions" style="margin-top: 14px;">' +
              '<button type="button" class="is-primary" data-report="close">отлично</button>' +
            '</div>' +
          '</div>';
        window.setTimeout(() => closeReportSheet(), 2400);
        return;
      }

      // 4. Если прямой токен не настроен — копируем текст и предлагаем в 1 клик отправить в Telegram
      const fullClipboardText = "🐞 Сообщение об ошибке\n\n" + text + "\n\n📋 Диагностика:\n" + diag;
      copyTextToClipboard(fullClipboardText);

      let fileNoteHtml = "";
      if (reportSelectedFile) {
        fileNoteHtml =
          '<div class="weekly-report-file-clip-note">' +
            '📎 Прикреплён файл: <strong>' + escapeHtml(reportSelectedFile.name) + '</strong> (' + formatReportFileSize(reportSelectedFile.size) + ').' +
            '<br />Текст и диагностика скопированы — отправьте сообщение и прикрепите файл в чате.' +
          '</div>';
      } else {
        fileNoteHtml =
          '<div class="weekly-report-file-clip-note">' +
            'Текст сообщения и диагностика скопированы в буфер обмена.' +
          '</div>';
      }

      contentEl.innerHTML =
        '<div class="weekly-replace-head">' +
          '<strong>отчёт сформирован</strong>' +
          '<span>текст и диагностика скопированы</span>' +
        '</div>' +
        fileNoteHtml +
        '<div class="weekly-replace-actions" style="margin-top: 12px;">' +
          '<button type="button" data-report="close">готово</button>' +
          '<a class="weekly-replace-actions-btn is-primary" href="https://t.me/teiqo" target="_blank" rel="noopener noreferrer">открыть чат @teiqo</a>' +
        '</div>';
    });
  }
}

/* ---------- просмотр отчётов об ошибках для владельца ---------- */

function closeReportsSheet() {
  const backdrop = document.getElementById("reports-backdrop");
  if (!backdrop) return;
  backdrop.classList.remove("is-open");
  window.setTimeout(() => backdrop.remove(), 220);
}

async function fetchBugReports() {
  try {
    const url = await sharedUrlWithAuth(cloudRoot() + "/weeqo-reports.json");
    const resp = await fetch(url, { headers: { Accept: "application/json" }, cache: "no-store" });
    if (resp.ok) {
      const data = await resp.json();
      return data && typeof data === "object" ? data : {};
    }
  } catch (err) {
    console.warn("fetchBugReports error:", err);
  }
  return {};
}

async function renderReportsSheetBody() {
  const body = document.getElementById("reports-sheet-body");
  if (!body) return;
  body.innerHTML =
    '<div class="weekly-replace-head"><strong>отчёты об ошибках</strong><span>загрузка данных…</span></div>' +
    '<p class="weekly-replace-hint">подключаемся к базе Firebase…</p>';

  const raw = await fetchBugReports();
  const list = Object.keys(raw)
    .map((id) => Object.assign({ id }, raw[id]))
    .filter((r) => r && (r.createdAt || r.message));
  list.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));

  let html =
    '<div class="weekly-replace-head">' +
      '<strong>отчёты об ошибках</strong>' +
      '<span>всего отчётов: ' + list.length + '</span>' +
    '</div>';

  if (!list.length) {
    html += '<p class="weekly-replace-hint weekly-updates-empty" style="text-align:center;padding:24px 0;">отчётов пока нет — здесь появятся сообщения от пользователей.</p>';
  } else {
    html += '<div class="weekly-reports-list">';
    list.forEach((r) => {
      const timeStr = r.createdAt ? fmtDateTime(r.createdAt) : "время не указано";
      const sender = (r.byName ? escapeHtml(r.byName) : "Аноним") + (r.by ? ' <small style="opacity:0.75">(id: ' + escapeHtml(String(r.by)) + ')</small>' : "");
      const grp = r.group ? escapeHtml(r.group) : "не указана";

      let fileHtml = "";
      if (r.hasFile || r.fileName || r.fileData) {
        const fName = escapeHtml(r.fileName || "вложение");
        const fSize = r.fileSize ? ' (' + formatReportFileSize(r.fileSize) + ')' : "";
        if (r.fileData && String(r.fileData).startsWith("data:image/")) {
          fileHtml =
            '<div class="weekly-report-card-file">' +
              '<div class="weekly-report-card-thumb"><img src="' + r.fileData + '" alt="' + fName + '"></div>' +
              '<a class="weekly-report-file-link" href="' + r.fileData + '" download="' + fName + '" target="_blank">📎 ' + fName + fSize + '</a>' +
            '</div>';
        } else if (r.fileData) {
          fileHtml =
            '<div class="weekly-report-card-file">' +
              '<a class="weekly-report-file-link" href="' + r.fileData + '" download="' + fName + '" target="_blank">📎 ' + fName + fSize + '</a>' +
            '</div>';
        } else {
          fileHtml = '<div class="weekly-report-card-file"><span>📎 ' + fName + fSize + '</span></div>';
        }
      }

      let diagHtml = "";
      if (r.diagnostics) {
        diagHtml =
          '<details class="weekly-report-card-diag">' +
            '<summary>диагностика системы</summary>' +
            '<pre>' + escapeHtml(r.diagnostics) + '</pre>' +
          '</details>';
      }

      html +=
        '<div class="weekly-report-card" data-rep-id="' + escapeHtml(r.id) + '">' +
          '<div class="weekly-report-card-top">' +
            '<div class="weekly-report-card-sender">' +
              '<strong>' + sender + '</strong>' +
              '<span>' + timeStr + ' · группа: ' + grp + '</span>' +
            '</div>' +
            '<button type="button" class="weekly-report-del-btn" data-del-report="' + escapeHtml(r.id) + '" title="удалить отчёт">' +
              '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>' +
            '</button>' +
          '</div>' +
          '<div class="weekly-report-card-msg">' + escapeHtml(r.message || "") + '</div>' +
          fileHtml +
          diagHtml +
        '</div>';
    });
    html += '</div>';
  }

  html +=
    '<div class="weekly-replace-actions" style="margin-top:14px;">' +
      '<button type="button" data-reports-act="refresh">обновить</button>' +
      '<button type="button" class="is-primary" data-reports-act="close">закрыть</button>' +
    '</div>';

  body.innerHTML = html;
}

function openReportsSheet() {
  closeReportsSheet();
  const backdrop = document.createElement("div");
  backdrop.id = "reports-backdrop";
  backdrop.className = "weekly-replace-backdrop";
  backdrop.innerHTML =
    '<div class="weekly-replace-sheet weekly-tg-sheet weekly-reports-sheet" role="dialog" aria-label="отчёты об ошибках">' +
      '<div id="reports-sheet-body"></div>' +
    '</div>';
  document.body.appendChild(backdrop);
  window.requestAnimationFrame(() => backdrop.classList.add("is-open"));

  backdrop.addEventListener("click", async (e) => {
    if (e.target === backdrop || e.target.closest('[data-reports-act="close"]')) {
      closeReportsSheet();
      return;
    }
    const refBtn = e.target.closest('[data-reports-act="refresh"]');
    if (refBtn) {
      renderReportsSheetBody();
      return;
    }
    const delBtn = e.target.closest('[data-del-report]');
    if (delBtn) {
      const repId = delBtn.dataset.delReport;
      if (!repId) return;
      if (confirm("Удалить этот отчёт об ошибке?")) {
        delBtn.disabled = true;
        await cloudWrite("weeqo-reports/" + repId, null);
        const card = backdrop.querySelector('[data-rep-id="' + repId + '"]');
        if (card) card.remove();
        renderReportsSheetBody();
      }
    }
  });

  renderReportsSheetBody();
}

(function initUpdates() {
  const btn = document.getElementById("go-updates");
  if (btn) btn.addEventListener("click", openUpdatesSheet);
  const bugBtn = document.getElementById("go-bug");
  if (bugBtn) bugBtn.addEventListener("click", openReportSheet);
  const headRefreshBtn = document.getElementById("refresh-btn");
  if (headRefreshBtn) headRefreshBtn.addEventListener("click", () => manualRefresh(headRefreshBtn));
  const brand = document.getElementById("brand");
  if (brand) {
    brand.addEventListener("click", playBrandIntro);
    brand.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        playBrandIntro();
      }
    });
  }
  window.addEventListener("online", renderDataStamp);
  window.addEventListener("offline", renderDataStamp);
  renderDataStamp();
})();

(function initTg() {
  loadTgSession();
  checkTgAuthRedirect();
  updateTgButton();
})();

(function initBell() {
  const btn = document.getElementById("bell-btn");
  if (btn) btn.addEventListener("click", openBellSheet);
  updateBellButton();
})();

(function initAccountRow() {
  const acc = document.getElementById("go-account");
  if (acc)
    acc.addEventListener("click", () => {
      openProfile();
    });
  const tgBtn = document.getElementById("go-tg-sheet");
  if (tgBtn)
    tgBtn.addEventListener("click", () => {
      openTgSheet();
    });
  const repBtn = document.getElementById("go-reports-sheet");
  if (repBtn)
    repBtn.addEventListener("click", () => {
      openReportsSheet();
    });
  renderAccountRow();
})();

(function startSharedSwaps() {
  if (!sharedSwapsEnabled()) return;
  window.setTimeout(pullSharedSwaps, 1200);
  sharedSync.poll = window.setInterval(pullSharedSwaps, 45000);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) pullSharedSwaps();
  });
})();

/* Все данные, иконки и локальные настройки готовы до первого рендера. */
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}
