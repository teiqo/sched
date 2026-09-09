import { sendBotEvent, updateBotSubscription, verifyAuthWithBot, botRequest, BotApiError } from "./push.js";
import { planPairSwap, planPairInsert } from "./pair-moves.js";
import { bindPairDrag } from "./pair-drag.js";
import { bindDaySwipe } from "./day-swipe.js";
import { isVacancy, lessonType, isSlotVisible } from "./lesson-types.js";
import { TelegramLogin } from "./telegram-auth.js";
import { authButtonHtml } from "./telegram-auth-ui.js";
import { BUILD, diagnostics, recordError, readReportFile, validateReportFile, MAX_REPORT_FILE_SIZE } from "./reporting.js";
const CLOUD_PATHS = window.SCHED_COMPAT.cloudPaths;
import { BELLS, TIMES, GROUPS, DEFAULT_GROUP, groupById, lessonCount } from "./schedule.js";

const KEY = "sched:groups:v2";
/* Локальная демонстрация никогда не получает облачные права и не пишет в Firebase. */
const LOCAL_PREVIEW =
  ["localhost", "127.0.0.1", "[::1]", "::1"].includes(location.hostname) ||
  location.protocol === "file:" ||
  !location.host;
const LOCAL_TG_KEY = "sched:local-telegram-demo:v1";
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

function isLearningModeActive() {
  if (typeof basicsTourStep !== "undefined" && basicsTourStep >= 0) return true;
  if (typeof state !== "undefined" && !state.onboarded) return true;
  if (typeof document !== "undefined") {
    if (document.body && document.body.classList.contains("is-tour-active")) return true;
    if (document.getElementById("basics-tour") !== null) return true;
    const ob = document.getElementById("onboarding");
    if (ob && !ob.hidden && ob.innerHTML.trim() !== "") return true;
  }
  return false;
}

/* Режим производительности: data-perf на <html>, по CSS остаются только
   лёгкие переходы дней остаются, тяжёлые blur/эффекты выключаются.
   В режиме обучения (онбординг и тур) полностью игнорируется, чтобы анимации не ломались. */
function applyPerfMode() {
  const perfActive = Boolean(state.perfMode && !isLearningModeActive());
  if (perfActive) document.documentElement.setAttribute("data-perf", "1");
  else document.documentElement.removeAttribute("data-perf");
  const sw = $("#perf-switch");
  if (sw) sw.setAttribute("aria-pressed", state.perfMode ? "true" : "false");
  const hint = $("#perf-hint");
  if (hint) hint.textContent = "для слабых устройств";
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
  showVacancies: false,
  showSelfStudy: true,
  editorMode: false,
  parityMode: "auto",
  settingsOpen: false,
  nowOverride: null,
  light: false,
  /* На телефоне по умолчанию только выбранный день; «вся неделя» — тумблером. */
  /* «Вся неделя» по умолчанию выключена — открывается выбранный день. */
  scope: "day",
  group: DEFAULT_GROUP,
  draftGroup: DEFAULT_GROUP,
  onboarded: false,
  profileOpen: false,
  onboardingStep: 0,
};
if (typeof window !== "undefined") window.state = state;

let pairDragActive = false;
let pairRenderPending = false;
let daySwipeActive = false;
let daySwipeRenderPending = false;
var daySwipeController = null;
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
  return currentGroup().id || "не выбрано";
}

function groupOptions(selected) {
  return `<option value=""${!selected ? " selected" : ""}>не выбрано</option>` + GROUPS.map(
    (g) =>
      `<option value="${escapeHtml(g.id)}"${g.id === selected ? " selected" : ""}>${escapeHtml(g.id)}</option>`,
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
  if (diff === 0) return `сегодня, ${dayEntry(d).name}`;
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
  if (!state.group || isSummer(d)) return [];
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
      const times = sat ? TIMES[n] && TIMES[n].sat : TIMES[n] && TIMES[n].week;
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
  /* Отменённая пара просто исчезает из списка (и из «сейчас/далее»). */
  const preferences = state.editorMode
    ? { ...state, windows: true, showVacancies: true, showSelfStudy: true }
    : state;
  return slotsFor(d).filter((s) => !s.window && isSlotVisible(s, preferences));
}

function visibleSlotsFor(d) {
  const preferences = state.editorMode
    ? { ...state, windows: true, showVacancies: true, showSelfStudy: true }
    : state;
  return slotsFor(d)
    .map((slot) => slot.cancelled
      ? { ...slot, cancelled: false, window: true, empty: true, subject: "окно", teacher: null, room: null }
      : slot)
    .filter((s) => isSlotVisible(s, preferences));
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
  if (next) {
    /* Если до этого уже была пара — сейчас идёт перерыв, а не ожидание первой пары. */
    const prev = [...list].reverse().find((s) => mins(s.to) <= cur);
    if (prev) {
      const from = mins(prev.to);
      const to = mins(next.from);
      const total = to - from;
      return {
        kind: "break",
        slot: next,
        prev,
        from: prev.to,
        to: next.from,
        total,
        left: to - cur,
        passed: cur - from,
        progress: total > 0 ? (cur - from) / total : 1,
        now,
      };
    }
    return { kind: "next", slot: next, left: mins(next.from) - cur, progress: 0, now };
  }
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
    const vacancy = isVacancy(slot);
    parts.push(
      `<span class="lesson-type-accent${vacancy ? " is-vacancy" : ""}">• ${teacher}</span>`,
    );
  }
  if (slot.room) parts.push(`<span class="lesson-room">ауд. ${escapeHtml(slot.room)}</span>`);
  if (slot.tag) parts.push(`<span class="lesson-location">${escapeHtml(slot.tag)}</span>`);
  if (slot.self) parts.push(`<span class="lesson-origin-mark is-local">сам. работа</span>`);
  if (!slot.teacher && !slot.room && !slot.self) {
    parts.push(`<span class="lesson-location">без аудитории</span>`);
  }
  return parts.join("");
}

function isRoomOnlySwap(s) {
  if (!s || !s.swapped || s.moved || s.cancelled || s.window) return false;
  const subj = (s.subject || "").trim().toLowerCase();
  const origSubj = (s.origSubject || "").trim().toLowerCase();
  const room = (s.room || "").trim().toLowerCase();
  const origRoom = (s.origRoom || "").trim().toLowerCase();
  return Boolean(origSubj) && subj === origSubj && room !== origRoom &&
    (s.teacher || "").trim().toLowerCase() === (s.origTeacher || "").trim().toLowerCase() &&
    Boolean(s.self) === Boolean(s.origSelf);
}

function changeLabel(slot) {
  return slot.moved ? "перенос" : isRoomOnlySwap(slot) ? "другая аудитория" : "замена";
}

/* Перерыв показывается такой же большой плашкой, как идущая пара,
   только с отсчётом до следующей пары. */
function breakCardHtml(live, dIso) {
  const s = live.slot;
  const title = live.total >= 30 ? "большой перерыв" : "перерыв";
  const dateStr = dIso || iso(live.now || state.selected || currentDate());
  const swapBtn = swapButtonHtml(dateStr, s.n);
  const room = s.room
    ? ` · <span class="lesson-room">ауд. ${escapeHtml(s.room)}</span>`
    : "";
  const body = `
    <div class="live-card-status">
      <span><i></i>сейчас · перерыв ${bellDuration(Math.max(0, Math.round(live.total)))}</span>
      <div class="live-card-status-right">
        <time id="live-clock">${clockText(live.now)}</time>
        ${swapBtn}
      </div>
    </div>
    <h3>${title}</h3>
    <p class="lesson-meta"><span class="lesson-type-accent">дальше · ${s.n} пара</span> ${escapeHtml(s.subject)}${room}</p>
    <div class="live-card-progress"><i id="live-progress" style="transform:scaleX(${live.progress.toFixed(3)})"></i></div>
    <div class="live-card-timing"><span class="live-card-range">${live.from}–${live.to}<small id="live-passed">прошло ${fmtLeft(live.passed)}</small></span><span id="live-left">осталось ${fmtLeft(live.left)}</span></div>`;
  return `<article class="live-lesson-card is-current is-break" data-row-n="${s.n}">
    <div class="live-card-glass">
      <div class="live-card-particles" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i><i></i></div>
      ${body}
    </div>
  </article>`;
}

function liveCardHtml(live, dIso) {
  if (!live || live.kind === "done") return "";
  if (live.kind === "break") return breakCardHtml(live, dIso);
  const s = live.slot;
  const current = live.kind === "current";
  const dateStr = dIso || iso(live.now || state.selected || currentDate());
  const swapBtn = swapButtonHtml(dateStr, s.n);
  const swapMark = s.swapped
    ? `<span class="lesson-origin-mark is-swap">${changeLabel(s)}</span>`
    : "";
  const status = current
    ? `<span><i></i>сейчас · ${s.n} пара${swapMark}</span>`
    : `<span>${ICON_CLOCK}далее · ${s.n} пара${swapMark}</span>`;
  const clockHtml = `<time id="live-clock">${current ? clockText(live.now) : s.from}</time>`;
  const progress = current
    ? `<div class="live-card-progress"><i id="live-progress" style="transform:scaleX(${live.progress.toFixed(
        3,
      )})"></i></div>`
    : "";
  const timing = current
    ? `<div class="live-card-timing"><span class="live-card-range">${s.from}–${s.to}<small id="live-passed">прошло ${fmtLeft(
        live.passed,
      )}</small></span><span id="live-left">осталось ${fmtLeft(live.left)}</span></div>`
    : `<div class="live-card-timing is-next-timing"><strong id="live-left">через ${fmtLeft(
        live.left,
      )}</strong><span class="live-next-range">${s.from}–${s.to}</span></div>`;
  const body = `
    <div class="live-card-status">
      ${status}
      <div class="live-card-status-right">
        ${clockHtml}
        ${swapBtn}
      </div>
    </div>
    <h3>${escapeHtml(s.subject)}</h3>
    <p class="lesson-meta">${metaHtml(s)}</p>
    ${progress}
    ${timing}`;

  if (!current) {
    return `<article class="live-lesson-card is-next" data-row-n="${s.n}">${body}</article>`;
  }
  return `<article class="live-lesson-card is-current" data-row-n="${s.n}">
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

  const time = `<div class="agenda-row-time"><span class="agenda-row-num">${slot.n}</span><time>${slot.from}<span>${slot.to}</span></time></div>`;

  if (slot.window) {
    cls.push("is-window-row");
    const editorAttrs = state.editorMode
      ? ` data-act="swap" data-date="${dIso}" data-n="${slot.n}" role="button" tabindex="0" aria-label="окно, ${slot.n} пара, нажми, чтобы изменить"`
      : "";
    return `<div class="${cls.join(" ")}"${editorAttrs}>${time}<div class="agenda-row-content">
      <strong>окно</strong>
    </div>${state.editorMode ? `<span class="lesson-swap-btn is-window-hint" aria-hidden="true">${ICON_SWAP}</span>` : ""}</div>`;
  }

  const mark = isCurrent
    ? `<span class="lesson-origin-mark is-overlap">сейчас</span>`
    : isNext
      ? `<span class="lesson-origin-mark is-next">далее</span>`
      : "";

  const swapMark = slot.cancelled
    ? `<span class="lesson-origin-mark is-swap">отменена</span>`
    : slot.swapped
      ? `<span class="lesson-origin-mark is-swap">${changeLabel(slot)}</span>`
      : "";

  return `<div class="${cls.join(" ")}" data-row-n="${slot.n}">${time}<div class="agenda-row-content">
    <strong>${escapeHtml(slot.subject)}${swapMark}${mark}</strong>
    <span class="lesson-meta">${metaHtml(slot)}</span>
    <small>${bellDuration(mins(slot.to) - mins(slot.from))}</small>
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
  if (!state.group) return `<div class="sched-empty-day sched-choose-group">${ICON_EMPTY}<strong>группа не выбрана</strong><span>выбери свою группу, чтобы увидеть пары</span><button type="button" data-act="choose-group">выбрать группу</button></div>`;
  const summer = isSummer(d);
  const off = isDayOff(d);
  const title = summer ? "каникулы" : off ? "выходной" : "пар нет";
  const note = summer
    ? "лето — занятий нет"
    : off
      ? "воскресенье — занятий нет"
      : `в этот день у ${groupName()} пар нет (${parityLabel(parityOf(d))} неделя)`;
  return `<div class="sched-empty-day">${ICON_EMPTY}<strong>${title}</strong><span>${note}</span></div>`;
}

function headingHtml(d, sub, primary = false) {
  const today = sameDay(d, startOfDay(currentDate()));
  const title = today
    ? `<span class="sched-day-rel">сегодня, </span><span class="sched-day-weekday">${escapeHtml(dayEntry(d).name)}</span>`
    : `<span class="sched-day-weekday">${escapeHtml(dayEntry(d).name)}, </span><span class="sched-day-date">${d.getDate()} ${MONTHS[d.getMonth()]}</span>`;
  const rel = today ? "" : relLabel(d);
  return `<div class="sched-day-heading t-stagger is-shown${primary && !today ? " has-today-action" : ""}">
    <div class="sched-day-heading-copy">
      <h2 class="t-stagger-line t-stagger-line--1">${title}</h2>
      <span class="t-stagger-line t-stagger-line--2">${sub}${rel ? ` · ${rel}` : ""}</span>
    </div>
    <div class="sched-day-actions"></div>
  </div>`;
}

function editorToolbarHtml(dIso) {
  if (!state.editorMode) return "";
  const role = myRole();
  const primary = role === "owner" || role === "editor" ? "сохранить" : "предложить";
  const undoDisabled = !editorSession?.history.length ? " disabled" : "";
  return `<div class="sched-editor-toolbar" role="toolbar" aria-label="редактор расписания">
    <div class="sched-editor-toolbar-copy"><strong>режим редактора</strong><span>видны все пары, окна, вакансии и самостоятельные</span></div>
    <div class="sched-editor-toolbar-actions">
      <button type="button" data-editor="undo"${undoDisabled}>${ICON_UNDO}<span>назад</span></button>
      <button type="button" data-editor="reset-day" data-date="${dIso}">${ICON_RESET}<span>исходный день</span></button>
      <button type="button" data-editor="cancel">отмена</button>
      <button type="button" class="is-primary" data-editor="save">${primary}</button>
    </div>
  </div>`;
}

function checkCompactHeading() {
  document.querySelectorAll(".sched-day-heading.is-compact-date").forEach((h) => {
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
  const all = visibleSlotsFor(d);
  const lessons = all.filter((s) => !s.window);
  const rows = state.editorMode || state.windows ? all : lessons;
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
  } else if (live && (live.kind === "current" || live.kind === "next" || live.kind === "break")) {
    const liveN = live.slot.n;
    const earlier = rows.filter((s) => s.n < liveN);
    const later = rows.filter((s) => s.n > liveN);
    const earlierHtml = renderSlotRuns(earlier, live, dIso);
    const liveHost = `<div id="live-host">${liveCardHtml(live, dIso)}</div>`;
    const laterHtml = later.length
      ? `<div class="agenda-list">${withBreaksHtml(later, live, dIso)}</div>`
      : "";
    body = `${earlierHtml}${liveHost}${laterHtml}`;
  } else {
    const earlierHtml = renderSlotRuns(rows, live, dIso);
    const liveHost = withLive && live ? `<div id="live-host">${liveCardHtml(live, dIso)}</div>` : "";
    body = `${earlierHtml}${liveHost}`;
  }

  return `<div class="sched-day-block${future ? " is-future" : ""}" data-day="${dIso}">${headingHtml(d, sub, withLive && !future)}${withLive && !future ? editorToolbarHtml(dIso) : ""}${body}</div>`;
}

function weekHtml() {
  const ws = weekStart(state.selected);
  const p = parityLabel(parityOf(state.selected));
  const days = [];
  for (let i = 0; i < 7; i += 1) {
    const d = addDays(ws, i);
    const all = visibleSlotsFor(d);
    const lessons = all.filter((s) => !s.window);
    const rows = state.editorMode || state.windows ? all : lessons;
    days.push(`<div class="sched-day-block" data-day="${iso(d)}">
      <div class="sched-day-heading">
        <div class="sched-day-heading-copy">
          <h2>${dayEntry(d).name}, ${d.getDate()} ${MONTHS[d.getMonth()]}</h2>
          <span>${
            lessons.length
              ? `${lessons.length} ${plural(lessons.length, "пара", "пары", "пар")}`
              : "пар нет"
          }</span>
        </div>
        ${sameDay(d, startOfDay(currentDate())) ? '<span class="sched-week-badge">сегодня</span>' : ""}
        <div class="sched-day-actions"></div>
      </div>
      ${
        lessons.length || (state.windows && rows.length)
          ? `<div class="agenda-list">${withBreaksHtml(rows, null, iso(d))}</div>`
          : `<div class="sched-empty-day compact">${ICON_EMPTY}<strong>${
              isSummer(d) ? "каникулы" : d.getDay() === 0 ? "выходной" : "пар нет"
            }</strong></div>`
      }
    </div>`);
  }
  return `<div class="sched-day-block">
      <div class="sched-day-heading">
        <div class="sched-day-heading-copy">
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

// пары и перерывы между ними одним списком
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
    rows.push(
      `<div class="agenda-break"><span class="agenda-break-chip" title="${gap >= 30 ? "большой перерыв" : "перерыв"}">перерыв · <strong>${bellDuration(gap)}</strong></span></div>`,
    );
  });
  return rows.join("");
}

function bellsHtml() {
  const weekdayCount = bellItems("week").length;
  const satCount = bellItems("sat").length;
  return `<div class="sched-day-block">
    <div class="sched-day-heading">
      <div class="sched-day-heading-copy">
        <button class="sched-onboarding-back" type="button" data-act="back-schedule">
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
  if (old && old._schedHtml === html) return;
  if (sceneOutTimer !== null) {
    window.clearTimeout(sceneOutTimer);
    sceneOutTimer = null;
  }

  if (sceneTimer !== null) {
    window.clearTimeout(sceneTimer);
    sceneTimer = null;
  }
  stage.querySelectorAll(".sched-active-day-scene").forEach((node) => {
    if (node !== old) node.remove();
  });

  if (!old) {
    const first = document.createElement("div");
    first.className = "sched-active-day-scene";
    first.id = "day-scene";
    first._schedHtml = html;
    first.innerHTML = html;
    stage.appendChild(first);
    setupLazyDays();
    return;
  }

  const scene = $("#scene");
  const isLearning = isLearningModeActive();
  const perfActive = Boolean(state.perfMode && !isLearning);
  const reduced =
    perfActive ||
    (!isLearning && window.matchMedia("(prefers-reduced-motion: reduce)").matches) ||
    Boolean(scene && scene.classList.contains("is-motion-lite") && !isLearning);

  if (!direction || reduced) {
    old.getAnimations().forEach((a) => a.cancel());
    old.classList.remove("is-leaving", "is-entering");
    old.removeAttribute("data-direction");
    old.style.cssText = "";
    /* При открытии одинаковый контент применяется дважды (кэш, затем сеть) —
       без этого стража анимация появления пар играла два раза подряд. */
    if (old._schedHtml !== html) {
      old._schedHtml = html;
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
  next.className = "sched-active-day-scene is-entering";
  next.id = "day-scene";
  next.dataset.direction = direction;
  next.style.animation = "none";
  next._schedHtml = html;
  next.innerHTML = html;
  stage.appendChild(next);
  setupLazyDays();

  const dist = cssVar("--page-slide-distance", "8px");
  const ease = cssVar("--page-slide-ease", "cubic-bezier(0.22, 1, 0.36, 1)");
  const dur = cssTimeMs("--page-slide-dur", 250);
  const outX =
    direction === "forward"
      ? `translate3d(calc(${dist} * -1), 0, 0)`
      : `translate3d(${dist}, 0, 0)`;
  const inX =
    direction === "forward"
      ? `translate3d(${dist}, 0, 0)`
      : `translate3d(calc(${dist} * -1), 0, 0)`;

  const outAnim = old.animate(
    [
      { opacity: from.opacity, transform: from.transform },
      { opacity: 0, transform: outX },
    ],
    { duration: dur, easing: ease, fill: "forwards" },
  );
  const inAnim = next.animate(
    [
      { opacity: 0, transform: inX },
      { opacity: 1, transform: "translate3d(0, 0, 0)" },
    ],
    { duration: dur, easing: ease, fill: "both" },
  );

  /* Каскадные анимации строк длятся дольше смены подложки: раньше таймер
     обрывал их через dur, и при скролле/быстром листании пары моргали.
     Ждём полного каскада и трогаем только свои WAAPI-анимации. */
  const rowDur = cssTimeMs("--duration-fast", 320);
  const rowStep = cssTimeMs("--duration-stagger", 55);
  const total = Math.max(dur + 80, rowDur + rowStep * 10 + 120);

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
  const selectedIndex = Math.max(0, Math.min(6, Math.round((state.selected - ws) / 86400000)));
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
      btn.classList.toggle("is-today", sameDay(d, today));
      btn.classList.toggle("is-day-off", isDayOff(d));
      const dotsEl = btn.querySelector(".date-lesson-dots");
      const lessons = lessonsFor(d);
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
    !window.matchMedia("(max-width: 767px), (pointer: coarse)").matches &&
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
  updateDayRevertBtn();
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
  $("#freshness").textContent = state.group ? `группа ${groupName()}` : "группа: не выбрано";
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
    $("#editor-btn")?.classList.add("is-hidden-tab");
  } else {
    state.tab = "schedule";
    scheduleView.style.display = "";
    strip.style.display = "";
    auxView.hidden = true;
    auxView.innerHTML = "";
    $("#editor-btn")?.classList.remove("is-hidden-tab");
  }
  applyFlags();
}

function render(direction) {
  if (pairDragActive) { pairRenderPending = true; return; }
  if (daySwipeActive) { daySwipeRenderPending = true; return; }
  lastRenderAt = performance.now();
  // быстрые переключения больше не глушат анимацию: каждый день запускает каскад заново.
  // при перемещении рулетки сцену уже меняет selectDate, здесь не дублируем
  quietMotion = Boolean(scrub && scrub.active && scrub.isDragging && !scrub.tapGlide);
  renderHeader();
  renderStrip();
  renderTab();
  if (state.tab === "schedule") {
    setScene(dayHtml(state.selected, true) + futureDaysHtml(), quietMotion ? null : direction);
    liveKey = liveSignature();
  }
  quietMotion = false;
  updateDayRevertBtn();
  save();
  window.requestAnimationFrame(checkCompactHeading);
}
if (typeof window !== "undefined") window.render = render;

var passiveRefreshTimer = null;
function renderPassive() {
  const root = document.documentElement;
  root.classList.add("is-passive-refresh");
  window.clearTimeout(passiveRefreshTimer);
  render();
  passiveRefreshTimer = window.setTimeout(() => {
    root.classList.remove("is-passive-refresh");
    passiveRefreshTimer = null;
  }, 120);
}

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
  if (scrub || pairDragActive || daySwipeActive) return;
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
  if (clock && (live.kind === "current" || live.kind === "break")) clock.textContent = clockText(live.now);
  if (left) {
    left.textContent =
      live.kind === "next" ? `через ${fmtLeft(live.left)}` : `осталось ${fmtLeft(live.left)}`;
  }
  const passed = $("#live-passed");
  if (passed && (live.kind === "current" || live.kind === "break")) passed.textContent = `прошло ${fmtLeft(live.passed)}`;
  if (bar) bar.style.transform = `scaleX(${live.progress.toFixed(3)})`;
}

/* ---------- тема и палитра ---------- */

function applyTheme() {
  const root = document.documentElement;
  root.dataset.theme = state.theme;
  // Тёмные варианты neutral/opaque больше не переключают тему сами.
  // Для белого режима используем отдельные светлые варианты этих же палитр.
  if (!PALETTES.includes(state.palette)) state.palette = "default";
  /* При смене палитры глушим @property-переход акцентного цвета на пару кадров:
     иначе включение акцентной темы анимирует цвет от дефолтного синего
     (initial #0a84ff) к выбранному — видна синяя вспышка. */
  const prevPalette = root.dataset.schedPalette || "default";
  if (prevPalette !== state.palette) {
    root.classList.add("sched-no-accent-anim");
    requestAnimationFrame(() =>
      requestAnimationFrame(() => root.classList.remove("sched-no-accent-anim")),
    );
  }
  root.dataset.theme = state.theme;
  if (state.palette === "default") root.removeAttribute("data-sched-palette");
  else root.dataset.schedPalette = state.palette;

  if (state.palette === "accent" || state.palette === "accent-plus") {
    root.style.setProperty("--sched-accent", state.accent);
    const ink = accentInk(state.accent);
    root.style.setProperty("--sched-on-accent", ink);
    const contrast = (hex) => {
      const a = accentLuminance(hex),
        b = accentLuminance(ink);
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
    root.style.setProperty("--sched-gradient-light", stop("#ffffff", 0.66));
    root.style.setProperty("--sched-gradient-dark", stop("#000000", 0.66));
    root.style.setProperty("--sched-accent-readable", readableAccent(state.accent, state.theme));
  } else {
    root.style.removeProperty("--sched-accent");
    root.style.removeProperty("--sched-on-accent");
    root.style.removeProperty("--sched-gradient-light");
    root.style.removeProperty("--sched-gradient-dark");
    root.style.removeProperty("--sched-accent-readable");
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
  const isAccent = state.palette === "accent" || state.palette === "accent-plus";
  if (accentRow) {
    accentRow.removeAttribute("hidden");
    accentRow.classList.toggle("is-visible", isAccent);
    accentRow.inert = !isAccent;
  }
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
        showVacancies: state.showVacancies,
        showSelfStudy: state.showSelfStudy,
        parityMode: state.parityMode,
        tab: state.tab,
        light: state.light,
        scope: state.scope,
        group: state.group,
        onboarded: state.onboarded,
      }),
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
    if (typeof data.showVacancies === "boolean") state.showVacancies = data.showVacancies;
    if (typeof data.showSelfStudy === "boolean") state.showSelfStudy = data.showSelfStudy;
    if (["auto", "even", "odd"].includes(data.parityMode)) state.parityMode = data.parityMode;
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
  if (!options?.fromSwipe) daySwipeController?.cancel();
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
          options.animated ? scrubDir : null,
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
      Math.round((state.selected - weekStart(state.selected)) / 86400000),
    );
    const todayButton = $("#today-btn");
    if (todayButton) {
      todayButton.classList.toggle(
        "is-visible",
        !sameDay(state.selected, startOfDay(currentDate())),
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
      silent: true,
      preview: true,
      animated: previewAnimated(),
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
     чтобы после резкого о������пускания не оставались инлайн-трансформ и блюр. */
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
      Math.round((state.selected - weekStart(state.selected)) / 86400000),
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
    if (basicsTourStep === 1) return;
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
    const isLearning = isLearningModeActive();
    const reducedMotion = (!isLearning && motionQuery.matches) || (state.perfMode && !isLearning);

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
            silent: true,
            preview: true,
            animated: previewAnimated(),
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

  strip.addEventListener(
    "touchmove",
    (e) => {
      if (scrub?.active && scrub.pointerDown && e.cancelable) e.preventDefault();
    },
    { passive: false },
  );

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
    if (basicsTourStep === 1) {
      const [y, m, d] = btn.dataset.date.split("-").map(Number);
      triggerTourRoulette(new Date(y, m - 1, d));
      return;
    }
    const [y, m, d] = btn.dataset.date.split("-").map(Number);
    const newDate = new Date(y, m - 1, d);
    const dir = newDate > state.selected ? "forward" : newDate < state.selected ? "backward" : null;
    selectDate(newDate, dir);
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
      if (wheelFrame === null)
        wheelFrame = window.requestAnimationFrame(() => {
          wheelFrame = null;
          if (!scrub) shiftDay(wheelDirection);
        });
    },
    { passive: false },
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

  $("#today-btn").addEventListener("click", () => {
    const d = defaultSelectedDate();
    const dir = d > state.selected ? "forward" : d < state.selected ? "backward" : null;
    selectDate(d, dir);
  });

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
      if (state.palette !== "accent" && state.palette !== "accent-plus") state.palette = "accent";
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

  [["vacancies-switch", "showVacancies"], ["self-study-switch", "showSelfStudy"]].forEach(([id, key]) => {
    document.getElementById(id).addEventListener("click", () => {
      state[key] = !state[key];
      save();
      render();
    });
  });
  $("#editor-btn")?.addEventListener("click", () => {
    if (state.editorMode) cancelEditorMode();
    else startEditorMode();
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
      e.target.closest(".sched-replace-backdrop")
    )
      return;
    closeSettings();
  });

  document.addEventListener("click", (e) => {
    const row = e.target.closest(".sched-settings-row");
    if (!row || e.target.closest("button, a, input, select, label")) return;
    /* Строки настроек остаются в DOM и при закрытой панели — без этой
       проверки случайный клик (например, после перетаскивания пары) открывал
       системное окно выбора цвета поверх расписания. */
    if (!state.settingsOpen || !row.closest("#settings")) return;
    if (document.body.classList.contains("is-dragging-pair")) return;
    const sw = row.querySelector(".sched-setting-switch");
    if (sw) {
      sw.click();
      return;
    }
    const colorInput = row.querySelector(".sched-accent-input");
    if (colorInput) {
      colorInput.click();
    }
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      if (basicsTourStep >= 0) {
        finishBasicsTour();
        return;
      }
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
    if (
      state.tab !== "schedule" ||
      pairDragActive ||
      state.profileOpen ||
      state.settingsOpen ||
      e.target.closest("input, textarea, select, [contenteditable=true], [role=dialog]")
    )
      return;
    if (e.key === "ArrowRight") shiftDay(1);
    if (e.key === "ArrowLeft") shiftDay(-1);
  });

  /* Свайпы используют только transform; экономичный режим сохраняет плавную доводку. */
  const scene = $("#scene");
  let motionLiteTimer = null;
  const holdMotionLite = (ms = 420) => {
    scene.classList.add("is-motion-lite");
    window.clearTimeout(motionLiteTimer);
    motionLiteTimer = window.setTimeout(() => {
      scene.classList.remove("is-motion-lite");
      motionLiteTimer = null;
    }, ms);
  };
  daySwipeController = bindDaySwipe({
    scene, stage: $("#stage"), strip: $("#strip"), selection: $("#selection"),
    canStart: () => state.tab === "schedule" && !pairDragActive && !scrub && !state.settingsOpen && !state.profileOpen,
    getDate: () => state.selected, minDate: minAllowedDate, addDays,
    renderDay: d => dayHtml(d, true),
    onActiveChange: active => { daySwipeActive = active; },
    onCommit: d => {
      // The neighbour has already slid into place: do not play a second entrance.
      holdMotionLite();
      daySwipeRenderPending = false;
      selectDate(d, null, { fromSwipe: true });
    },
    onFinish: () => {
      if (daySwipeRenderPending) {
        daySwipeRenderPending = false;
        holdMotionLite();
        render();
      }
    },
  });

  /* На iOS Safari innerHeight меняется при скролле (прячется/показывается тулбар) —
     если пересчитывать высоту на каждый resize, вся раскладка «подпрыгивает».
     Пересчитываем только при реальной смене ширины (поворот, сплит-вью). */
  let lastViewportWidth = window.innerWidth;
  const vh = (force) => {
    if (!force && window.innerWidth === lastViewportWidth) return;
    lastViewportWidth = window.innerWidth;
    document.documentElement.style.setProperty(
      "--sched-viewport-height",
      `${window.innerHeight}px`,
    );
  };
  window.addEventListener("resize", () => {
    vh(false);
    checkCompactHeading();
    if (basicsTourStep >= 0) renderBasicsTour();
  });
  window.addEventListener("orientationchange", () => {
    vh(true);
    checkCompactHeading();
    if (basicsTourStep >= 0) renderBasicsTour();
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
  root.dataset.editorMode = state.editorMode ? "true" : "false";
  root.dataset.showSwapButtons = state.editorMode ? "true" : "false";
  if (state.light) root.dataset.schedScheduleView = "light";
  else root.removeAttribute("data-sched-schedule-view");
  const ls = $("#light-switch");
  if (ls) ls.setAttribute("aria-pressed", state.light ? "true" : "false");
  const ss = $("#scope-switch");
  if (ss) ss.setAttribute("aria-pressed", state.scope === "week" ? "true" : "false");
  $("#vacancies-switch")?.setAttribute("aria-pressed", String(state.showVacancies));
  $("#self-study-switch")?.setAttribute("aria-pressed", String(state.showSelfStudy));
  const editorButton = $("#editor-btn");
  if (editorButton) {
    editorButton.setAttribute("aria-pressed", String(state.editorMode));
    editorButton.classList.toggle("is-active", state.editorMode);
    editorButton.title = state.editorMode ? "выйти из редактора" : "режим редактора";
  }
  const li = $("#light-hint");
  if (li) li.textContent = state.light ? "плоские и компактные пары" : "обычные карточки";
  const sh = $("#scope-hint");
  if (sh) sh.textContent = state.scope === "week" ? "следующие дни ниже" : "только выбранный день";
  const ph = $("#profile-hint");
  if (ph) ph.textContent = `группа ${groupName()} · без входа`;
}

/* ---------- даты в полосе ---------- */

function dotsHtml(d) {
  const lessons = lessonsFor(d);
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
      ? '<div class="sched-lazy-day" data-lazy="' +
        iso(d) +
        '" style="min-height:' +
        (110 +
          visibleSlotsFor(d).length * (state.light ? 76 : 96)) +
        'px" aria-hidden="true"></div>'
      : cachedFutureDay(d),
  );
  /* Обёртка нужна, чтобы будущие дни проявлялись каскадом,
     а не возникали резко вмест�� со сменой сцены. */
  return `<div class="sched-future-days">${out.join("")}</div>`;
}

/* Отложенная дорисовка наблюдает только текущую сцену, а не каждую мутацию
   секундомера/анимации. Не больше одного невидимого дня за кадр. */
let lazyDayObserver = null;
let lazyDayFrame = null;
let lazyDayGeneration = 0;
const futureMarkupCache = new Map();
let futureMarkupKey = "";

function cachedFutureDay(d) {
  const context = [
    scheduleRevision,
    state.group,
    state.windows,
    state.showVacancies,
    state.showSelfStudy,
    state.parityMode,
    iso(startOfDay(currentDate())),
    JSON.stringify(activeSwapMap()),
  ].join("|");
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
  const targets = host.querySelectorAll(".sched-lazy-day[data-lazy]");
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
    if (el) {
      pending.delete(el);
      fill(el);
    }
    if (pending.size) lazyDayFrame = requestAnimationFrame(drain);
  };
  lazyDayObserver = new IntersectionObserver(
    (entries) => {
      if (generation !== lazyDayGeneration) return;
      for (const en of entries) {
        if (!en.isIntersecting) continue;
        lazyDayObserver.unobserve(en.target);
        pending.add(en.target);
      }
      if (pending.size && lazyDayFrame === null) lazyDayFrame = requestAnimationFrame(drain);
    },
    { rootMargin: "240px 0px" },
  );
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
    ["swaps", "замены и отмены", "изменения пар твоей группы"],
    ["schedule", "обновления расписания", "когда появляется новое расписание"],
    ["pending", "заявки на проверку", "для владельца и редакторов"],
    [
      "telegram",
      "дублировать в телеграм",
      LOCAL_PREVIEW
        ? "локальная проверка, без отправки сообщений"
        : TELEGRAM_BOT_NAME
          ? "личные сообщения от @" + TELEGRAM_BOT_NAME
          : "личные сообщения от бота",
    ],
  ];
  return rows
    .map(
      ([key, title, hint]) => `<div class="sched-settings-row">
    <span class="sched-settings-row-main"><span class="sched-settings-copy">
      <strong>${title}</strong><span>${escapeHtml(hint)}</span>
    </span></span>
    <button class="sched-setting-switch" type="button" data-npref="${key}" aria-label="${title}"
      aria-pressed="${prefs[key] ? "true" : "false"}"><span aria-hidden="true"></span></button>
  </div>`,
    )
    .join("");
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
  backdrop.className = "sched-replace-backdrop";
  backdrop.innerHTML = `
    <div class="sched-replace-sheet sched-tg-sheet" role="dialog" aria-label="настройки уведомлений">
      <div class="sched-replace-head">
        <strong>настроить уведомления</strong>
        <span>что показывать и куда дублировать</span>
      </div>
      <div class="sched-tg-section" style="margin-top: 6px;">
        ${notifPreferencesHtml()}
      </div>
      <div class="sched-replace-actions" style="margin-top: 8px;">
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

var profileView = "profile";
var appStatsCache = null;
var appStatsLoading = false;
var appStatsError = "";
var STATS_VISITOR_KEY = "sched:visitor:v1";
var STATS_VISIT_SENT_KEY = "sched:visitor-sent:v1";

function statsVisitorId() {
  try {
    let id = localStorage.getItem(STATS_VISITOR_KEY) || "";
    if (!/^[A-Za-z0-9_-]{20,100}$/.test(id)) {
      id = crypto.randomUUID
        ? crypto.randomUUID().replace(/-/g, "")
        : Date.now().toString(36) + Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
      localStorage.setItem(STATS_VISITOR_KEY, id);
    }
    return id;
  } catch (_) {
    return "";
  }
}

function trackStatsVisit(force = false) {
  if (LOCAL_PREVIEW || !window.SCHED_NOTIFY_URL) return;
  const visitorId = statsVisitorId();
  if (!visitorId) return;
  const authenticated = Boolean(tgSessionVerified && tgSession?.session_token);
  try {
    const sent = JSON.parse(localStorage.getItem(STATS_VISIT_SENT_KEY) || "null");
    if (!force && sent && sent.authenticated === authenticated && Date.now() - Number(sent.at || 0) < 6 * 60 * 60 * 1000) return;
  } catch (_) {}
  botRequest("stats/visit", { visitor_id: visitorId }, authenticated ? tgSession.session_token : "", { timeout: 5000 })
    .then(() => {
      try { localStorage.setItem(STATS_VISIT_SENT_KEY, JSON.stringify({ at: Date.now(), authenticated })); } catch (_) {}
    })
    .catch(() => {});
}

function compactNumber(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return "—";
  return new Intl.NumberFormat("ru-RU").format(n);
}
function localApplicationStats() {
  const entries = Object.entries(loadSwaps()).filter(([, value]) => value && typeof value === "object" && !value.deleted);
  return {
    activeChanges: entries.length,
    replaced: entries.filter(([, value]) => !value.cancelled && !value.moved && !value.makeWindow).length,
    moved: entries.filter(([, value]) => value.moved).length,
    cancelled: entries.filter(([, value]) => value.cancelled).length,
    windows: entries.filter(([, value]) => value.makeWindow).length,
    groups: new Set(entries.map(([key]) => key.split("|")[0]).filter(Boolean)).size,
    pending: Object.keys(pendingMap).length,
  };
}
function statCard(value, label, tone = "") {
  return `<article class="sched-stat-card${tone ? " is-" + tone : ""}">
    <strong>${compactNumber(value)}</strong><span>${label}</span>
  </article>`;
}
function statRow(label, value) {
  return `<div class="sched-stat-row"><span>${label}</span><strong>${compactNumber(value)}</strong></div>`;
}
function statsPanelHtml() {
  const local = localApplicationStats();
  const server = appStatsCache || {};
  const users = server.users || {};
  const telegram = server.telegram || {};
  const activity = server.activity || {};
  const status = appStatsLoading
    ? '<span class="sched-stats-status">обновляем…</span>'
    : appStatsError
      ? `<button class="sched-stats-status is-error" type="button" data-act="refresh-stats">повторить</button>`
      : '<button class="sched-stats-status" type="button" data-act="refresh-stats">обновить</button>';
  return `<section class="sched-stats" id="profile-stats-panel" aria-label="статистика приложения">
    <div class="sched-stats-head">
      <div><span>живые данные</span><h2>статистика приложения</h2></div>${status}
    </div>
    ${appStatsError ? `<p class="sched-stats-error">${escapeHtml(appStatsError)}</p>` : ""}
    <div class="sched-stats-grid">
      ${statCard(users.total, "всего пользователей", "primary")}
      ${statCard(users.anonymous ?? 0, "без авторизации", "accent")}
      ${statCard(users.authorized ?? users.total, "авторизованы")}
      ${statCard(users.active_7d, "активны за 7 дней", "positive")}
    </div>
    <div class="sched-stats-section">
      <h3>сейчас</h3>
      <div class="sched-stats-list">
        ${statRow("подписаны на telegram", telegram.subscribers)}
        ${statRow("активны за 30 дней", users.active_30d)}
        ${statRow("без авторизации за 7 дней", users.anonymous_active_7d ?? 0)}
        ${statRow("заявок на проверке", local.pending)}
        ${statRow("групп с изменениями", local.groups)}
      </div>
    </div>
    <div class="sched-stats-section">
      <h3>изменения</h3>
      <div class="sched-stats-list">
        ${statRow("активных изменений", local.activeChanges)}
        ${statRow("заменено пар", local.replaced)}
        ${statRow("перенесено пар", local.moved)}
        ${statRow("отменено пар", local.cancelled)}
        ${statRow("создано окон", local.windows)}
        ${statRow("операций за 30 дней", activity.change_events_30d)}
      </div>
    </div>
    <div class="sched-stats-section">
      <h3>telegram за 30 дней</h3>
      <div class="sched-stats-list">
        ${statRow("доставлено уведомлений", telegram.deliveries_30d)}
        ${statRow("пользователей запускали бота", users.bot_started)}
        ${statRow("групп у подписчиков", telegram.groups)}
        ${statRow("получено отчётов", activity.reports_30d)}
      </div>
    </div>
    <p class="sched-stats-note">пользователи без авторизации считаются по уникальной установке браузера. сырой идентификатор не сохраняется; после входа этот браузер больше не входит в анонимный счётчик.</p>
  </section>`;
}
function profileTabsHtml(canReview) {
  if (!canReview) return "";
  return `<div class="sched-profile-tabs sched-profile-main-tabs" role="tablist" aria-label="раздел профиля">
    <button type="button" role="tab" data-act="profile-tab" data-tab="profile" aria-selected="${profileView === "profile"}" class="${profileView === "profile" ? "is-active" : ""}">профиль</button>
    <button type="button" role="tab" data-act="profile-tab" data-tab="stats" aria-selected="${profileView === "stats"}" class="${profileView === "stats" ? "is-active" : ""}">статистика</button>
  </div>`;
}
async function loadApplicationStats(force = false) {
  if (appStatsLoading || LOCAL_PREVIEW || !tgSessionVerified) return;
  if (appStatsCache && !force && Date.now() - Number(appStatsCache.generated_at || 0) < 60000) return;
  const role = myRole();
  if (role !== "owner" && role !== "editor") return;
  appStatsLoading = true;
  appStatsError = "";
  const current = document.getElementById("profile-stats-panel");
  if (current) current.outerHTML = statsPanelHtml();
  try {
    appStatsCache = await botRequest("stats", {}, await ensurePushSession());
  } catch (error) {
    appStatsError = error?.message || "не удалось загрузить статистику";
    recordError("app-stats", appStatsError);
  } finally {
    appStatsLoading = false;
    const panel = document.getElementById("profile-stats-panel");
    if (panel) panel.outerHTML = statsPanelHtml();
  }
}

function openProfile() {
  const backdrop = $("#profile-backdrop");
  const count = lessonCount(state.group);
  const role = myRole();
  const canReview = role === "owner" || role === "editor";
  if (!canReview && profileView === "stats") profileView = "profile";
  const pendingCount = Object.keys(pendingMap).length;

  /* После входа — карточка-«герой» с аватаркой, именем и бейджем роли. */
  let heroBlock = "";
  let accountBlock = "";
  if (tgSession) {
    const roleLabel = tgSession?.isLocalDemo
      ? "владелец"
      : role === "owner"
        ? "владелец"
        : role === "editor"
          ? "редактор"
          : "студент";
    const avatarInner = tgAvatarMarkup(tgSession.photo_url, tgSession);
    heroBlock = `
    <div class="sched-profile-hero">
      <span class="sched-profile-hero-avatar">${avatarInner}</span>
      <strong class="sched-profile-hero-name">${escapeHtml(tgDisplayName(tgSession))}</strong>
      ${tgSession.username ? '<span class="sched-profile-hero-username">@' + escapeHtml(String(tgSession.username)) + "</span>" : ""}
      <span class="sched-profile-hero-role is-${role}">${ICON_SHIELD}<span>${roleLabel}</span></span>
      <button type="button" class="sched-profile-hero-id is-copy" data-act="copy-id" data-id="${escapeHtml(String(tgSession.id))}" title="нажми, чтобы скопировать">мой id: <b>${escapeHtml(String(tgSession.id))}</b></button>
      <div class="sched-profile-hero-actions">
        <button type="button" class="sched-profile-mini" data-act="tg-logout">выйти</button>
      </div>
    </div>`;
  } else {
    accountBlock = `<div class="sched-profile-group"><div data-login-panel>${authButtonHtml(telegramLogin?.snapshot, LOCAL_PREVIEW)}</div></div>`;
  }

  let ownerActionsBlock = "";
  if (role === "owner") {
    ownerActionsBlock = `
      <div class="sched-profile-group">
        <div class="sched-profile-group-heading"><span>управление заменами</span></div>
        <button class="sched-settings-row sched-warn-action" type="button" data-act="reset-all-swaps">
          <span class="sched-settings-row-main">
            <span class="sched-settings-icon is-danger">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/></svg>
            </span>
            <span class="sched-settings-copy">
              <strong>отменить все замены</strong>
              <span>сбросить все созданные замены для группы</span>
            </span>
          </span>
        </button>
      </div>`;
  }

  const content = `
      <div class="sched-profile-group">
        <div class="sched-profile-group-heading"><span>учебная группа</span></div>
        <div class="sched-profile-select">
          <select id="profile-group">${groupOptions(state.group)}</select>
          ${ICON_CHEVRON}
        </div>
      </div>
      <div class="sched-profile-group">
        <button class="sched-settings-row sched-profile-notifs-head" type="button" data-act="toggle-notifs"
          id="profile-notifs-toggle" aria-expanded="false" aria-controls="profile-notifs-panel">
          <span class="sched-settings-row-main">
            <span class="sched-settings-icon is-theme">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.7 21a2 2 0 0 1-3.4 0"/></svg>
            </span>
            <span class="sched-settings-copy">
              <strong>настроить уведомления</strong>
              <span>что показывать и куда дублировать</span>
            </span>
          </span>
          ${ICON_CHEVRON}
        </button>
        <div class="sched-profile-notifs-panel" id="profile-notifs-panel" role="region"
          aria-labelledby="profile-notifs-toggle" aria-hidden="true" inert>
          <div class="sched-profile-notifs-panel-inner"><div class="sched-profile-notifs-options">
            ${notifPreferencesHtml()}
          </div></div>
        </div>
        ${""}
      </div>
      <div class="sched-profile-group">
        <button class="sched-settings-row" type="button" data-act="repeat-tutorial-profile">
          <span class="sched-settings-row-main">
            <span class="sched-settings-icon is-onboarding">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3a9 9 0 1 0 9 9"/><path d="M12 7v5l3 2"/><path d="M17 3h4v4"/></svg>
            </span>
            <span class="sched-settings-copy">
              <strong>повторить обучение</strong>
              <span>редактор, рулетка и настройки</span>
            </span>
          </span>
          ${ICON_CHEVRON}
        </button>
      </div>
      ${authStatusHtml()}
      ${accountBlock}
      ${ownerActionsBlock}`;

  const tabs = profileTabsHtml(canReview);
  const profileBody = profileView === "stats" && canReview
    ? `<div class="sched-profile-content is-stats-view">${statsPanelHtml()}</div>`
    : `${heroBlock}
      <div class="sched-profile-identity">
        <div>
          <h2>${state.group ? groupName() : "группа не выбрана"}</h2>
          <p>${state.group ? `${count} ${plural(count, "пара", "пары", "пар")} в неделю` : "выбери группу ниже"}</p>
        </div>
      </div>
      <div class="sched-profile-content">${content}</div>`;

  backdrop.innerHTML = `<div class="sched-profile${profileView === "stats" ? " is-stats-view" : ""}" role="dialog" aria-modal="true" aria-label="профиль">
    <div class="sched-profile-header">
      <button type="button" data-act="back">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M15 6l-6 6 6 6"/></svg>
        назад
      </button>
      <h1>${profileView === "stats" ? "статистика" : "профиль"}</h1>
      <span></span>
    </div>
    ${tabs}
    ${profileBody}
  </div>`;
  backdrop.hidden = false;
  state.profileOpen = true;
  updateSubscriptionUi();
  if (profileView === "stats" && canReview) loadApplicationStats();
  if (!LOCAL_PREVIEW && !tgSession) prepareTelegramLogin();
}

function closeProfile() {
  const backdrop = $("#profile-backdrop");
  backdrop.hidden = true;
  backdrop.innerHTML = "";
  state.profileOpen = false;
  profileView = "profile";
  closeTgMemo();
  closeNotifsSheet();
  closeTgSheet();
}

/* ---------- онбординг ---------- */

function onboardingHtml() {
  const total = 3;
  const offset = `-${state.onboardingStep * (100 / total)}%`;
  const dots = [];
  for (let i = 0; i < total; i += 1) {
    dots.push(
      `<button type="button" class="${i === state.onboardingStep ? "is-active" : ""}" data-step="${i}" aria-label="шаг ${
        i + 1
      }"></button>`,
    );
  }
  const draft = state.draftGroup;
  const count = lessonCount(draft);
  return `<div class="sched-onboarding-top is-progress-only">
    <div class="sched-onboarding-progress">${dots.join("")}</div>
  </div>
  <div class="sched-onboarding-slides" style="--onboarding-count:${total};--onboarding-slide-width:${
    100 / total
  }%;--onboarding-offset:${offset}">
    <div class="sched-onboarding-slide is-welcome" aria-hidden="${state.onboardingStep === 0 ? "false" : "true"}">
      <div class="sched-onboarding-copy is-centered">
        <div class="sched-onboarding-mark">
          <svg class="sched-mark" viewBox="0 0 24 24" aria-hidden="true"><path d="M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.937A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .962 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.581a.5.5 0 0 1 0 .964L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.963 0z"/></svg>
        </div>
        <span class="sched-onboarding-kicker">sched beta</span>
        <h1>только расписание</h1>
        <p>как это работает? каждые 3 часа мы берём расписание с сайта sustec.ru машиностроительного колледжа и загружаем его сюда</p>
      </div>
      <button class="sched-onboarding-action" type="button" data-act="next">выбрать группу</button>
    </div>
    <div class="sched-onboarding-slide is-profile" aria-hidden="${state.onboardingStep === 1 ? "false" : "true"}">
      <div class="sched-onboarding-copy">
        <button class="sched-onboarding-back" type="button" data-act="back">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M15 6l-6 6 6 6"/></svg>
          назад
        </button>
        <h1>какая группа?</h1>
        <p>выбор можно поменять потом в настройках</p>
        <div class="sched-profile-fields">
          <label class="sched-profile-field">учебная группа
            <div class="sched-profile-control">
              <select id="onboarding-group">${groupOptions(draft)}</select>
              ${ICON_CHEVRON}
            </div>
            <small>${draft ? `${draft} · ${count} ${plural(count, "пара", "пары", "пар")} в неделю` : "можно выбрать позже"}</small>
          </label>
        </div>
      </div>
      <button class="sched-onboarding-action" type="button" data-act="next-telegram">${draft ? "подтвердить группу" : "продолжить без группы"}</button>
    </div>
    <div class="sched-onboarding-slide is-telegram-link" aria-hidden="${state.onboardingStep === 2 ? "false" : "true"}">
      <div class="sched-onboarding-copy is-centered">
        <button class="sched-onboarding-back" type="button" data-act="back">${ICON_CHEVRON}<span>назад</span></button>
        <div class="sched-onboarding-telegram-mark">${ICON_BELL}</div>
        <span class="sched-onboarding-kicker">необязательно</span>
        <h1>привязать telegram?</h1>
        <p>это не обязательно, но ты можешь настроить, чтобы тебе приходили уведомления прямо в мессенджер.</p>
        <div class="sched-onboarding-tg-example" aria-label="пример уведомления в telegram">
          <span>пример уведомления</span>
          <div class="sched-onboarding-tg-notification">
            <i class="sched-onboarding-tg-avatar has-photo"><img src="assets/icons/tg-bot-avatar.jpg" alt="" width="42" height="42" loading="lazy" decoding="async" /></i>
            <div><div class="sched-onboarding-tg-head"><strong>sched</strong><time>9:06</time></div>
            <p>🔄 11 сентября заменили 4 пару<br><b>комп. графика · аудитория 307</b></p></div>
          </div>
        </div>
        <div data-login-panel>${tgSession ? `<strong class="sched-onboarding-linked">telegram уже привязан</strong>` : authButtonHtml(telegramLogin?.snapshot, LOCAL_PREVIEW)}</div>
      </div>
      <div class="sched-onboarding-finish-actions">
        <button class="sched-onboarding-action" type="button" data-act="finish-tour">продолжить</button>
      </div>
    </div>
  </div>`;
}

function renderOnboarding() {
  const host = $("#onboarding");
  /* Тему не форсируем: первый запуск следует системной (или выбранной ранее). */
  applyTheme();
  applyPerfMode();
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
    applyPerfMode();
  }, 320);
  state.onboarded = true;
  save();
  applyTheme();
  applyPerfMode();
}

var basicsTourStep = -1;
var basicsTourOpenedEditor = false;
var basicsTourEditorTimers = [];
var basicsTourRouletteAnimation = null;
var basicsTourRouletteFrame = null;
var basicsTourRouletteTimer = null;
var basicsTourRouletteOriginalDate = null;
var basicsTourLastTriggerTime = 0;
const BASICS_TOUR = [
  { selector: "#editor-btn", title: "редактор расписания", text: "карандаш открывает все пары, окна, вакансии и самостоятельные. внутри можно менять и переносить пары, а затем сохранить или предложить правки." },
  { selector: "#strip", title: "рулетка дней", text: "зажми даты и веди пальцем или мышью — неделя прокручивается вслед за движением. <span class=\"sched-tour-accent\">залипательно</span>." },
  { selector: "#settings-trigger", title: "настройки", text: "здесь меняются группа, тема, вид расписания и уведомления." },
];

function stopBasicsTourRoulette(options = {}) {
  if (basicsTourRouletteTimer !== null) {
    clearTimeout(basicsTourRouletteTimer);
    basicsTourRouletteTimer = null;
  }
  basicsTourRouletteAnimation?.cancel();
  basicsTourRouletteAnimation = null;
  if (basicsTourRouletteFrame !== null) cancelAnimationFrame(basicsTourRouletteFrame);
  basicsTourRouletteFrame = null;
  document.body.classList.remove("is-tour-roulette-active");
  const strip = document.getElementById("strip");
  const selection = document.getElementById("selection");
  const stage = document.getElementById("stage");
  strip?.classList.remove("is-tour-demo", "is-pressing", "is-scrubbing");
  strip?.querySelectorAll("[data-under-selection]").forEach(button => button.removeAttribute("data-under-selection"));
  selection?.style.removeProperty("will-change");
  selection?.style.removeProperty("transform");
  stage?.style.removeProperty("min-height");
  if (sceneTimer !== null) {
    clearTimeout(sceneTimer);
    sceneTimer = null;
  }
  if (sceneOutTimer !== null) {
    clearTimeout(sceneOutTimer);
    sceneOutTimer = null;
  }
  if (stage) {
    stage.querySelectorAll(".sched-active-day-scene.is-leaving").forEach(scene => scene.remove());
  }
  if (!options.keepDate && basicsTourRouletteOriginalDate && !sameDay(state.selected, basicsTourRouletteOriginalDate)) {
    selectDate(basicsTourRouletteOriginalDate, null, { silent: true, preview: true, animated: false });
  }
  basicsTourRouletteOriginalDate = null;
}

function startBasicsTourRoulette(options = {}) {
  const initialDelay = typeof options.delay === "number" ? options.delay : 650;
  stopBasicsTourRoulette({ keepDate: Boolean(options.keepDate) });

  if (state.editorMode && !editorChangedEntries().length) {
    finishEditorMode();
    basicsTourOpenedEditor = false;
  }

  const strip = document.getElementById("strip");
  const selection = document.getElementById("selection");
  const stage = document.getElementById("stage");
  if (!strip || !selection) return;

  if (stage && stage.offsetHeight) {
    stage.style.minHeight = `${stage.offsetHeight}px`;
  }
  document.body.classList.add("is-tour-roulette-active");

  const current = Math.max(0, Math.min(6, Number(strip.dataset.selectedIndex) || 0));
  const originalDate = new Date(state.selected);
  const originalWeek = weekStart(originalDate);
  basicsTourRouletteOriginalDate = originalDate;

  const today = startOfDay(currentDate());
  const todayIndex = Math.max(0, Math.min(6, Math.round((today - originalWeek) / 86400000)));

  // Рулетка дней должна доходить до сегодняшнего дня:
  let targetIndex;
  if (current !== todayIndex) {
    targetIndex = todayIndex;
  } else {
    // Если уже на сегодняшнем дне — идём к началу недели (понедельник 0) и возвращаемся в сегодня.
    // Если сегодня понедельник (0) — идём к пятнице (4) и возвращаемся в сегодня.
    targetIndex = todayIndex === 0 ? 4 : 0;
  }
  const distance = Math.max(1, Math.abs(targetIndex - current));

  // Предварительное мягкое нажатие перед движением
  const pressDelay = Math.max(0, initialDelay - 200);
  basicsTourRouletteTimer = window.setTimeout(() => {
    if (basicsTourStep !== 1 || !selection.isConnected) return;
    strip.classList.add("is-tour-demo", "is-pressing");
    const buttons = [...strip.querySelectorAll("button[data-date-index]")];
    buttons.forEach((btn, i) => btn.toggleAttribute("data-under-selection", i === current));

    basicsTourRouletteTimer = window.setTimeout(() => {
      basicsTourRouletteTimer = null;
      if (basicsTourStep !== 1 || !selection.isConnected) return;

      strip.classList.add("is-scrubbing");
      selection.style.willChange = "transform";

      const reducedMotion = false;
      const duration = Math.max(2200, 1850 + distance * 110);
      const startedAt = performance.now();
      let lastIndex = current;
      let lastUnderIndex = current;

      // Момент разворота (44% времени на путь туда, 56% на возвращение с длинным замедлением)
      const turnPoint = 0.44;

      const paintFingerSwipe = now => {
        if (!selection.isConnected || basicsTourStep !== 1) return;
        const progress = Math.min(1, (now - startedAt) / duration);

        let factor;
        if (reducedMotion) {
          factor = Math.sin(progress * Math.PI);
        } else if (progress <= turnPoint) {
          // Путь туда: плавный разгон (smootherstep) и мягкий выход в точку разворота с нулевой скоростью
          const u = progress / turnPoint;
          factor = u * u * u * (u * (u * 6 - 15) + 10);
        } else {
          // Путь обратно: плавный набор скорости от разворота и длительное шелковистое замедление
          const v = (progress - turnPoint) / (1 - turnPoint);
          const w = 1 - Math.pow(1 - v, 2.2);
          const retEase = w * w * (3 - 2 * w);
          factor = 1 - retEase;
        }

        const position = current + (targetIndex - current) * factor;
        selection.style.transform = `translate3d(${(position * 100).toFixed(3)}%,0,0)`;

        const nearestIndex = Math.max(0, Math.min(6, Math.round(position)));

        // Оптимизация без layout thrashing: обновляем подсветку только при смене дня
        if (nearestIndex !== lastUnderIndex) {
          if (lastUnderIndex >= 0 && buttons[lastUnderIndex]) {
            buttons[lastUnderIndex].removeAttribute("data-under-selection");
          }
          if (buttons[nearestIndex]) {
            buttons[nearestIndex].setAttribute("data-under-selection", "true");
          }
          lastUnderIndex = nearestIndex;
        }

        // Обновляем превью расписания с полноценной анимацией появления пар
        if (nearestIndex !== lastIndex) {
          const dir = nearestIndex > lastIndex ? "forward" : "backward";
          lastIndex = nearestIndex;
          selectDate(addDays(originalWeek, nearestIndex), dir, {
            silent: true,
            preview: true,
            animated: true,
          });
        }

        if (progress < 1) {
          basicsTourRouletteFrame = requestAnimationFrame(paintFingerSwipe);
          return;
        }

        basicsTourRouletteFrame = null;

        // Фиксируем выбранный день в дате и UI
        strip.dataset.selectedIndex = String(current);
        if (selection) {
          selection.classList.add("is-week-reset");
          selection.style.removeProperty("will-change");
          selection.style.removeProperty("transform");
          window.requestAnimationFrame(() => {
            selection.classList.remove("is-week-reset");
          });
        }

        // Завершаем скрабинг: выделение плавно опускается в полоску под датой
        strip.classList.remove("is-tour-demo", "is-pressing", "is-scrubbing");
        buttons.forEach(button => {
          button.removeAttribute("data-under-selection");
          button.classList.toggle("is-selected", button.dataset.date === iso(originalDate));
        });

        // Убираем ушедшие сцены, оставляя только текущую, без резкого сброса анимаций
        const stageEl = document.getElementById("stage");
        if (stageEl) {
          stageEl.querySelectorAll(".sched-active-day-scene.is-leaving").forEach(scene => scene.remove());
        }

        // Высоту stage и активный статус держим заблокированными до завершения анимации полоски (380ms),
        // чтобы пары внизу не вздрагивали
        window.setTimeout(() => {
          if (basicsTourStep === 1) {
            stage?.style.removeProperty("min-height");
            document.body.classList.remove("is-tour-roulette-active");
          }
        }, 380);

        basicsTourRouletteOriginalDate = null;
      };

      basicsTourRouletteFrame = requestAnimationFrame(paintFingerSwipe);
    }, Math.max(1, initialDelay - pressDelay));
  }, pressDelay);
}

function isTourRouletteRunning() {
  return basicsTourRouletteFrame !== null || basicsTourRouletteTimer !== null;
}

function triggerTourRoulette(clickedDate) {
  if (basicsTourStep !== 1) return;
  const now = performance.now();
  if (now - basicsTourLastTriggerTime < 500) return;
  if (isTourRouletteRunning()) return;
  basicsTourLastTriggerTime = now;
  stopBasicsTourRoulette({ keepDate: true });
  if (clickedDate) {
    const dir = clickedDate > state.selected ? "forward" : clickedDate < state.selected ? "backward" : null;
    selectDate(clickedDate, dir, { silent: true, preview: true, animated: true });
  }
  startBasicsTourRoulette({ delay: 180, keepDate: true });
}

function stopBasicsTourEditorDemo() {
  while (basicsTourEditorTimers.length) {
    clearTimeout(basicsTourEditorTimers.pop());
  }
  const btn = document.getElementById("editor-btn");
  btn?.classList.remove("is-tour-pressed");
  if (basicsTourOpenedEditor && state.editorMode && !editorChangedEntries().length) {
    finishEditorMode();
    basicsTourOpenedEditor = false;
  }
}

function startBasicsTourEditorDemo() {
  stopBasicsTourEditorDemo();
  if (basicsTourStep !== 0) return;

  const scheduleTimer = (fn, delay) => {
    const t = window.setTimeout(() => {
      const idx = basicsTourEditorTimers.indexOf(t);
      if (idx !== -1) basicsTourEditorTimers.splice(idx, 1);
      fn();
    }, delay);
    basicsTourEditorTimers.push(t);
    return t;
  };

  // 1. Пауза, чтобы сориентироваться, затем визуальное нажатие на карандаш (~550ms)
  scheduleTimer(() => {
    if (basicsTourStep !== 0) return;
    const btn = document.getElementById("editor-btn");
    btn?.classList.add("is-tour-pressed");
  }, 550);

  // 2. Отпускание и плавное вылезание панели редактора (+160ms = 710ms)
  scheduleTimer(() => {
    if (basicsTourStep !== 0) return;
    const btn = document.getElementById("editor-btn");
    btn?.classList.remove("is-tour-pressed");
    if (!state.editorMode) {
      startEditorMode();
      basicsTourOpenedEditor = true;
    }
  }, 710);

  /* 3. Дальше панель остаётся открытой: редактор закроется только когда
     пользователь нажмёт «дальше» (или «пропустить»), а не сам по таймеру. */
}

function finishBasicsTour() {
  stopBasicsTourEditorDemo();
  stopBasicsTourRoulette();
  document.getElementById("basics-tour")?.remove();
  basicsTourStep = -1;
  document.body.classList.remove("is-tour-active", "is-tour-roulette-active");
  applyPerfMode();
  if (basicsTourOpenedEditor && state.editorMode && !editorChangedEntries().length) finishEditorMode();
  basicsTourOpenedEditor = false;
}

function renderBasicsTour() {
  stopBasicsTourRoulette();
  if (basicsTourStep !== 0 && state.editorMode && !editorChangedEntries().length) {
    finishEditorMode();
    basicsTourOpenedEditor = false;
  }
  const step = BASICS_TOUR[basicsTourStep];
  const target = step && document.querySelector(step.selector);
  if (!step || !target) { finishBasicsTour(); return; }
  let host = document.getElementById("basics-tour");
  if (!host) {
    host = document.createElement("div");
    host.id = "basics-tour";
    host.className = "sched-tour";
    host.setAttribute("role", "dialog");
    host.setAttribute("aria-modal", "true");
    host.setAttribute("aria-label", "обучение");
    document.body.appendChild(host);
  }
  const visualTarget = basicsTourStep === 2 && target.classList.contains("is-avatar")
    ? target.querySelector(".sched-trigger-avatar") || target
    : target;
  const rect = visualTarget.getBoundingClientRect();
  const pad = basicsTourStep === 1 ? 0 : basicsTourStep === 2 ? 3 : 4;
  const left = basicsTourStep === 1 ? Math.max(0, rect.left) : Math.max(8, rect.left - pad);
  const top = basicsTourStep === 1 ? Math.max(0, rect.top) : Math.max(8, rect.top - pad);
  const width = basicsTourStep === 1
    ? Math.min(innerWidth - left, rect.width)
    : Math.min(innerWidth - left - 8, rect.width + pad * 2);
  const height = rect.height + pad * 2;
  const copyWidth = Math.min(340, innerWidth - 24);
  const below = top + height + 14;

  let copyTop = below + 190 < innerHeight ? below : Math.max(12, top - 190);
  if (basicsTourStep === 0) {
    const strip = document.getElementById("strip");
    const stripRect = strip?.getBoundingClientRect();
    const copyTopStep0 = stripRect ? Math.round(stripRect.bottom + 105) : 225;
    if (copyTopStep0 + 175 < innerHeight) {
      copyTop = copyTopStep0;
    }
  }
  const copyLeft = Math.max(12, Math.min(innerWidth - copyWidth - 12, rect.left + rect.width / 2 - copyWidth / 2));
  const spotRadius = basicsTourStep === 1 ? 20 : 12;

  let spotlight = host.querySelector(".sched-tour-spotlight");
  let copy = host.querySelector(".sched-tour-copy");
  const isFirstRender = !spotlight || !copy;

  if (isFirstRender) {
    host.innerHTML = `<div class="sched-tour-spotlight" style="--tour-radius:${spotRadius}px;left:${left}px;top:${top}px;width:${width}px;height:${height}px;border-radius:${spotRadius}px"><svg aria-hidden="true"><rect pathLength="100" /></svg></div>
    <div class="sched-tour-copy" style="left:${copyLeft}px;top:${copyTop}px;width:${copyWidth}px">
      <div class="sched-tour-copy-inner">
        <span class="sched-tour-step-counter">шаг ${basicsTourStep + 1} из ${BASICS_TOUR.length}</span>
        <strong class="sched-tour-title">${step.title}</strong>
        <small class="sched-tour-text">${step.text}</small>
      </div>
      <div class="sched-tour-actions"><button type="button" data-tour="skip">пропустить</button><button class="is-primary" type="button" data-tour="next">${basicsTourStep + 1 === BASICS_TOUR.length ? "готово" : "дальше"}</button></div>
    </div>`;
    spotlight = host.querySelector(".sched-tour-spotlight");
    copy = host.querySelector(".sched-tour-copy");
    requestAnimationFrame(() => {
      host.classList.add("is-ready");
    });
  } else {
    const stepCounter = copy.querySelector(".sched-tour-step-counter");
    if (stepCounter) stepCounter.textContent = `шаг ${basicsTourStep + 1} из ${BASICS_TOUR.length}`;
    const stepTitle = copy.querySelector(".sched-tour-title");
    if (stepTitle) stepTitle.innerHTML = step.title;
    const stepText = copy.querySelector(".sched-tour-text");
    if (stepText) stepText.innerHTML = step.text;
    const nextBtn = copy.querySelector('[data-tour="next"]');
    if (nextBtn) nextBtn.textContent = basicsTourStep + 1 === BASICS_TOUR.length ? "готово" : "дальше";

    const inner = copy.querySelector(".sched-tour-copy-inner");
    if (inner) {
      inner.classList.remove("is-flowing");
      void inner.offsetWidth;
      inner.classList.add("is-flowing");
    }

    spotlight.style.setProperty("--tour-radius", `${spotRadius}px`);
    spotlight.style.borderRadius = `${spotRadius}px`;
    spotlight.style.left = `${left}px`;
    spotlight.style.top = `${top}px`;
    spotlight.style.width = `${width}px`;
    spotlight.style.height = `${height}px`;

    copy.style.left = `${copyLeft}px`;
    copy.style.top = `${copyTop}px`;
    copy.style.width = `${copyWidth}px`;
  }

  host.onclick = event => {
    const action = event.target.closest("[data-tour]")?.dataset.tour;
    if (action === "skip") { finishBasicsTour(); return; }
    if (action === "next") {
      stopBasicsTourEditorDemo();
      if (basicsTourStep === 0 && state.editorMode && !editorChangedEntries().length) {
        closeEditorAnimated();
        basicsTourOpenedEditor = false;
      }
      basicsTourStep += 1;
      if (basicsTourStep >= BASICS_TOUR.length) finishBasicsTour();
      else renderBasicsTour();
      return;
    }
    if (basicsTourStep === 0) {
      if (event.target.closest(".sched-tour-copy")) return;
      const btn = document.getElementById("editor-btn");
      if (btn) {
        const r = btn.getBoundingClientRect();
        if (
          event.clientX >= r.left &&
          event.clientX <= r.right &&
          event.clientY >= r.top &&
          event.clientY <= r.bottom
        ) {
          startBasicsTourEditorDemo();
        }
      }
      return;
    }
    if (basicsTourStep === 1) {
      if (event.target.closest(".sched-tour-copy")) return;
      const strip = document.getElementById("strip");
      if (strip) {
        const buttons = [...strip.querySelectorAll("button[data-date-index]")];
        const clickedBtn = buttons.find(btn => {
          const r = btn.getBoundingClientRect();
          return (
            event.clientX >= r.left &&
            event.clientX <= r.right &&
            event.clientY >= r.top &&
            event.clientY <= r.bottom
          );
        });
        if (clickedBtn && clickedBtn.dataset.date) {
          const [y, m, d] = clickedBtn.dataset.date.split("-").map(Number);
          triggerTourRoulette(new Date(y, m - 1, d));
        }
      }
      return;
    }
  };

  if (basicsTourStep === 0) {
    startBasicsTourEditorDemo();
  } else if (basicsTourStep === 1) {
    startBasicsTourRoulette({ delay: 650 });
  }
}

function startBasicsTour() {
  closeSettings();
  closeProfile();
  stopBasicsTourEditorDemo();
  if (state.editorMode && !editorChangedEntries().length) {
    finishEditorMode();
  }
  basicsTourOpenedEditor = false;
  basicsTourStep = 0;
  document.body.classList.add("is-tour-active");
  applyPerfMode();
  renderBasicsTour();
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

  $("#scene").addEventListener("click", event => {
    if (event.target.closest('[data-act="choose-group"]')) { openProfile(); return; }
    const editorAction = event.target.closest("[data-editor]");
    if (editorAction) {
      event.preventDefault();
      const action = editorAction.dataset.editor;
      if (action === "undo") undoEditorAction();
      else if (action === "reset-day") resetEditorDay(editorAction.dataset.date);
      else if (action === "cancel") cancelEditorMode();
      else if (action === "save") saveEditorMode();
      return;
    }
    const button = event.target.closest('[data-act="reset-day"]');
    if (button) { event.preventDefault(); resetDaySwaps(button.dataset.date); }
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
    if (act.dataset.act === "profile-tab") {
      const next = act.dataset.tab;
      if ((next === "profile" || next === "stats") && next !== profileView) {
        profileView = next;
        openProfile();
      }
      return;
    }
    if (act.dataset.act === "refresh-stats") {
      loadApplicationStats(true);
      return;
    }
    if (act.dataset.act === "repeat-tutorial-profile") {
      closeProfile();
      closeSettings();
      startBasicsTour();
      return;
    }
    if (act.dataset.act === "back") {
      closeProfile();
      openSettings();
      return;
    }
    if (act.dataset.act === "close") {
      closeProfile();
      closeSettings();
      return;
    } else if (act.dataset.act === "copy-id") copyTextToClipboard(act.dataset.id || "");
    else if (act.dataset.act === "tg-login") {
      startTelegramLogin();
    } else if (act.dataset.act === "local-tg-login") {
      startLocalTelegramLogin();
    } else if (act.dataset.act === "toggle-notifs") {
      toggleProfileNotifs(act);
    } else if (act.dataset.act === "open-tg") {
      openTgSheet();
      const role = myRole();
      if (role === "owner" || role === "editor") pullPending();
    } else if (act.dataset.act === "reset-all-swaps") {
      if (confirm("отменить все действующие замены для всех пар?")) {
        resetAllSwaps();
      }
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
      if (tgSessionVerified) syncTgSub({ quiet: true });
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
    if (kind === "next-telegram") {
      state.group = state.draftGroup;
      state.onboardingStep = 2;
      save();
      render();
      renderOnboarding();
      prepareTelegramLogin();
      return;
    }
    if (kind === "skip-onboarding") {
      state.group = state.draftGroup;
      closeOnboarding();
      render();
      return;
    }
    if (kind === "finish-tour" || kind === "finish-no-telegram") {
      state.group = state.draftGroup;
      document.body.classList.add("is-tour-active");
      applyPerfMode();
      closeOnboarding();
      render();
      window.setTimeout(startBasicsTour, 340);
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
  brand.setAttribute("aria-label", "воспроизвести анимацию sched");
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
  if (compactHeaderQuery.addEventListener)
    compactHeaderQuery.addEventListener("change", syncCompactHeader);
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
  window.setTimeout(() => trackStatsVisit(), 1000);

  if (!LOCAL_PREVIEW && "serviceWorker" in navigator && location.protocol.startsWith("http")) {
    /* Новая версия должна заменить уже открытую старую страницу, иначе в памяти
       остаются прежние строки и анимации даже после обновления файлов на GitHub. */
    const hadController = Boolean(navigator.serviceWorker.controller);
    let swReloading = false;
    let swReloadPending = false;
    const applyWorkerUpdateOffscreen = () => {
      if (!swReloadPending || swReloading || !document.hidden) return;
      swReloading = true;
      location.reload();
    };
    navigator.serviceWorker.addEventListener("controllerchange", () => {
      if (!hadController || swReloading) return;
      /* Не перезагружаем страницу перед глазами. Если вкладка сейчас видна,
         ждём её скрытия и применяем обновление в фоне. */
      swReloadPending = true;
      applyWorkerUpdateOffscreen();
    });
    document.addEventListener("visibilitychange", applyWorkerUpdateOffscreen);
    navigator.serviceWorker
      .register("sw.js", { updateViaCache: "none" })
      .then((registration) => {
        registration.update().catch(() => {});
        registration.waiting?.postMessage({ type: "skip-waiting" });
      })
      .catch(() => {});
  }
}

/* ---------- замена пары ---------- */

/* var намеренно: эти значения нужны раннему рендеру до конца модуля */
var SWAP_KEY = "sched:swaps:v1";
var swapMap = null;
var editorSession = null;
var ICON_UNDO = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 7 4 12l5 5"/><path d="M4 12h9a6 6 0 0 1 6 6"/></svg>';
var ICON_RESET = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 4v6h6"/><path d="M5.5 15a7 7 0 1 0 1.1-7.8L4 10"/></svg>';

function cloneSwapMap(map) {
  return JSON.parse(JSON.stringify(map || {}));
}

function activeSwapMap() {
  return state.editorMode && editorSession ? editorSession.draft : loadSwaps();
}

function playEditorToolbarOpen() {
  const toolbar = document.querySelector("#scene .sched-editor-toolbar");
  if (!toolbar || editorReducedMotion()) return;
  toolbar.classList.add("is-opening");
  window.setTimeout(() => toolbar.classList.remove("is-opening"), 420);
}

function startEditorMode() {
  if (state.editorMode) return;
  closeSettings();
  closeSwapSheet();
  const baseline = cloneSwapMap(loadSwaps());
  editorSession = { baseline, draft: cloneSwapMap(baseline), history: [] };
  state.editorMode = true;
  completedOpen = false;
  applyFlags();
  render();
  playEditorToolbarOpen();
}

function finishEditorMode() {
  state.editorMode = false;
  editorSession = null;
  closeSwapSheet();
  closeMoveSheet();
  applyFlags();
  render();
}

/* Закрытие редактора: панель и окна уезжают плавно, а оставшиеся пары
   доезжают на новые места (FLIP), а не прыгают одним кадром. */
const EDITOR_CLOSE_MS = 340;
const EDITOR_SETTLE_MS = 420;
let editorClosing = false;

function editorReducedMotion() {
  return (
    document.documentElement.hasAttribute("data-perf") ||
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

function lessonRowTops() {
  const map = new Map();
  document.querySelectorAll("#scene [data-day] .agenda-row[data-row-n]").forEach(row => {
    const day = row.closest("[data-day]")?.dataset.day;
    if (day) map.set(day + "|" + row.dataset.rowN, row.getBoundingClientRect().top);
  });
  return map;
}

function settleLessonRows(before) {
  if (!before || !before.size || editorReducedMotion()) return;
  document.querySelectorAll("#scene [data-day] .agenda-row[data-row-n]").forEach(row => {
    const day = row.closest("[data-day]")?.dataset.day;
    if (!day) return;
    const was = before.get(day + "|" + row.dataset.rowN);
    if (was === undefined) return;
    const delta = was - row.getBoundingClientRect().top;
    if (Math.abs(delta) < 1 || Math.abs(delta) > 700) return;
    row.animate(
      [{ transform: `translate3d(0, ${delta}px, 0)` }, { transform: "translate3d(0, 0, 0)" }],
      { duration: EDITOR_SETTLE_MS, easing: "cubic-bezier(0.16, 1, 0.3, 1)" },
    );
  });
}

function playEditorClose(done) {
  const scene = document.getElementById("scene");
  const toolbar = scene?.querySelector(".sched-editor-toolbar");
  const rows = scene ? [...scene.querySelectorAll(".agenda-row.is-window-row")] : [];
  if (editorReducedMotion() || (!toolbar && !rows.length)) {
    done(null);
    return;
  }
  toolbar?.classList.add("is-closing");
  /* Каскад снизу вверх: нижние окна сворачиваются раньше, и день
     собирается одной волной. */
  rows.forEach((row, i) => {
    row.style.setProperty("--sched-window-leave-height", row.offsetHeight + "px");
    row.style.setProperty("--sched-window-leave-delay", Math.min((rows.length - 1 - i) * 22, 88) + "ms");
    row.classList.add("is-window-leaving");
  });
  window.setTimeout(() => done(lessonRowTops()), EDITOR_CLOSE_MS);
}

function closeEditorAnimated() {
  if (!state.editorMode || editorClosing) {
    if (!editorClosing) finishEditorMode();
    return Promise.resolve();
  }
  editorClosing = true;
  document.body.classList.add("is-editor-closing");
  return new Promise(resolve => {
    playEditorClose(before => {
      editorClosing = false;
      document.body.classList.remove("is-editor-closing");
      finishEditorMode();
      if (before) window.requestAnimationFrame(() => settleLessonRows(before));
      resolve();
    });
  });
}

function cancelEditorMode(options = {}) {
  if (!state.editorMode || editorClosing) return;
  const changed = editorChangedEntries().length > 0;
  if (changed && !confirm("выйти из редактора и отменить несохранённые изменения?")) return;
  if (options.immediate) {
    finishEditorMode();
    return;
  }
  closeEditorAnimated();
}

function editorChangedEntries() {
  if (!editorSession) return [];
  const keys = new Set([...Object.keys(editorSession.baseline), ...Object.keys(editorSession.draft)]);
  return [...keys].filter(key => JSON.stringify(editorSession.baseline[key] || null) !== JSON.stringify(editorSession.draft[key] || null));
}

function undoEditorAction() {
  if (!state.editorMode || !editorSession?.history.length) return;
  editorSession.draft = editorSession.history.pop();
  render();
}

function editorDayPrefix(dIso) {
  return (state.group || DEFAULT_GROUP) + "|" + dIso + ":";
}

function publishedSwapMap() {
  return loadSwaps();
}

function editorDayKeys(dIso) {
  const prefix = editorDayPrefix(dIso);
  return [...new Set([
    ...Object.keys(publishedSwapMap()).filter(key => key.startsWith(prefix)),
    ...Object.keys(editorSession?.draft || {}).filter(key => key.startsWith(prefix)),
  ])];
}

function publishedSwap(key) {
  const entry = publishedSwapMap()[key];
  return entry && !entry.deleted ? entry : null;
}

function restoreEditorSwap(key) {
  const confirmed = publishedSwap(key);
  if (confirmed) editorSession.draft[key] = cloneSwapMap(confirmed);
  else delete editorSession.draft[key];
}

function resetEditorDay(dIso) {
  if (!state.editorMode || !editorSession || !dIso) return;
  /* «Исходный день» = официальное расписание + текущие опубликованные замены,
     а не снимок черновика на входе в редактор. */
  const dayKeys = editorDayKeys(dIso);
  const changed = dayKeys.filter(key =>
    JSON.stringify(publishedSwap(key) || null) !== JSON.stringify(editorSession.draft[key] && !editorSession.draft[key].deleted ? editorSession.draft[key] : null)
  );
  if (!changed.length) {
    toast("этот день и так исходный");
    return;
  }
  editorSession.history.push(cloneSwapMap(editorSession.draft));
  dayKeys.forEach(restoreEditorSwap);
  render();
  toast("день возвращён к исходному расписанию");
}

async function saveEditorMode() {
  if (!state.editorMode || !editorSession) return;
  const changedKeys = editorChangedEntries();
  if (!changedKeys.length) {
    toast("изменений нет");
    await closeEditorAnimated();
    return;
  }
  const map = loadSwaps();
  const entries = {};
  const updatedAt = Math.max(Date.now(), ...Object.values(map).map(entry => Number(entry?.updatedAt) + 1 || 0));
  const operationId = crypto.randomUUID ? crypto.randomUUID() : updatedAt.toString(36) + Math.random().toString(36).slice(2);
  changedKeys.forEach(key => {
    const draft = editorSession.draft[key];
    const entry = draft ? { ...draft, updatedAt } : { deleted: true, updatedAt };
    if (changedKeys.length > 1) {
      entry.operationId = operationId;
      entry.operationSize = changedKeys.length;
    }
    map[key] = entry;
    entries[key] = entry;
  });
  saveSwaps();
  const role = myRole();
  await closeEditorAnimated();
  if (sharedSwapsEnabled()) {
    const ok = await publishSwapBatch(entries, role === "user" ? "предложены изменения расписания" : "сохранены изменения расписания");
    if (!ok) toast(cloudFailHint());
  } else {
    toast("изменения сохранены на этом устройстве");
  }
}

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

function setSwap(dIso, n, value) { return applyDayChanges(dIso, { [n]: value }); }

function applyDayChanges(dIso, changes, label = "замена") {
  const keys = Object.keys(changes).filter(n => Number.isInteger(Number(n)) && Number(n) >= 1 && Number(n) <= 6);
  if (!keys.length) return false;
  if (state.editorMode && editorSession) {
    editorSession.history.push(cloneSwapMap(editorSession.draft));
    const updatedAt = Date.now();
    keys.forEach(n => {
      const key = swapKey(dIso, Number(n));
      const value = changes[n];
      if (value === null) delete editorSession.draft[key];
      else editorSession.draft[key] = { ...value, updatedAt };
    });
    return true;
  }
  const map = loadSwaps();
  const updatedAt = Math.max(Date.now(), ...Object.values(map).map(entry => Number(entry?.updatedAt) + 1 || 0));
  const operationId = crypto.randomUUID ? crypto.randomUUID() : updatedAt.toString(36) + Math.random().toString(36).slice(2);
  const entries = {};
  for (const n of keys) {
    const key = swapKey(dIso, Number(n));
    const value = changes[n];
    if (value === null && !sharedSwapsEnabled()) { delete map[key]; continue; }
    const entry = { ...(value || { deleted: true }), updatedAt };
    if (keys.length > 1) { entry.operationId = operationId; entry.operationSize = keys.length; }
    map[key] = entry; entries[key] = entry;
  }
  saveSwaps();
  if (Object.keys(entries).length) {
    const expectedCloudWrite = sharedSwapsEnabled() && myRole() !== "anon";
    publishSwapBatch(entries, label)
      .then(ok => { if (expectedCloudWrite && !ok) toast(cloudFailHint()); })
      .catch(error => { if (expectedCloudWrite) toast(error?.message || cloudFailHint()); });
  }
  return true;
}

function normalizeMoveChanges(dIso, changes) {
  const base = slotsForBase(dateFromIso(dIso));
  const normalized = { ...changes };
  Object.keys(normalized).forEach(key => {
    const n = Number(key), next = normalized[key], original = base.find(slot => slot.n === n);
    if (!original || !next) return;
    const sameWindow = Boolean(next.makeWindow) && Boolean(original.window || original.empty);
    const sameLesson = !next.makeWindow && !original.window && !original.empty &&
      (next.subject || "") === (original.subject || "") &&
      (next.teacher || "") === (original.teacher || "") &&
      (next.room || "") === (original.room || "") &&
      Boolean(next.self) === Boolean(original.self);
    if (sameWindow || sameLesson) normalized[key] = null;
  });
  return normalized;
}

function movePair(dIso, fromN, toN) {
  const slots = slotsFor(dateFromIso(dIso));
  const target = slots.find(slot => slot.n === toN);
  const changes = normalizeMoveChanges(dIso, planPairSwap(slots, fromN, toN));
  if (!applyDayChanges(dIso, changes, `перенос ${fromN} ↔ ${toN}`)) return false;
  toast(target?.window || target?.cancelled ? `пара перенесена на ${toN}-е место · прежнее место — окно` : "пары поменяны местами");
  render();
  return true;
}

function movePairRelative(dIso, fromN, toN, after) {
  const changes = normalizeMoveChanges(dIso, planPairInsert(slotsFor(dateFromIso(dIso)), fromN, toN, after));
  if (!applyDayChanges(dIso, changes, "изменён порядок пар")) return false;
  toast("порядок пар изменён");
  render();
  return true;
}

function movePairToEdge(dIso, fromN, after) {
  const pairs = slotsFor(dateFromIso(dIso)).filter(slot => !slot.window && !slot.cancelled);
  const target = after ? pairs.at(-1) : pairs[0];
  if (!target) return false;
  const changes = normalizeMoveChanges(dIso, planPairInsert(pairs, fromN, target.n, after));
  if (!applyDayChanges(dIso, changes, after ? "пара перенесена в конец дня" : "пара перенесена в начало дня")) return false;
  toast(after ? "пара стала последней · окна сохранены" : "пара стала первой · окна сохранены");
  render();
  return true;
}

function dayRevertHtml(dIso) {
  return `<button class="sched-day-revert" type="button" data-act="reset-day" data-date="${dIso}" ${hasDaySwaps(dIso) ? "" : "hidden"}
      aria-label="вернуть исходные пары: ${escapeHtml(dateLabel(dateFromIso(dIso)))}" title="вернуть исходное расписание только этого дня">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 4-5 5 5 5"/><path d="M4 9h10a6 6 0 0 1 0 12h-3"/></svg>
      <span class="sched-day-revert-label">вернуть</span>
    </button>`;
}

function closeMoveSheet() {
  document.getElementById("move-backdrop")?.remove();
}

function openMoveSheet(dIso, n) {
  document.getElementById("sched-toast-container")?.replaceChildren();
  closeMoveSheet();
  closeSwapSheet();
  const slots = slotsFor(dateFromIso(dIso));
  const source = slots.find(slot => slot.n === n);
  if (!source || source.window || source.cancelled) return;
  const pairs = slots.filter(slot => !slot.window && !slot.cancelled);
  const backdrop = document.createElement("div");
  backdrop.id = "move-backdrop";
  backdrop.className = "sched-replace-backdrop is-open";
  backdrop.innerHTML = `<div class="sched-replace-sheet sched-move-sheet" role="dialog" aria-modal="true" aria-labelledby="move-title">
    <div class="sched-replace-head"><strong id="move-title">куда перенести пару?</strong><span>${escapeHtml(source.subject)} · ${n} пара · ${escapeHtml(dateLabel(dateFromIso(dIso)))}</span></div>
    <p class="sched-move-help">выбери время. в окне пара займёт свободное место; занятые пары поменяются местами.</p>
    <div class="sched-move-targets">${slots.map(slot => `<button class="sched-move-target${slot.n === n ? " is-source" : ""}" type="button" data-move-to="${slot.n}" ${slot.n === n ? 'disabled aria-current="true"' : ""}>
      <span class="sched-move-number">${slot.n}</span><span class="sched-move-target-copy"><strong>${escapeHtml(slot.window || slot.cancelled ? "окно" : slot.subject)}</strong>
      <small>${slot.from}–${slot.to} · ${slot.n === n ? "текущее место" : slot.window || slot.cancelled ? "перенести сюда" : "поменять местами"}</small></span>${slot.n === n ? ICON_CHECK : ICON_CHEVRON}</button>`).join("")}</div>
    <div class="sched-move-edges"><button type="button" data-move-edge="top" ${pairs[0]?.n === n ? "disabled" : ""}>в начало дня</button><button type="button" data-move-edge="bottom" ${pairs.at(-1)?.n === n ? "disabled" : ""}>в конец дня</button></div>
    <p class="sched-move-help">при переносе в начало или конец порядок остальных пар сдвигается, окна остаются на месте.</p>
    <div class="sched-replace-actions"><button type="button" data-move-close>отмена</button></div>
    ${swapAccessHint()}
  </div>`;
  document.body.appendChild(backdrop);
  const close = () => {
    closeMoveSheet();
    document.querySelector(`[data-act="swap"][data-date="${dIso}"][data-n="${n}"]`)?.focus({ preventScroll: true });
  };
  backdrop.addEventListener("click", event => {
    const target = event.target.closest("[data-move-to]");
    const edge = event.target.closest("[data-move-edge]");
    if (target && !target.disabled) { closeMoveSheet(); movePair(dIso, n, Number(target.dataset.moveTo)); }
    else if (edge && !edge.disabled) { closeMoveSheet(); movePairToEdge(dIso, n, edge.dataset.moveEdge === "bottom"); }
    else if (event.target === backdrop || event.target.closest("[data-move-close]")) close();
  });
  backdrop.addEventListener("keydown", event => {
    if (event.key === "Escape") { event.stopPropagation(); close(); }
    if (event.key === "Tab") {
      const buttons = [...backdrop.querySelectorAll("button:not(:disabled)")];
      if (event.shiftKey && document.activeElement === buttons[0]) { event.preventDefault(); buttons.at(-1)?.focus(); }
      else if (!event.shiftKey && document.activeElement === buttons.at(-1)) { event.preventDefault(); buttons[0]?.focus(); }
    }
  });
  backdrop.querySelector("[data-move-to]:not(:disabled)")?.focus({ preventScroll: true });
}

/* Базовое расписание лежит в slotsForBase, а здесь накладываются замены. */
function slotsFor(d) {
  const list = slotsForBase(d);
  if (!list.length) return list;
  const map = activeSwapMap();
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
    next.origSubject = slot.subject || "";
    next.origTeacher = slot.teacher || "";
    next.origRoom = slot.room || "";
    next.origSelf = Boolean(slot.self);
    next.moved = Boolean(sw.moved);
    if (sw.movedFrom) next.movedFrom = sw.movedFrom;
    if (sw.makeWindow) {
      /* Пару утащили на место окна перетаскиванием — на её прежнем месте
         показываем окно: окно не пропадает, а переезжает вместе с парой. */
      next.window = true;
      next.empty = true;
      next.self = false;
      next.swapped = true;
      next.subject = "";
      next.teacher = "";
      next.room = "";
      delete next.cancelled;
      return next;
    }
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
    if (sw.self !== undefined) next.self = Boolean(sw.self);
    if (sw.teacher !== undefined) next.teacher = sw.teacher;
    if (sw.room !== undefined) next.room = sw.room;
    next.swapped = true;
    return next;
  });
}

function hasDaySwaps(dIso) {
  if (!dIso) return false;
  const map = activeSwapMap();
  const prefix = (state.group || DEFAULT_GROUP) + "|" + dIso + ":";
  for (const key in map) {
    if (key.indexOf(prefix) === 0 && map[key] && !map[key].deleted) {
      return true;
    }
  }
  return false;
}

async function resetDaySwaps(dIso) {
  if (!dIso) return;
  const prefix = (state.group || DEFAULT_GROUP) + "|" + dIso + ":";
  const changes = {};
  for (const [key, value] of Object.entries(activeSwapMap())) {
    if (key.startsWith(prefix) && value && !value.deleted) changes[Number(key.slice(prefix.length))] = null;
  }
  if (!applyDayChanges(dIso, changes, "возвращено исходное расписание дня")) return;
  render(); toast("возвращены исходные пары только этого дня");
}

async function resetAllSwaps() {
  const map = loadSwaps();
  const prefix = (state.group || DEFAULT_GROUP) + "|";
  let count = 0;
  const now = Date.now();
  for (const key in map) {
    if (key.indexOf(prefix) === 0 && (!map[key].deleted)) {
      map[key] = { deleted: true, updatedAt: now };
      publishSwapKey(key);
      count++;
    }
  }
  saveSwaps();
  render();
  toast(count > 0 ? "все замены отменены (" + count + ")" : "нет активных замен");
}

function updateDayRevertBtn() {
  document.querySelectorAll('.sched-day-block[data-day] .sched-day-revert').forEach(button => {
    button.hidden = !hasDaySwaps(button.dataset.date);
  });
}

var ICON_SWAP =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" aria-hidden="true"><path d="M4 8h13l-3.5-3.5M20 16H7l3.5 3.5"/></svg>';

function swapButtonHtml(dIso, n, isWindow) {
  if (!dIso || !state.editorMode) return "";
  const title = isWindow ? "добавить или изменить пару" : "изменить или перенести пару — нажми или потяни";
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
  backdrop.remove();
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
  document.getElementById("sched-toast-container")?.replaceChildren();
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
  const initialType = lessonType(slot);

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
          "</option>",
      ),
    )
    .join("");

  const backdrop = document.createElement("div");
  backdrop.id = "swap-backdrop";
  backdrop.className = "sched-replace-backdrop";
  backdrop.innerHTML =
    '<div class="sched-replace-sheet" role="dialog" aria-label="' +
    sheetTitle +
    '">' +
    '<div class="sched-replace-head"><strong>' +
    sheetTitle +
    "</strong><span>" +
    escapeHtml(n + " пара" + (timeText ? " · " + timeText : "") + " · " + dateLabel(d)) +
    "</span></div>" +
    '<label class="sched-replace-field"><span>тип пары</span>' +
    '<div class="sched-replace-select"><select id="swap-type">' +
    [["lesson", "обычная пара"], ["self", "самостоятельная работа"], ["vacancy", "вакансия"]]
      .map(([value, label]) => `<option value="${value}"${value === initialType ? " selected" : ""}>${label}</option>`).join("") +
    "</select></div></label>" +
    '<label class="sched-replace-field"><span>предмет из расписания</span>' +
    '<div class="sched-replace-select"><select id="swap-subject">' +
    options +
    "</select></div></label>" +
    '<label class="sched-replace-field"><span>или свой предмет</span>' +
    '<input id="swap-subject-custom" type="text" value="' +
    escapeHtml(customSubject) +
    '" placeholder="название предмета" /></label>' +
    '<div class="sched-replace-meta-grid"><label class="sched-replace-field"><span>преподаватель</span>' +
    '<input id="swap-teacher" type="text" value="' +
    escapeHtml(teacher) +
    '" placeholder="фамилия" /></label>' +
    '<label class="sched-replace-field"><span>аудитория</span>' +
    '<input id="swap-room" type="text" value="' +
    escapeHtml(room) +
    '" placeholder="номер" /></label></div>' +
    '<p class="sched-replace-hint">выбрал предмет из списка — преподаватель и аудитория подставятся сами; вписал свой предмет — они сбросятся</p>' +
    '<div class="sched-replace-actions">' +
    '<button class="is-primary" type="button" data-swap="save">' +
    swapPrimaryLabel() +
    "</button>" +
    /* В окне отменять нечего — пары там нет. */
    (isWindowSlot ? "" : '<button type="button" data-swap="cancel-lesson">отменить пару</button>') +
    '<button type="button" data-swap="reset">вернуть как было</button>' +
    '<button type="button" data-swap="close">закрыть</button>' +
    "</div>" +
    swapAccessHint() +
    "</div>";

  document.body.appendChild(backdrop);
  window.requestAnimationFrame(() => backdrop.classList.add("is-open"));

  const picker = backdrop.querySelector("#swap-subject");
  const custom = backdrop.querySelector("#swap-subject-custom");
  const teacherField = backdrop.querySelector("#swap-teacher");
  const roomField = backdrop.querySelector("#swap-room");
  const typeField = backdrop.querySelector("#swap-type");
  let teacherBeforeVacancy = initialType === "vacancy" ? "" : teacherField.value;
  const syncType = () => {
    const vacancy = typeField.value === "vacancy";
    if (vacancy) {
      if (!isVacancy({ teacher: teacherField.value })) teacherBeforeVacancy = teacherField.value;
      teacherField.value = "вакансия";
    } else if (isVacancy({ teacher: teacherField.value })) {
      teacherField.value = teacherBeforeVacancy;
    }
    teacherField.disabled = vacancy;
  };
  typeField.addEventListener("change", syncType);
  syncType();
  /* Подставленное автоматически можно сбрасывать, вписанное руками — нет. */
  let autoFilled =
    Boolean(known) && teacher === (known.teacher || "") && room === (known.room || "");

  picker.addEventListener("change", () => {
    const option = picker.options[picker.selectedIndex];
    if (!picker.value || !option) return;
    custom.value = "";
    const catalogTeacher = option.dataset.teacher || "";
    teacherBeforeVacancy = isVacancy({ teacher: catalogTeacher }) ? "" : catalogTeacher;
    teacherField.value = typeField.value === "vacancy" ? "вакансия" : teacherBeforeVacancy;
    roomField.value = option.dataset.room || "";
    // Autofill must preserve the explicitly chosen type.
    syncType();
    autoFilled = true;
  });

  custom.addEventListener("input", () => {
    if (!custom.value.trim()) return;
    if (picker.value) picker.value = "";
    if (autoFilled) {
      teacherField.value = "";
      roomField.value = "";
      autoFilled = false;
      teacherBeforeVacancy = "";
      syncType();
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
    if (act === "move") { openMoveSheet(dIso, n); return; }
    if (act === "close") {
      closeSwapSheet();
      return;
    }
    if (act === "reset") {
      const key = swapKey(dIso, n);
      const confirmed = state.editorMode && editorSession ? publishedSwap(key) : null;
      setSwap(dIso, n, confirmed ? cloneSwapMap(confirmed) : null);

      commit();
      return;
    }
    if (act === "cancel-lesson") {
      if (isWindowSlot) {
        toast("в окне нет пары — отменять нечего");
        return;
      }
      setSwap(dIso, n, { cancelled: true });

      commit();
      return;
    }
    const nextSubject = custom.value.trim() || picker.value.trim();
    const nextTeacher = typeField.value === "vacancy" ? "вакансия" : teacherField.value.trim();
    const nextRoom = roomField.value.trim();
    const nextSelf = typeField.value === "self";
    if (!nextSubject && !nextTeacher && !nextRoom && !nextSelf) {
      setSwap(dIso, n, null);

      commit();
      return;
    }
    const baseSlots = slotsForBase(d);
    const baseSlot = baseSlots.find((s) => s.n === n) || null;
    if (!nextSubject && (nextTeacher || nextRoom || nextSelf)) {
      toast("выбери предмет или впиши его название");
      custom.focus();
      return;
    }
    // A no-op save must not clear an existing transfer marker or publish a new edit.
    if (slot && !slot.window && !slot.cancelled && nextSubject === (slot.subject || "") &&
      nextTeacher === (slot.teacher || "") && nextRoom === (slot.room || "") && nextSelf === Boolean(slot.self)) {
      commit();
      return;
    }
    if (
      baseSlot &&
      !baseSlot.window &&
      !baseSlot.empty &&
      nextSubject.toLowerCase() === (baseSlot.subject || "").trim().toLowerCase() &&
      nextTeacher.toLowerCase() === (baseSlot.teacher || "").trim().toLowerCase() &&
      nextRoom.toLowerCase() === (baseSlot.room || "").trim().toLowerCase() &&
      nextSelf === Boolean(baseSlot.self)
    ) {
      setSwap(dIso, n, null);
      toast("замена совпадает с расписанием — возвращено как было");
      commit();
      return;
    }
    setSwap(dIso, n, { subject: nextSubject, teacher: nextTeacher, room: nextRoom, self: nextSelf });
    if ((nextTeacher === "вакансия" && !state.showVacancies) || (nextSelf && !state.showSelfStudy)) {
      toast("пара сохранена · её показ выключен в настройках");
    }

    commit();
  });
}

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    closeMoveSheet();
    closeSwapSheet();
    closeTgSheet();
    closeUpdatesSheet();
  }
});

var swapDragSuppressUntil = 0;

(() => {
  const scene = document.getElementById("scene");
  if (!scene) return;
  scene.addEventListener("click", (e) => {
    /* После перетаскивания пары клик по кнопке замены глушим — иначе поверх
       результата открывалась бы шторка редактирования. */
    if (Date.now() < swapDragSuppressUntil) return;
    const btn = e.target.closest('[data-act="swap"]');
    if (!btn || !state.editorMode) return;
    e.preventDefault();
    e.stopPropagation();
    openSwapSheet(btn.dataset.date, Number(btn.dataset.n));
  });
  scene.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      const btn = e.target.closest('[data-act="swap"]');
      if (btn && state.editorMode) {
        e.preventDefault();
        e.stopPropagation();
        openSwapSheet(btn.dataset.date, Number(btn.dataset.n));
      }
    }
  });
})();

/* Shared movement controller for all lesson card types. */
bindPairDrag({
  scene: document.getElementById("scene"),
  /* Те же строки, что и на экране: иначе в режиме редактора превью переноса
     собиралось из другого набора пар и места путались. */
  slotsForDate: date => visibleSlotsFor(dateFromIso(date)), renderRow: (slot, date) => rowHtml(slot, null, date),
  onSwap: movePair, onReorder: (date, from, to) => movePairRelative(date, from, to, to > from),
  onActiveChange: active => {
    pairDragActive = active;
    if (active) daySwipeController?.cancel();
    else swapDragSuppressUntil = Date.now() + 400;
  },
  onFinish: () => { if (pairRenderPending) { pairRenderPending = false; render(); } },
});

/* ---------- автообновление расписания ----------
   data/schedule.json пересобирает GitHub Action каждые 3 часа из PDF
   на sustec.ru, а приложение с тем же шагом его перечитывает. */
var SCHEDULE_URL = "data/schedule.json";
var SCHEDULE_CACHE_KEY = "sched:schedule-cache:v2";
var SCHEDULE_TTL = 3 * 60 * 60 * 1000;
var scheduleFetchedAt = 0;
var SCHEDULE_CHECKED_KEY = "sched:schedule-checked-at:v1";
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
    out[key.indexOf("|") === -1 ? "тм-303/б|" + key : key] = data[key];
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
    notifyAboutScheduleStamp(payload.updatedAt, payload.groups);
    scheduleUpdatedAt = payload.checkedAt || payload.updatedAt;
  }
  renderDataStamp();
  const el = $("#freshness");
  if (!el || !payload || !(payload.checkedAt || payload.updatedAt)) return;
  const when = new Date(payload.checkedAt || payload.updatedAt);
  if (Number.isNaN(when.getTime())) return;
  const hh = String(when.getHours()).padStart(2, "0");
  const mm = String(when.getMinutes()).padStart(2, "0");
  el.textContent = "расписание обновлено в " + hh + ":" + mm;
}

function applySchedulePayload(payload) {
  return scheduleModule().then((apply) => {
    if (typeof apply !== "function") return false;
    if (!apply(payload)) return false;
    scheduleRevision += 1;
    if (!GROUPS.some((g) => g.id === state.group)) {
      state.group = "";
      state.draftGroup = state.group;
      save();
    }
    scheduleStamp(payload);
    renderPassive();
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
  scheduleRetryTimer = window.setTimeout(
    function () {
      refreshSchedule(true).then(planScheduleRetry);
    },
    5 * 60 * 1000,
  );
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
      "https://ТВОЙ-ПРОЕКТ-default-rtdb.РЕГИОН.firebasedatabase.app"
   2) корзина Pantry (getpantry.cloud):
      "https://getpantry.cloud/apiv1/pantry/ТВОЙ-ID/basket/sched-swaps";
   Пустая строка = замены хранятся только на устройстве, как раньше.
   Проверить без правки кода можно параметром ?swaps-cloud=адрес. */
/* Конфиг переехал в js/config.js — правь там, этот файл больше не трогай.
   Читаем из window с запасными значениями на случай если config.js не загрузился. */
var SHARED_SWAPS_URL = window.SHARED_SWAPS_URL || "";
var FIREBASE_API_KEY = window.FIREBASE_API_KEY || "";
var TELEGRAM_BOT_NAME = window.TELEGRAM_BOT_NAME || "";
/* Жёсткое назначение ролей через переменные окружения (без облака):
   TELEGRAM_OWNER_ID — один телеграм id владельца, TELEGRAM_ADMIN_IDS — id редакторов через запятую. */
var TELEGRAM_OWNER_ID = String(window.TELEGRAM_OWNER_ID || "").trim();
var TELEGRAM_ADMIN_IDS = String(window.TELEGRAM_ADMIN_IDS || "")
  .split(",")
  .map(function (s) {
    return s.trim();
  })
  .filter(Boolean);
var sharedSync = { pushing: false, again: false, poll: null };

/* Firebase uses server-signed Telegram identities, never anonymous device bindings. */
var fbAuth = { token: null, uid: null, telegramId: null, expiresAt: 0, pending: null };
function firebaseAuthEnabled() {
  return Boolean(FIREBASE_API_KEY) && /\.(firebaseio\.com|firebasedatabase\.app)/.test(sharedSwapsUrl());
}
async function fbAuthPost(url, body) {
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 10000);
  try {
    const response = await fetch(url + "?key=" + encodeURIComponent(FIREBASE_API_KEY), {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
      signal: controller.signal, credentials: "omit", cache: "no-store", referrerPolicy: "no-referrer",
    });
    if (!response.ok) throw new BotApiError("firebase не подтвердил вход (" + response.status + ") — проверь ключ проекта", response.status, "firebase_auth");
    return response.json();
  } finally { clearTimeout(timer); }
}
async function ensureFbToken() {
  if (!firebaseAuthEnabled() || !tgSession?.session_token) return null;
  const sessionToken = await ensurePushSession();
  const identity = tgSession.id, epoch = tgAuthEpoch;
  if (fbAuth.telegramId === identity && fbAuth.token && Date.now() < fbAuth.expiresAt - 60000) return fbAuth.token;
  if (fbAuth.pending) return fbAuth.pending;
  const holder = fbAuth;
  const promise = (async () => {
    const signed = await botRequest("auth/firebase", {}, sessionToken, { retries: 0 });
    if (!signed.custom_token) throw new BotApiError("обнови папку bot: сервер не выдал firebase-токен", 503, "firebase_not_configured");
    const fresh = await fbAuthPost("https://identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken", { token: signed.custom_token, returnSecureToken: true });
    if (epoch !== tgAuthEpoch || tgSession?.id !== identity) throw new BotApiError("аккаунт изменился — действие отменено", 409, "cancelled");
    const tokenUid = (() => {
      try {
        const payload = JSON.parse(atob(String(fresh.idToken || "").split(".")[1].replace(/-/g, "+").replace(/_/g, "/")));
        return String(payload.user_id || payload.sub || "");
      } catch (_) { return ""; }
    })();
    const firebaseUid = String(fresh.localId || tokenUid || "");
    if (!fresh.idToken || firebaseUid !== "telegram:" + identity)
      throw new BotApiError("firebase вернул другой аккаунт", 401, "firebase_identity");
    holder.token = fresh.idToken; holder.uid = firebaseUid; holder.telegramId = identity;
    holder.expiresAt = Date.now() + Number(fresh.expiresIn || 3600) * 1000;
    return holder.token;
  })();
  holder.pending = promise;
  try { return await promise; } finally { if (holder.pending === promise) holder.pending = null; }
}
async function sharedUrlWithAuth(url, forceFresh = false) {
  const target = new URL(url);
  if (target.origin !== new URL(sharedSwapsUrl()).origin) throw new Error("неверный адрес общей базы");
  if (forceFresh) resetFirebaseIdentity();
  const token = await ensureFbToken();
  if (token) target.searchParams.set("auth", token);
  return target.href;
}
function sharedSwapsUrl() {
  if (LOCAL_PREVIEW || !SHARED_SWAPS_URL) return "";
  try {
    const url = new URL(SHARED_SWAPS_URL);
    if (url.protocol !== "https:" || url.username || url.password) return "";
    if (/\.(firebaseio\.com|firebasedatabase\.app)$/.test(url.hostname) && !url.pathname.endsWith(".json")) {
      url.pathname = url.pathname.replace(/\/$/, "") + "/" + CLOUD_PATHS.swaps + ".json";
    }
    return url.href;
  } catch (_) { return ""; }
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

/* ---------- Telegram: only server-verified identities have shared rights ---------- */
var TG_SESSION_KEY = "sched:tg-session:v1";
var tgSession = null;
var tgSessionVerified = false;
var tgRoles = { owner: null, editors: {}, boundTg: null };
var pendingMap = {};
var tgRegisterState = "idle";
var tgAuthEpoch = 0;
var tgVerifyPending = null;
var tgVerifiedUntil = 0;
var tgAuthRetryAt = 0;
var tgAuthError = null;
var tgAuthState = "idle";
var tgRolesPending = null;
var telegramLogin = new TelegramLogin({
  request: (path, data) => botRequest(path, data),
  authOrigin: new URL(window.SCHED_NOTIFY_URL || location.origin, location.href).origin,
  onSession: result => applyTgSession(result), onChange: () => renderLoginPanels(),
});
function renderLoginPanels() {
  document.querySelectorAll('[data-login-panel]').forEach(el => {
    el.innerHTML = tgSession
      ? '<strong class="sched-onboarding-linked">telegram уже привязан</strong>'
      : authButtonHtml(telegramLogin?.snapshot, LOCAL_PREVIEW);
  });
}
document.addEventListener('click', event => {
  const action = event.target.closest('[data-auth-action]');
  if (!action || action.disabled) return;
  event.preventDefault(); event.stopPropagation();
  if (action.dataset.authAction === 'login') startTelegramLogin();
  else if (action.dataset.authAction === 'retry') ensurePushSession(true).catch(error => toast(error.message));
}, true);

function localTelegramIdentity() {
  return { id: "local-demo", first_name: "тестовый", last_name: "профиль", username: "sched_local", isLocalDemo: true };
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
  return Boolean(window.SCHED_NOTIFY_URL);
}

function tgDisplayName(user) {
  if (!user) return "участник";
  const full = [user.first_name, user.last_name].filter(Boolean).join(" ").trim();
  return full || (user.username ? "@" + user.username : "участник");
}

function telegramSessionFromResult(result) {
  if (!result?.ok || !result.session_token || !result.id) {
    throw new BotApiError("сервер не выдал сессию sched — обнови папку bot", 503, "server_update_required");
  }
  const user = result.user || result;
  return {
    id: String(result.id), first_name: user.first_name || "", last_name: user.last_name || "",
    username: user.username || "", photo_url: user.photo_url || "", hash: "session",
    auth_date: result.auth_date || user.ts || Math.floor(Date.now() / 1000),
    expires_at: result.expires_at || ((result.auth_date || user.ts || Math.floor(Date.now() / 1000)) + 30 * 86400),
    role: result.role || "user", session_token: result.session_token,
  };
}

function authStatusHtml() {
  const message = tgAuthState === "checking" ? "проверяем вход…"
    : tgAuthState === "offline" ? "нет связи с сервером входа. профиль сохранён; общие правки пока недоступны."
    : tgAuthState === "needs_login" ? "нужно один раз войти заново: для уведомлений теперь используется подтверждённая сессия sched."
    : "";
  if (!message) return "";
  return `<div class="sched-auth-status" role="status"><p>${escapeHtml(message)}</p>${tgAuthState === "offline"
    ? '<button type="button" data-auth-action="retry">повторить проверку</button>' : ""}</div>`;
}

function refreshAuthUi() {
  applyFlags();
  updateTgButton();
  renderTgSheetBody();
  if (state.profileOpen) {
    const backdrop = $("#profile-backdrop");
    const content = backdrop?.querySelector(".sched-profile-content");
    const scrollTop = content?.scrollTop || 0;
    const notifsOpen = backdrop?.querySelector("#profile-notifs-toggle")?.getAttribute("aria-expanded") === "true";
    backdrop?.classList.add("is-refreshing");
    openProfile();
    const freshContent = backdrop?.querySelector(".sched-profile-content");
    if (freshContent) freshContent.scrollTop = scrollTop;
    if (notifsOpen) {
      const toggle = backdrop?.querySelector("#profile-notifs-toggle");
      const panel = backdrop?.querySelector("#profile-notifs-panel");
      toggle?.setAttribute("aria-expanded", "true");
      panel?.classList.add("is-open");
      panel?.setAttribute("aria-hidden", "false");
      if (panel) panel.inert = false;
    }
    requestAnimationFrame(() => requestAnimationFrame(() => backdrop?.classList.remove("is-refreshing")));
  }
}

function resetFirebaseIdentity() {
  fbAuth = { token: null, refresh: null, uid: null, telegramId: null, expiresAt: 0, pending: null };
  tgRegisterState = "idle";
  try { localStorage.removeItem("sched:fb-auth:v1"); } catch (_) {}
}

function invalidateTelegramSession(error, token) {
  if (token !== undefined && token !== (tgSession?.session_token || "")) return;
  tgAuthEpoch++;
  tgSession = null;
  tgSessionVerified = false;
  tgVerifiedUntil = 0;
  tgVerifyPending = null;
  tgAuthState = "needs_login";
  tgAuthError = error;
  tgRoles = { owner: null, editors: {}, boundTg: null };
  pendingMap = {};
  resetFirebaseIdentity();
  saveTgSession();
  refreshAuthUi();
}

async function ensurePushSession(force = false) {
  if (LOCAL_PREVIEW) return "";
  if (tgVerifyPending) return tgVerifyPending;
  if (!tgSession?.session_token) throw new BotApiError("войди через телеграм заново", 401, "login_required");
  if (!force && tgSessionVerified && Date.now() < tgVerifiedUntil && Date.now() < tgSession.expires_at * 1000 - 30000) {
    return tgSession.session_token;
  }
  if (!force && tgAuthError && Date.now() < tgAuthRetryAt) throw tgAuthError;
  const epoch = tgAuthEpoch, previous = tgSession, token = previous.session_token;
  const previousAuthState = tgAuthState;
  tgAuthState = "checking";
  const promise = (async () => {
    try {
      const result = await verifyAuthWithBot({ session_token: token });
      if (epoch !== tgAuthEpoch) throw new BotApiError("проверка входа отменена", 409, "cancelled");
      const session = telegramSessionFromResult(result);
      if (session.id !== String(previous.id)) throw new BotApiError("аккаунт сессии не совпал. войди заново", 401, "account_mismatch");
      tgSession = session;
      tgSessionVerified = true;
      tgVerifiedUntil = Date.now() + 5 * 60000;
      tgAuthRetryAt = 0;
      tgAuthError = null;
      tgAuthState = "ready";
      saveTgSession();
      trackStatsVisit(true);
      const profileChanged = previousAuthState !== "ready" ||
        previous.role !== session.role ||
        previous.username !== session.username ||
        previous.photo_url !== session.photo_url ||
        tgDisplayName(previous) !== tgDisplayName(session);
      if (profileChanged) refreshAuthUi();
      else { applyFlags(); updateTgButton(); }
      return session.session_token;
    } catch (error) {
      if (epoch === tgAuthEpoch) {
        tgSessionVerified = false;
        tgAuthError = error;
        if (error.status === 401) invalidateTelegramSession(error, token);
        else {
          tgAuthState = "offline";
          tgAuthRetryAt = Date.now() + 30000;
          refreshAuthUi();
        }
      }
      throw error;
    }
  })();
  tgVerifyPending = promise;
  try { return await promise; }
  finally { if (tgVerifyPending === promise) tgVerifyPending = null; }
}

function saveTgSession() {
  try {
    if (LOCAL_PREVIEW) {
      if (tgSession?.isLocalDemo) sessionStorage.setItem(LOCAL_TG_KEY, "1");
      else sessionStorage.removeItem(LOCAL_TG_KEY);
    } else if (tgSession) localStorage.setItem(TG_SESSION_KEY, JSON.stringify(tgSession));
    else localStorage.removeItem(TG_SESSION_KEY);
  } catch (_) {}
}

function loadTgSession() {
  if (LOCAL_PREVIEW) {
    try { if (sessionStorage.getItem(LOCAL_TG_KEY) === "1") tgSession = localTelegramIdentity(); } catch (_) {}
    return;
  }
  try {
    const raw = localStorage.getItem(TG_SESSION_KEY);
    if (!raw) return;
    const data = JSON.parse(raw);
    if (!data?.id || !data.session_token) {
      tgAuthState = "needs_login";
      localStorage.removeItem(TG_SESSION_KEY);
      return;
    }
    tgSession = data;
    // Never grant rights from localStorage before the server responds.
    tgSessionVerified = false;
    ensurePushSession(true).then(() => { tgSyncRoles(); refreshTgSubscription(); }).catch(() => {});
  } catch (_) {
    tgAuthState = "needs_login";
  }
}

function cancelTelegramLogin() {
  tgAuthEpoch++;
  telegramLogin?.cancel();

}

function tgLogout() {
  const token = tgSession?.session_token;
  cancelTelegramLogin();
  tgSession = null;
  tgSessionVerified = false;
  tgVerifyPending = null;
  tgAuthState = "idle";
  tgAuthError = null;
  tgAuthRetryAt = 0;
  tgRoles = { owner: null, editors: {}, boundTg: null };
  pendingMap = {};
  resetFirebaseIdentity();
  saveTgSession();
  updateTgButton();
  if (token && !LOCAL_PREVIEW) botRequest("auth/logout", {}, token).catch(() => {});
}

function applyTgSession(result, epoch = tgAuthEpoch) {
  if (epoch !== tgAuthEpoch) return false;
  const session = telegramSessionFromResult(result);
  if (tgSession?.id !== session.id) resetFirebaseIdentity();
  tgSession = session;
  tgSessionVerified = true;
  tgVerifiedUntil = Date.now() + 5 * 60000;
  tgAuthState = "ready";
  tgAuthError = null;
  tgAuthRetryAt = 0;
  tgRegisterState = "idle";
  tgRoles = { owner: null, editors: {}, boundTg: session.id };
  saveTgSession();
  refreshAuthUi();
  trackStatsVisit(true);
  toast("привет, " + tgDisplayName(session) + "!");
  refreshTgSubscription();
  tgSyncRoles().then(() => pullSharedSwaps()).catch(() => {});
  return true;
}

function prepareTelegramLogin() {
  if (!LOCAL_PREVIEW && !tgSession && tgConfigured() && ['idle','ready'].includes(telegramLogin.phase)) telegramLogin.prepare();
}
function startTelegramLogin() {
  if (LOCAL_PREVIEW) { startLocalTelegramLogin(); return true; }
  if (!tgConfigured()) { toast("вход пока не настроен администратором."); return false; }
  telegramLogin.start(); return true;
}

function myRole() {
  if (LOCAL_PREVIEW) return tgSession?.isLocalDemo ? "owner" : "anon";
  if (!tgSession || !tgSessionVerified) return "anon";
  if (tgSession.role === "owner" || tgSession.role === "editor") return tgSession.role;
  return tgRoles.editors?.[String(tgSession.id)] ? "editor" : "user";
}

function swapPrimaryLabel() {
  if (state.editorMode) return "применить";
  const role = myRole();
  return role === "owner" || role === "editor" ? "опубликовать" : "предложить";
}

function swapAccessHint() {
  if (!sharedSwapsEnabled()) return "";
  if (myRole() === "anon") return '<p class="sched-replace-hint">предложение сохранится у тебя и отправится редакторам без входа. telegram можно привязать позже.</p>';
  if (myRole() === "user") return '<p class="sched-replace-hint">у тебя применится сразу, у остальных — после проверки владельцем.</p>';
  return "";
}

async function tgRegister() {
  if (LOCAL_PREVIEW || !tgSessionVerified) return;
  await ensureFbToken();
  tgRoles.boundTg = tgSession.id;
  tgRegisterState = "done";
}

function waitTgRoles() { return tgSyncRoles(); }

async function tgSyncRoles() {
  if (tgRolesPending) return tgRolesPending;
  if (LOCAL_PREVIEW || !tgSession?.session_token) return;
  const epoch = tgAuthEpoch;
  const promise = (async () => {
    try {
      await ensurePushSession();
      if (!sharedSwapsEnabled()) return;
      await tgRegister();
      const response = await cloudFetch(cloudRoot() + "/" + CLOUD_PATHS.editors + ".json", { cache: "no-store" });
      if (epoch !== tgAuthEpoch) return;
      tgRoles.owner = tgSession.role === "owner" ? tgSession.id : null;
      if (response.ok) tgRoles.editors = await response.json() || {};
      updateTgButton();
    } catch (error) {
      if (epoch === tgAuthEpoch && !tgSyncRoles._warned) {
        tgSyncRoles._warned = true;
        console.warn("sched: общие правки пока недоступны:", error.message);
      }
    }
  })();
  tgRolesPending = promise;
  try { return await promise; }
  finally { if (tgRolesPending === promise) tgRolesPending = null; }
}

window.addEventListener("storage", event => {
  if (LOCAL_PREVIEW || event.key !== TG_SESSION_KEY) return;
  tgAuthEpoch++;
  tgVerifyPending = null;
  tgSession = null; tgSessionVerified = false;
  tgRoles = { owner: null, editors: {}, boundTg: null };
  pendingMap = {}; resetFirebaseIdentity();
  tgAuthState = "idle";
  if (event.newValue) loadTgSession();
  refreshAuthUi();
});
window.addEventListener("online", () => {
  if (tgSession?.session_token && !LOCAL_PREVIEW) ensurePushSession(true).then(() => tgSyncRoles()).catch(() => {});
});
document.addEventListener("click", event => {
  const action = event.target.closest("[data-auth-action]")?.dataset.authAction;
  if (action === "retry") ensurePushSession(true).then(() => tgSyncRoles()).catch(error => toast(error.message));
});

/* Корень базы без имени файла: из ".../sched-swaps.json" делаем "...". */
function cloudRoot() {
  return sharedSwapsUrl().replace(/\/[^/]*\.json.*$/, "");
}

/* Reads use the same verified Firebase identity as writes. This matters when
   production rules do not allow anonymous reads. A rejected/expired ID token
   is refreshed once; callers still receive the final response and can show a
   useful setup/login error instead of creating a request storm. */
async function cloudFetch(url, options = {}) {
  const canAuthenticate = firebaseAuthEnabled() && Boolean(tgSession?.session_token);
  let response = null;
  for (let attempt = 0; attempt < (canAuthenticate ? 2 : 1); attempt += 1) {
    const target = canAuthenticate ? await sharedUrlWithAuth(url, attempt > 0) : url;
    response = await fetch(target, options);
    if (response.status !== 401 || attempt > 0) break;
  }
  return response;
}

/* В ключах замен есть "/" (группы вида "тм-303/б") и могут быть точки —
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
    /* Суффикс "*xxxx" добавляется анонимным предложениям, чтобы не
       перезаписывать чужой узел; на слот он не влияет. */
    return decodeURIComponent(String(enc).replace(/\*[A-Za-z0-9]+$/, "")).replace(/~/g, "/");
  } catch (e) {
    return enc;
  }
}

function decodeSwapEntries(data) {
  const out = {};
  for (const enc in data) out[decodeSwapKey(enc)] = data[enc];
  return out;
}

/* One notification hook for confirmed cloud writes. Local edits never publish. */
function pushSessionToken() { return tgSessionVerified && tgSession?.session_token || ""; }
var pushDeliveryChain = Promise.resolve();
function queueBotEvent(event) {
  const identity = tgSession?.id;
  const task = pushDeliveryChain.then(async () => {
    if (LOCAL_PREVIEW) return false;
    if (identity !== tgSession?.id) throw new BotApiError("аккаунт изменился — уведомление отменено", 409, "cancelled");
    const token = tgSession?.session_token ? await ensurePushSession() : "";
    try { return await sendBotEvent({ ...event, text: String(event.text).slice(0, 3800) }, token); }
    catch (error) { if (error.status === 401) invalidateTelegramSession(error, token); throw error; }
  });
  pushDeliveryChain = task.catch(() => {});
  return task;
}
let pushWarningAt = 0;
function reportPushError(error) {
  recordError("notification", error.message);
  if (!loadNotifPrefs().telegram || error.code === "cancelled" || Date.now() - pushWarningAt < 60000) return;
  pushWarningAt = Date.now();
  console.warn("sched: уведомление не отправлено:", error.message);
}
function botHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
function botDate(dIso) {
  try {
    const d = dateFromIso(dIso);
    return `${d.getDate()} ${MONTHS[d.getMonth()]}`;
  } catch (_) { return dIso || "неизвестная дата"; }
}
function botLesson(slot) {
  const value = slot || {};
  if (value.makeWindow || value.window || value.empty) return "окно";
  const subject = botHtml(value.subject || "пара без названия");
  const meta = [value.teacher, value.room].filter(Boolean).map(botHtml).join(" · ");
  return meta ? `${subject}\n<blockquote>${meta}</blockquote>` : subject;
}
function notifyCloudEvent(path, body) {
  if (LOCAL_PREVIEW || !body || !window.SCHED_NOTIFY_URL) return;
  const section = String(path).split("/")[0];
  const type = section === CLOUD_PATHS.swaps ? "swap" : section === CLOUD_PATHS.pending ? "pending" : null;
  if (!type) return;
  const key = decodeSwapKey(String(path).slice(section.length + 1));
  const stamp = body.updatedAt || body.createdAt || 0;
  const parts = key.split("|");
  const group = parts[0] || ""; // Только маршрутизация, в сообщение не выводится.
  const when = (parts[1] || "").split(":");
  const dIso = when[0] || "";
  const n = Number(when[1]) || 0;
  let original = null;
  try { original = slotsForBase(dateFromIso(dIso)).find(slot => slot.n === n) || null; } catch (_) {}

  let verb;
  if (type === "pending") {
    verb = body.cancelled ? "предложили отменить" : body.moved ? "предложили перенести" : "предложили изменить";
  } else if (body.makeWindow) verb = "сделали окном";
  else if (body.deleted) verb = "вернули";
  else if (body.cancelled) verb = "отменили";
  else if (body.moved) verb = "перенесли";
  else verb = "заменили";

  const shown = body.cancelled || body.deleted ? original : body;
  let text = `<b>${botHtml(botDate(dIso))} ${verb} ${n} пару</b>`;
  if (shown) text += `\n\n${botLesson(shown)}`;
  queueBotEvent({ type, format: "html", event_id: path + ":" + stamp, text, group }).catch(reportPushError);
}

/* Единая точка записи: PUT с телом или DELETE (body === null). true = база приняла. */
/* Статус последней ошибки облака: 401/403 = права/правила, -1 = сеть. */
var lastCloudStatus = 0;
var lastCloudMessage = "";
var cloudWriteRetryAt = 0;
var cloudMutationChain = Promise.resolve();
function cloudWrite(path, body, options = {}) {
  const identity = tgSession?.id;
  const task = cloudMutationChain.then(async () => {
    if (LOCAL_PREVIEW) return false;
    /* A denied Firebase write used to make every pending edit request a fresh
       bot/Firebase token, quickly causing a 429 storm and repeated UI refreshes. */
    if (Date.now() < cloudWriteRetryAt) return false;
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 15000);
    try {
      if (!identity || tgSession?.id !== identity) throw new BotApiError("для общих правок войди через телеграм", 401, "login_required");
      await ensurePushSession();
      let response = null;
      for (let attempt = 0; attempt < 2; attempt += 1) {
        if (attempt) await ensurePushSession(true);
        const url = await sharedUrlWithAuth(
          cloudRoot() + (path ? "/" + path : "/") + ".json",
          attempt > 0,
        );
        if (tgSession?.id !== identity) throw new BotApiError("аккаунт изменился — правка осталась локальной", 409, "cancelled");
        response = await fetch(url, {
          method: options.method || (body === null ? "DELETE" : "PUT"), headers: { "Content-Type": "application/json" },
          ...(body !== null ? { body: JSON.stringify(body) } : {}),
          credentials: "omit", referrerPolicy: "no-referrer", signal: controller.signal,
        });
        /* После изменения роли старый Firebase ID token всё ещё содержит прежние claims.
           На 401 один раз перепроверяем Telegram-сессию и получаем новый custom token. */
        if (response.status !== 401 || attempt > 0 || !firebaseAuthEnabled()) break;
      }
      lastCloudStatus = response?.status || -1;
      if (!response?.ok) {
        if ([401, 403, 429].includes(response?.status)) cloudWriteRetryAt = Date.now() + 60000;
        lastCloudMessage = response?.status === 401
          ? "firebase не принял обновлённые права — опубликуй config/firebase.rules.json и проверь, что Web API key относится к этой базе"
          : "база отклонила запись — проверь config/firebase.rules.json и серверный ключ firebase";
        return false;
      }
      cloudWriteRetryAt = 0;
      lastCloudStatus = 0; lastCloudMessage = "";
      if (options.notify !== false) notifyCloudEvent(path, body);
      return true;
    } catch (error) {
      lastCloudStatus = error.status || -1;
      if ([401, 403, 429].includes(lastCloudStatus)) cloudWriteRetryAt = Date.now() + 60000;
      lastCloudMessage = error.message;
      return false;
    }
    finally { clearTimeout(timer); }
  });
  cloudMutationChain = task.catch(() => {});
  return task;
}
function cloudFailHint() { return lastCloudMessage || "не отправилось — проверь интернет"; }

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

async function anonymousProposalIdentity() {
  const raw = statsVisitorId();
  if (!raw) return "";
  try {
    const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(raw));
    return "anon:" + [...new Uint8Array(bytes)].map(value => value.toString(16).padStart(2, "0")).join("");
  } catch (_) {
    let seed = 2166136261;
    for (const char of raw) seed = Math.imul(seed ^ char.charCodeAt(0), 16777619) >>> 0;
    return "anon:" + Array.from({ length: 8 }, (_, index) => ((seed ^ Math.imul(index + 1, 2654435761)) >>> 0).toString(16).padStart(8, "0")).join("");
  }
}

async function cloudWriteAnonymousPendingPerKey(payloads, signal) {
  const keys = Object.keys(payloads || {});
  if (!keys.length) return false;
  const putKey = async (nodeKey, body) => {
    const response = await fetch(
      cloudRoot() + "/" + CLOUD_PATHS.pending + "/" + nodeKey + ".json",
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        credentials: "omit",
        referrerPolicy: "no-referrer",
        signal,
      },
    );
    if (!response.ok) lastCloudStatus = response.status;
    return response.ok;
  };
  let sent = 0;
  for (const key of keys) {
    try {
      if (await putKey(key, payloads[key])) { sent += 1; continue; }
      /* Правила разрешают анониму только создание узла: если по этой паре
         заявка уже лежит, кладём свою в свободный ключ с суффиксом — редакторы
         видят его как ту же пару (суффикс срезается при раскодировке). */
      if (lastCloudStatus === 401 || lastCloudStatus === 403) {
        const suffix = "*" + Math.random().toString(36).slice(2, 8) + Date.now().toString(36).slice(-4);
        if (await putKey(key + suffix, payloads[key])) { sent += 1; continue; }
      }
    } catch (_) {
      lastCloudStatus = -1;
    }
  }
  return sent === keys.length;
}

async function cloudWriteAnonymousPending(payloads) {
  if (!sharedSwapsEnabled() || LOCAL_PREVIEW) return false;
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch(cloudRoot() + "/" + CLOUD_PATHS.pending + ".json", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payloads),
      credentials: "omit",
      referrerPolicy: "no-referrer",
      signal: controller.signal,
    });
    lastCloudStatus = response.status;
    if (!response.ok) {
      /* Многопутевой PATCH в корень weeqo-pending база проверяет по правилам
         родителя, а разрешение для анонимных описано на $key. Дожимаем каждый ключ отдельно. */
      if (response.status === 401 || response.status === 403) {
        const perKey = await cloudWriteAnonymousPendingPerKey(payloads, controller.signal);
        if (perKey) {
          lastCloudStatus = 0;
          lastCloudMessage = "";
          return true;
        }
        lastCloudMessage = "предложения без входа запрещены базой: опубликуй config/firebase.rules.json или войди через телеграм";
        return false;
      }
      lastCloudMessage = "не удалось отправить предложение (" + response.status + ")";
      return false;
    }
    lastCloudStatus = 0;
    lastCloudMessage = "";
    return true;
  } catch (error) {
    lastCloudStatus = -1;
    lastCloudMessage = "не отправилось — проверь интернет";
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/* One atomic Firebase PATCH for a move/reset. No half-move and one bot event. */
async function publishSwapBatch(entries, label = "изменены пары") {
  if (!sharedSwapsEnabled()) return false;
  const role = myRole();
  const anonymous = role === "anon";
  const section = role === "owner" || role === "editor" ? CLOUD_PATHS.swaps : CLOUD_PATHS.pending;
  const identity = anonymous ? await anonymousProposalIdentity() : tgSession?.id;
  if (!identity) return false;
  const payloads = {};
  Object.entries(entries).forEach(([key, entry]) => {
    /* Keep the encoded Firebase key in the JSON PATCH body. Decoding it here
       reintroduced forbidden characters such as "." and made the whole batch fail. */
    payloads[encodeSwapKey(key)] = sanitizeSwapPayload({
      ...entry,
      by: identity,
      byName: anonymous ? "без авторизации" : tgDisplayName(tgSession),
      ...(anonymous ? { anonymous: true } : {}),
    });
  });
  if (!anonymous) {
    await waitTgRoles();
    if (tgSession?.id !== identity || !tgSessionVerified && !LOCAL_PREVIEW) return false;
  }
  const ok = anonymous
    ? await cloudWriteAnonymousPending(payloads)
    : await cloudWrite(section, payloads, { method: "PATCH", notify: false });
  const map = loadSwaps();
  for (const [key, entry] of Object.entries(entries)) {
    if (map[key] !== entry) continue; // A late response must never replace a newer edit.
    if (ok) delete entry.pendingSync;
    else entry.pendingSync = true;
  }
  saveSwaps();
  if (ok && !anonymous) {
    const list = Object.entries(entries);
    if (list.length === 1) {
      const [key, entry] = list[0];
      notifyCloudEvent(section + "/" + encodeSwapKey(key), {
        ...entry, by: identity, byName: tgDisplayName(tgSession),
      });
    } else {
      const [key, entry] = list[0];
      const group = key.split("|")[0], date = (key.split("|")[1] || "").split(":")[0];
      const pending = section === CLOUD_PATHS.pending;
      const rows = list.map(([k, value]) => {
        const n = Number(k.split(":").at(-1)) || 0;
        const stateLabel = value.deleted ? "исходное расписание" : value.cancelled ? "отменена" : botLesson(value);
        return `<b>${n} пара</b>\n${stateLabel}`;
      }).join("\n\n");
      const action = pending ? "предложили перенести пары" : "перенесли пары";
      const text = `<b>${botHtml(botDate(date))} ${action}</b>\n\n${rows}`;
      queueBotEvent({ type: pending ? "pending" : "swap", format: "html", group,
        event_id: section + ":" + (entry.operationId || key + ":" + entry.updatedAt), text,
      }).catch(reportPushError);
    }
  }
  if (section === CLOUD_PATHS.pending) {
    const count = Object.keys(entries).length;
    const word = plural(count, "пару", "пары", "пар");
    const author = anonymous ? "без авторизации" : tgDisplayName(tgSession);
    if (ok) {
      toast("предложено " + count + " " + word + " — ждём проверку редакторов");
      pushNotif(
        "ты предложил " + count + " " + word + " · на проверке у редакторов (" + author + ")",
        "pending",
        "pending",
      );
    } else {
      toast("предложение не ушло — повторю сам");
    }
  }
  return ok;
}

function pushSwapEntry(key, entry) { return publishSwapBatch({ [key]: entry }); }
function proposeSwapEntry(key, entry) { return publishSwapBatch({ [key]: entry }); }
function publishSwapKey(key) {
  const entry = loadSwaps()[key];
  return entry ? publishSwapBatch({ [key]: entry }) : Promise.resolve(false);
}

async function pullPending() {
  try {
    const resp = await cloudFetch(
      cloudRoot() + ("/" + CLOUD_PATHS.pending + ".json"),
      { headers: { Accept: "application/json" }, cache: "no-store" },
    );
    if (!resp.ok) {
      lastCloudStatus = resp.status;
      lastCloudMessage = resp.status === 401
        ? "сессия облака истекла — войди через телеграм заново"
        : "не удалось загрузить заявки (" + resp.status + ")";
      return;
    }
    const data = await resp.json();
    pendingMap = data && typeof data === "object" ? data : {};
    notifyAboutPending();
  } catch (e) {
    /* офлайн */
  }
  updateTgButton();
  renderTgSheetBody();
}

function pendingOperation(enc) {
  const entry = pendingMap[enc];
  if (!entry) return [];
  const groupDate = decodeSwapKey(enc).split(":").slice(0, -1).join(":");
  return entry.operationId ? Object.entries(pendingMap).filter(([key, value]) =>
    value.operationId === entry.operationId && value.by === entry.by && decodeSwapKey(key).split(":").slice(0, -1).join(":") === groupDate) : [[enc, entry]];
}
async function approvePending(enc) {
  if (myRole() !== "owner" && myRole() !== "editor") { toast("только редактор может подтверждать заявки"); return; }
  const entries = pendingOperation(enc);
  if (!entries.length) return;
  if (entries[0][1].operationSize && entries.length !== entries[0][1].operationSize) {
    toast("заявка на перенос неполная — попроси отправить перенос заново"); return;
  }
  const updates = {};
  for (const [key, entry] of entries) {
    /* `key` is already the exact flat Firebase child key. Never decode it into
       a slash/dot before using it as a multi-location update path. */
    updates[CLOUD_PATHS.swaps + "/" + key] = sanitizeSwapPayload(entry);
    updates[CLOUD_PATHS.pending + "/" + key] = null;
  }
  if (!await cloudWrite("", updates, { method: "PATCH", notify: false })) { toast(cloudFailHint()); return; }
  const map = loadSwaps();
  for (const [key, entry] of entries) { delete pendingMap[key]; map[decodeSwapKey(key)] = { ...entry }; }
  saveSwaps(); updateTgButton(); renderTgSheetBody(); render();
  const [key, entry] = entries[0];
  const decoded = decodeSwapKey(key), group = decoded.split("|")[0];
  const date = (decoded.split("|")[1] || "").split(":")[0];
  const rows = entries.map(([k, value]) => {
    const when = decodeSwapKey(k).split("|")[1] || "";
    const n = Number(when.split(":")[1]) || 0;
    return `<b>${n} пара</b>\n${value.deleted ? "исходное расписание" : value.cancelled ? "отменена" : botLesson(value)}`;
  }).join("\n\n");
  queueBotEvent({ type: "swap", format: "html", group,
    event_id: "approved:" + (entry.operationId || key + ":" + entry.updatedAt),
    text: `<b>${botHtml(botDate(date))} опубликовали изменения</b>\n\n${rows}`,
  }).catch(reportPushError);
  toast("изменения опубликованы");
}
async function rejectPending(enc) {
  if (myRole() !== "owner" && myRole() !== "editor") { toast("только редактор может отклонять заявки"); return; }
  const entries = pendingOperation(enc);
  const updates = Object.fromEntries(entries.map(([key]) => [key, null]));
  if (!entries.length || !await cloudWrite(CLOUD_PATHS.pending, updates, { method: "PATCH", notify: false })) return;
  entries.forEach(([key]) => { delete pendingMap[key]; });
  updateTgButton(); renderTgSheetBody();
}

async function grantEditor(tgId, name) {
  const ok = await cloudWrite(CLOUD_PATHS.editors + "/" + tgId, name || "редактор");
  if (!ok) {
    toast("не получилось выдать доступ");
    return;
  }
  toast("редактор добавлен");
  await tgSyncRoles();
  renderTgSheetBody();
}

async function revokeEditor(tgId) {
  const ok = await cloudWrite(CLOUD_PATHS.editors + "/" + tgId, null);
  if (!ok) {
    toast("не получилось убрать");
    return;
  }
  await tgSyncRoles();
  renderTgSheetBody();
}

/* Копирование телеграм id в буфер: современный API + запасной через textarea. */
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
  const dialog = document.querySelector('#move-backdrop .sched-replace-sheet, #bot-login-backdrop .sched-replace-sheet');
  if (dialog) {
    let notice = dialog.querySelector('.sched-inline-notice');
    if (!notice) { notice = document.createElement('p'); notice.className = 'sched-inline-notice'; notice.setAttribute('role', 'status'); dialog.appendChild(notice); }
    notice.textContent = text;
    return;
  }
  let container = document.getElementById("sched-toast-container");
  if (!container) {
    container = document.createElement("div");
    container.id = "sched-toast-container";
    container.setAttribute("aria-live", "polite");
    document.body.appendChild(container);
  }
  const item = document.createElement("div");
  item.className = "sched-toast-item";
  item.textContent = text;
  container.replaceChildren(item);

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
  if (pairDragActive || document.getElementById("swap-backdrop") || document.getElementById("move-backdrop")) return;
  try {
    const resp = await cloudFetch(url, {
      headers: { Accept: "application/json" },
      cache: "no-store",
    });
    if (resp.status === 401 || resp.status === 403) {
      lastCloudStatus = resp.status;
      lastCloudMessage = resp.status === 401
        ? "облако не приняло сессию — войди через телеграм заново"
        : "нет доступа к общей базе — проверь опубликованные правила Firebase";
      if (!pullSharedSwaps._warned) {
        /* Один раз за сессию подсвечиваем в консоли, почему облако молчит. */
        pullSharedSwaps._warned = true;
        console.warn(
          "sched: облако отклоняет чтение (" +
            resp.status +
            ") — опубликуй config/firebase.rules.json и войди через телеграм заново",
        );
      }
    } else if (resp.ok) {
      lastCloudStatus = 0;
      lastCloudMessage = "";
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
      if (!scrub && !document.getElementById("swap-backdrop")) renderPassive();
    }
    /* Не ушедшие записи дожимаем любой ролью: у автора предложения
       тоже есть право записи в weeqo-pending. */
    {
      const batches = new Map();
      for (const [key, entry] of Object.entries(map)) {
        if (!entry?.pendingSync) continue;
        const id = entry.operationId || key;
        if (!batches.has(id)) batches.set(id, {});
        batches.get(id)[key] = entry;
      }
      for (const batch of batches.values()) publishSwapBatch(batch, "повторн��я отправка изменений");
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
function tgAvatarInitial(user = tgSession) {
  return (tgDisplayName(user) || "?").trim().charAt(0).toUpperCase() || "?";
}

function tgAvatarMarkup(url, user, imageClass = "") {
  const initial = escapeHtml(tgAvatarInitial(user));
  if (!url) return '<b class="sched-avatar-fallback">' + initial + '</b>';
  return '<img class="sched-avatar-image ' + imageClass + '" data-tg-avatar src="' +
    escapeHtml(String(url)) + '" alt=""><b class="sched-avatar-fallback" hidden>' + initial + '</b>';
}

document.addEventListener("error", event => {
  const img = event.target;
  if (!(img instanceof HTMLImageElement) || !img.matches("[data-tg-avatar]")) return;
  img.hidden = true;
  const fallback = img.nextElementSibling;
  if (fallback?.classList.contains("sched-avatar-fallback")) fallback.hidden = false;
  const trigger = img.closest("#settings-trigger");
  if (trigger) trigger.classList.remove("is-avatar");
}, true);

function updateSettingsAvatar() {
  const trigger = document.getElementById("settings-trigger");
  if (!trigger) return;
  trigger.querySelector("img.sched-trigger-avatar")?.remove();
  trigger.classList.remove("is-avatar");
  const url = tgSession?.photo_url ? String(tgSession.photo_url) : "";
  if (!url) return;
  const img = document.createElement("img");
  img.className = "sched-trigger-avatar sched-avatar-image";
  img.dataset.tgAvatar = "";
  img.alt = "";
  img.src = url;
  trigger.appendChild(img);
  trigger.classList.add("is-avatar");
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
    const roleLabel = tgSession?.isLocalDemo
      ? "владелец"
      : role === "owner"
        ? "владелец"
        : role === "editor"
          ? "редактор"
          : "студент";
    if (hint)
      hint.textContent = roleLabel + (tgSession.username ? " · @" + tgSession.username : "");
    if (icon) icon.innerHTML = tgAvatarMarkup(tgSession.photo_url, tgSession, "sched-account-avatar");
  } else {
    if (icon) icon.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21.9 4.6c.3-1.1-.8-2-1.9-1.6L2.6 10.4c-1 .4-.9 1.7.1 2l4.2 1.4 1.6 5c.3.9 1.4 1.1 2 .4l2.2-2.6 4 3c.7.5 1.8.1 2-.8l2.6-14.6z"/><path d="M7 14.5 18 6"/></svg>';
    title.textContent = "профиль";
    if (hint)
      hint.textContent = tgConfigured()
        ? "группа, уведомления, вход через телеграм"
        : "группа и уведомления";
  }

  const tgBtn = document.getElementById("go-tg-sheet");
  if (tgBtn) {
    tgBtn.hidden = !canReview;
    const pHint = document.getElementById("settings-pending-hint");
    if (pHint)
      pHint.textContent = pendingCount
        ? "ждут проверки: " + pendingCount
        : "проверка замен и права";
  }

  const repBtn = document.getElementById("go-reports-sheet");
  if (repBtn) {
    repBtn.hidden = role !== "owner";
  }
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
  /* Та же карточка «до → после», что и в уведомлениях. */
  const frag = m ? buildNotifFrag(key, entry) : null;
  const segHtml = frag ? notifFragHtml({ frag }) : "";
  let actions = "";
  if (role === "owner" || role === "editor") {
    actions =
      '<button class="is-primary" type="button" data-tg="approve" data-key="' +
      escapeHtml(enc) +
      '">принять</button>' +
      '<button type="button" data-tg="reject" data-key="' +
      escapeHtml(enc) +
      '">отклонить</button>';
    if (
      role === "owner" &&
      entry.by &&
      entry.by !== String(tgRoles.owner) &&
      !tgRoles.editors[entry.by]
    ) {
      actions +=
        '<button type="button" data-tg="grant" data-key="' +
        escapeHtml(enc) +
        '" data-tgid="' +
        escapeHtml(String(entry.by)) +
        '">+ редактор</button>';
    }
  } else {
    actions = '<span class="sched-pending-readonly-label">н�� проверке у редакторов</span>';
  }
  return (
    '<div class="sched-tg-row"><div class="sched-tg-row-text"><strong>' +
    escapeHtml(what) +
    "</strong>" +
    segHtml +
    "<span>" +
    escapeHtml(when) +
    " · предложил(а): " +
    escapeHtml(who) +
    "</span>" +
    '</div><div class="sched-tg-row-actions">' +
    actions +
    "</div></div>"
  );
}

/* Контент окна Telegram; inline=true — панель внутри профиля (без шапки и нижних кнопок). */
function tgSheetBodyHtml(inline) {
  const role = myRole();
  let html = "";
  if (!inline) {
    const roleLabel = tgSession?.isLocalDemo
      ? "владелец"
      : role === "owner"
        ? "владелец"
        : role === "editor"
          ? "редактор"
          : "студент";
    html +=
      '<div class="sched-replace-head"><strong>' +
      escapeHtml(tgDisplayName(tgSession)) +
      "</strong><span>" +
      roleLabel +
      "</span></div>";
  }
  if (role === "user")
    html +=
      '<p class="sched-replace-hint"><button type="button" class="sched-tg-copy-id" data-tg="copy-id" data-id="' +
      escapeHtml(String(tgSession.id)) +
      '" title="нажми, чтобы скопировать">мой id: <b>' +
      escapeHtml(String(tgSession.id)) +
      "</b></button></p>";
  if (role === "owner" || role === "editor") {
    const keys = Object.keys(pendingMap).sort(
      (a, b) => (pendingMap[b].updatedAt || 0) - (pendingMap[a].updatedAt || 0),
    );
    html += '<div class="sched-tg-section"><span>заявки (' + keys.length + ")</span>";
    if (!keys.length) html += '<p class="sched-replace-hint">пока пусто</p>';
    keys.forEach((enc) => {
      html += pendingRowHtml(enc, pendingMap[enc], role);
    });
    html += "</div>";
  }
  if (role === "owner") {
    const ids = Object.keys(tgRoles.editors);
    html += '<div class="sched-tg-section is-editors"><span>редакторы</span>';
    if (!ids.length)
      html +=
        '<p class="sched-replace-hint">пока нет. добавь по id ниже или кнопкой «+ редактор» в любой заявке.</p>';
    ids.forEach((tg) => {
      html +=
        '<div class="sched-tg-row"><div class="sched-tg-row-text"><strong>' +
        escapeHtml(String(tgRoles.editors[tg])) +
        "</strong><span>id: " +
        escapeHtml(String(tg)) +
        '</span></div><div class="sched-tg-row-actions"><button type="button" data-tg="revoke" data-tgid="' +
        escapeHtml(tg) +
        '">убрать</button></div></div>';
    });
    html +=
      '<div class="sched-tg-add"><input type="text" inputmode="numeric" id="tg-add-editor-id" placeholder="id редактора" autocomplete="off">' +
      '<button type="button" data-tg="add-editor">добавить</button></div>' +
      '<p class="sched-replace-hint sched-tg-add-hint">человек видит свой id у себя в профиле — строка «мой id», по тапу копируется.</p>' +
      '<p class="sched-replace-hint sched-tg-add-hint">редактор проверяет заявки, а его замены уходят всем сразу.</p>';
    html += "</div>";
  }
  if (inline) return html;
  html +=
    '<div class="sched-replace-actions"><button type="button" data-tg="logout">выйти</button>' +
    '<button type="button" data-tg="close">закрыть</button></div>';
  return html;
}

function renderTgSheetBody() {
  const body = document.getElementById("tg-sheet-body");
  const inline = document.getElementById("profile-tg-inline");
  if (!body && !inline) return;
  if (!tgSession) {
    if (body) {
      body.innerHTML = `<div data-login-panel>${authButtonHtml(telegramLogin.snapshot, LOCAL_PREVIEW)}</div><div class="sched-replace-actions"><button type="button" data-tg="close">закрыть</button></div>`;
      prepareTelegramLogin();
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
     сессии или настроенном боте. */
  if (!tgConfigured() && !tgSession) {
    toast("вход через телеграм не настроен");
    return;
  }
  const backdrop = document.createElement("div");
  backdrop.id = "tg-backdrop";
  backdrop.className = "sched-replace-backdrop";
  backdrop.innerHTML =
    '<div class="sched-replace-sheet sched-tg-sheet" role="dialog" aria-label="Telegram"><div id="tg-sheet-body"></div></div>';
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
    else if (act === "bot-login") startTelegramLogin();
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
var NOTIF_KEY = "sched:notifs:v1";
var NOTIF_SEEN_SWAPS_KEY = "sched:notif-seen-swaps:v1";
var NOTIF_SEEN_SCHEDULE_KEY = "sched:notif-seen-schedule:v1";
var NOTIF_SEEN_PENDING_KEY = "sched:notif-seen-pending:v1";
var notifList = null;

/* Настройки уведомлений: что показывать в колокольчике и дублировать в Telegram. */
var NOTIF_PREFS_KEY = LOCAL_PREVIEW ? "sched:notif-prefs:local:v1" : "sched:notif-prefs:v1";
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

/* Subscription writes are serialized and acknowledged before an explicit toggle settles. */
var subscriptionChain = Promise.resolve();
var subscriptionBusy = false;
var telegramChatStarted = null;
function updateSubscriptionUi() {
  const p = loadNotifPrefs();
  document.querySelectorAll('[data-npref]').forEach(button => {
    button.setAttribute('aria-pressed', String(Boolean(p[button.dataset.npref])));
    button.disabled = subscriptionBusy;
  });
  document.querySelectorAll('.sched-telegram-connect').forEach(el => el.remove());
  if (!p.telegram || telegramChatStarted !== false || LOCAL_PREVIEW) return;
  document.querySelectorAll('[data-npref="telegram"]').forEach(button => {
    const link = document.createElement('a'); link.className = 'sched-telegram-connect';
    link.textContent = 'открыть бота и нажать «старт»';
    link.href = 'https://t.me/' + encodeURIComponent(TELEGRAM_BOT_NAME) + '?start=notifications';
    link.target = '_blank'; link.rel = 'noopener noreferrer';
    button.closest('.sched-settings-row').after(link);
  });
}
async function toggleNotifPref(key, el) {
  const p = loadNotifPrefs();
  if (subscriptionBusy || !Object.prototype.hasOwnProperty.call(p, key)) return;
  if (key === 'telegram' && !p.telegram && !tgSession) { toast('сначала войди через телеграм в профиле.'); return; }
  const before = { ...p };
  p[key] = !p[key];
  if (LOCAL_PREVIEW || !tgSession || key !== 'telegram' && !p.telegram) {
    saveNotifPrefs(); updateSubscriptionUi(); return;
  }
  subscriptionBusy = true; updateSubscriptionUi();
  const ok = await syncTgSub({ quiet: true });
  if (!ok) {
    Object.assign(p, before);
    toast('не удалось сохранить настройку уведомлений. попробуй ещё раз.');
  } else {
    saveNotifPrefs();
    if (key === 'telegram' && p.telegram && telegramChatStarted) toast('уведомления в телеграм включены');
  }
  subscriptionBusy = false; updateSubscriptionUi();
}
function showTgMemo() { updateSubscriptionUi(); }
function closeTgMemo() { document.getElementById('tg-memo')?.remove(); }
async function refreshTgSubscription() {
  if (LOCAL_PREVIEW || subscriptionBusy || !tgSessionVerified) return;
  const identity = tgSession.id;
  try {
    const result = await botRequest('subscription', {}, await ensurePushSession());
    if (identity !== tgSession?.id || subscriptionBusy || !result.preferences) return;
    const p = loadNotifPrefs();
    telegramChatStarted = result.chat_started === true;
    if (result.configured === false) {
      p.telegram = false; saveNotifPrefs();
      await syncTgSub({ quiet: true });
    } else {
      for (const key of Object.keys(p)) if (typeof result.preferences[key] === 'boolean') p[key] = result.preferences[key];
      saveNotifPrefs();
    }
    updateSubscriptionUi();
  } catch (error) { recordError('subscription-status', error.message); }
}
function syncTgSub({ quiet = false } = {}) {
  if (LOCAL_PREVIEW || !tgSession?.session_token || !window.SCHED_NOTIFY_URL) return Promise.resolve(false);
  const preferences = { ...loadNotifPrefs() }, group = state.group || '', identity = tgSession.id;
  const work = subscriptionChain.then(async () => {
    if (identity !== tgSession?.id) return false;
    let token = '';
    try {
      token = await ensurePushSession();
      const result = await updateBotSubscription(preferences, group, token);
      telegramChatStarted = result.chat_started !== false;
      updateSubscriptionUi(); return true;
    } catch (error) {
      if (error.status === 401) invalidateTelegramSession(error, token);
      recordError('subscription', error.message);
      if (!quiet && preferences.telegram) reportPushError(error);
      return false;
    }
  });
  subscriptionChain = work.catch(() => false);
  return work;
}

function loadNotifs() {
  if (notifList) return;
  notifList = [];
  try {
    var raw = localStorage.getItem(NOTIF_KEY);
    if (raw) {
      var data = JSON.parse(raw);
      if (Array.isArray(data))
        notifList = data.filter(function (n) {
          return n && typeof n.text === "string" && typeof n.at === "number";
        });
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
  notifList.unshift({
    text: text,
    at: Date.now(),
    read: false,
    tone: tone || null,
    frag: frag || null,
  });
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
    badge.textContent = unread > 99 ? "99+" : String(unread);
  }
}

/* Текстовое описание записи замены для ленты. */
function describeSwapForNotif(key, entry) {
  var m = key.match(/\|(\d{4}-\d{2}-\d{2}):(\d+)$/);
  var n = m ? m[2] : "";
  var what = "замена";
  if (entry.deleted) what = "сброс замены";
  else if (entry.cancelled) what = "отмена пары";
  else if (entry.moved) what = entry.makeWindow ? "окно после переноса" : "перенос";
  /* Номер, предмет, преподаватель и аудитория уже показаны в мини-карточке. */
  return what;
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
        entry.deleted ? "reset" : entry.cancelled ? "cancel" : entry.moved ? "move" : "swap",
        buildNotifFrag(key, entry),
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
          buildNotifFrag(decodeSwapKey(enc), pEntry),
        );
      }
    });
  }
  try {
    localStorage.setItem(NOTIF_SEEN_PENDING_KEY, JSON.stringify(nowMap));
  } catch (e) {}
}

/* Уведомляем только при изменении самих пар, а не checkedAt/updatedAt. */
function normalizeScheduleGroups(groups) {
  /* Парсер может отдать те же пары в другом порядке, с пустыми полями
     или другим регистром — такое обновление не должно будить уведомление. */
  const text = value => String(value == null ? "" : value).trim().replace(/\s+/g, " ").toLowerCase();
  const extras = value => {
    if (!value || typeof value !== "object") return "";
    return Object.keys(value)
      .filter(k => value[k] !== null && value[k] !== undefined && value[k] !== "" && value[k] !== false)
      .sort()
      .map(k => k + "=" + text(value[k]))
      .join(",");
  };
  return (Array.isArray(groups) ? groups : [])
    .map(group => {
      const days = group && typeof group.days === "object" && group.days ? group.days : {};
      const normDays = Object.keys(days)
        .sort()
        .map(dayId => {
          const items = (Array.isArray(days[dayId]) ? days[dayId] : [])
            .map(item => {
              const list = Array.isArray(item) ? item : [];
              return [Number(list[0]) || 0, text(list[1]), text(list[2]), text(list[3]), extras(list[4])].join("|");
            })
            .filter(line => line.split("|").slice(1, 4).some(Boolean))
            .sort();
          return dayId + ">" + items.join(";");
        })
        .join("/");
      return text(group && group.id) + "#" + normDays;
    })
    .sort()
    .join("\n");
}
function scheduleContentStamp(groups) {
  const raw = normalizeScheduleGroups(groups);
  let hash = 2166136261;
  for (let i = 0; i < raw.length; i += 1) {
    hash ^= raw.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return "content:" + (hash >>> 0).toString(36) + ":" + raw.length;
}
function notifyAboutScheduleStamp(updatedAt, groups) {
  if (!updatedAt) return;
  try {
    const current = scheduleContentStamp(groups);
    const prev = localStorage.getItem(NOTIF_SEEN_SCHEDULE_KEY);
    /* Старые версии хранили timestamp: миграция на content-hash проходит тихо. */
    if (prev && prev.indexOf("content:") === 0 && prev !== current) {
      pushNotif("обновились пары — базовое расписание обновлено", "schedule", "schedule");
    }
    localStorage.setItem(NOTIF_SEEN_SCHEDULE_KEY, current);
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
  if (t.indexOf("перенос") === 0 || t.indexOf("окно после переноса") === 0) return "move";
  return "schedule";
}

var NOTIF_ICONS = {
  move: ICON_SWAP,
  cancel:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="8.5"/><path d="M9.5 9.5l5 5M14.5 9.5l-5 5"/></svg>',
  swap: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7 16V4M7 4 3.5 7.5M7 4l3.5 3.5M17 8v12m0 0 3.5-3.5M17 20l-3.5-3.5"/></svg>',
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
  let base = null;
  try {
    base = slotsForBase(dateFromIso(dIso)).find((slot) => slot.n === n) || null;
  } catch (e) {}
  const before = base
    ? {
        subject: base.subject || "",
        teacher: base.teacher || "",
        room: base.room || "",
        self: !!base.self,
        window: !!(base.window || base.empty),
      }
    : null;
  const replacement = {
    subject: entry.subject || "",
    teacher: entry.teacher || "",
    room: entry.room || "",
    self: !!entry.self,
    window: !!entry.makeWindow,
  };
  const useBase = !entry.makeWindow && !replacement.subject && !replacement.teacher && !replacement.room;
  const after = useBase && before ? { ...before } : replacement;
  return {
    d: dIso,
    n: n,
    subject: after.subject,
    teacher: after.teacher,
    room: after.room,
    cancelled: !!entry.cancelled,
    deleted: !!entry.deleted,
    moved: !!entry.moved,
    self: after.self,
    window: after.window,
    before: before,
    after: after,
  };
}

/* Длительность пары из ��асписания звонков: «1 ч 35 мин». Без времени начала/конца. */
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
function notifLessonHtml(f, lesson, cancelled) {
  const d = dateFromIso(f.d);
  const bell = BELLS.find((b) => b.n === Number(f.n));
  const time = bell ? (d.getDay() === 6 ? bell.sat : bell.week) : "";
  const value = lesson || {};
  const meta = [value.teacher, value.room, value.self ? "самостоятельная работа" : ""].filter(Boolean).join(" · ");
  return (
    '<span class="sched-notif-frag-lesson' + (cancelled ? " is-cancelled" : "") + '">' +
    (time ? "<time>" + escapeHtml(time) + "</time>" : "") +
    '<span class="sched-notif-frag-main"><b>' +
    escapeHtml(f.n + " пара" + (value.window ? " · окно" : value.subject ? " · " + value.subject : "")) +
    "</b>" +
    (meta ? "<i>" + escapeHtml(meta) + "</i>" : "") +
    "</span></span>"
  );
}
function notifFragHtml(n) {
  const f = n && n.frag;
  if (!f || !f.d || !f.n) return "";
  const d = dateFromIso(f.d);
  if (!d || Number.isNaN(d.getTime())) return "";
  const ordinarySwap = !f.cancelled && !f.deleted && !f.moved && f.before && f.after;
  const single = f.cancelled && f.before ? f.before : f.after || f;
  return (
    '<span class="sched-notif-frag">' +
    '<span class="sched-notif-frag-day">' + escapeHtml(dateLabel(d)) + "</span>" +
    (ordinarySwap
      ? '<span class="sched-notif-frag-change">' +
        notifLessonHtml(f, f.before, false) +
        '<span class="sched-notif-frag-arrow" aria-hidden="true">↓</span>' +
        notifLessonHtml(f, f.after, false) +
        "</span>"
      : notifLessonHtml(f, single, !!f.cancelled)) +
    "</span>"
  );
}

function closeBellSheet() {
  var backdrop = document.getElementById("bell-backdrop");
  if (!backdrop) return;
  backdrop.classList.remove("is-open");
  window.setTimeout(function () {
    backdrop.remove();
  }, 160);
}

function notifTitle(n, tone) {
  if (tone === "swap") return "замена";
  if (tone === "cancel") return "отмена пары";
  if (tone === "pending") return "предложено на проверку";
  return (n && n.text) || "";
}

function renderBellBody() {
  var body = document.getElementById("bell-sheet-body");
  if (!body) return;
  loadNotifs();
  var html =
    '<div class="sched-replace-head"><strong>уведомления</strong><span>замены и обновления</span></div>';
  if (!notifList.length) {
    html +=
      '<p class="sched-replace-hint sched-updates-empty">пока тихо. как только кто-то опубликует замену, отменит пару или обновится расписание — здесь появится запись.</p>';
  } else {
    html += '<div class="sched-tg-section">';
    notifList.forEach(function (n) {
      var tone = notifTone(n);
      html +=
        '<div class="sched-tg-row sched-notif-row is-' +
        tone +
        '">' +
        '<span class="sched-notif-ico" aria-hidden="true">' +
        (NOTIF_ICONS[tone] || NOTIF_ICONS.schedule) +
        '</span><div class="sched-tg-row-text"><strong>' +
        escapeHtml(notifTitle(n, tone)) +
        "</strong>" +
        notifFragHtml(n) +
        "<span>" +
        escapeHtml(fmtDateTime(n.at)) +
        "</span></div></div>";
    });
    html += "</div>";
  }
  html +=
    '<div class="sched-replace-actions">' +
    (notifList.length ? '<button type="button" data-bell="clear">очистить</button>' : "") +
    '<button type="button" data-bell="close">закрыть</button></div>';
  body.innerHTML = html;
}

function openBellSheet() {
  closeBellSheet();
  var backdrop = document.createElement("div");
  backdrop.id = "bell-backdrop";
  backdrop.className = "sched-replace-backdrop";
  backdrop.innerHTML =
    '<div class="sched-replace-sheet sched-tg-sheet" role="dialog" aria-label="уведомления"><div id="bell-sheet-body"></div></div>';
  document.body.appendChild(backdrop);
  window.requestAnimationFrame(function () {
    backdrop.classList.add("is-open");
  });
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
  notifList.forEach(function (n) {
    n.read = true;
  });
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
  return d.toLocaleString("ru", {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/* true, пока идёт ручное обновление — штамп под расписанием показывает «обновляем…». */
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
  el.textContent = offline ? "офлайн · " + when : "проверено " + when;
}

function fmtDateTime(isoValue) {
  const d = new Date(isoValue);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString("ru", {
    day: "numeric",
    month: "long",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function closeUpdatesSheet() {
  const backdrop = document.getElementById("updates-backdrop");
  if (!backdrop) return;
  backdrop.classList.remove("is-open");
  backdrop.remove();
}

function updatesRowHtml(entry) {
  const when = fmtDateTime(entry.at);
  const details = Array.isArray(entry.details) ? entry.details : [];
  return (
    '<div class="sched-tg-row"><div class="sched-tg-row-text"><strong>' +
    escapeHtml((entry.group || "?") + (entry.summary ? " · " + entry.summary : "")) +
    "</strong><span>" +
    escapeHtml(when) +
    "</span>" +
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
    '<div class="sched-replace-head"><strong>обновления расписания</strong><span>' +
    escapeHtml(stamp) +
    "</span></div>";
  const entries = data && Array.isArray(data.entries) ? data.entries : [];
  if (!entries.length) {
    html +=
      '<p class="sched-replace-hint sched-updates-empty">изменений пока не было. как только парсер найдёт отличия в PDF колледжа, они появятся здесь — по каждой группе отдельно.</p>';
  } else {
    html +=
      '<div class="sched-tg-section"><span>изменения по всем группам (' +
      entries.length +
      ")</span>";
    entries.forEach((entry) => {
      html += updatesRowHtml(entry);
    });
    html += "</div>";
  }
  html +=
    '<div class="sched-replace-actions"><button type="button" data-updates="close">закрыть</button></div>';
  body.innerHTML = html;
}

function openUpdatesSheet() {
  closeUpdatesSheet();
  const backdrop = document.createElement("div");
  backdrop.id = "updates-backdrop";
  backdrop.className = "sched-replace-backdrop";
  backdrop.innerHTML =
    '<div class="sched-replace-sheet sched-tg-sheet" role="dialog" aria-label="обновления расписания"><div id="updates-sheet-body"></div></div>';
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
  const icon = btn.querySelector(".sched-settings-icon svg") || btn.querySelector("svg");
  if (icon) icon.classList.add("is-spinning");
  /* Штамп под расписанием на время обновления показывает «обновляем…». */
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

/* ---------- Reports: one durable receipt for text, context and the complete attachment. ---------- */
var reportSelectedFile = null;
function closeReportSheet() {
  const backdrop = document.getElementById('report-backdrop');
  if (!backdrop || backdrop.dataset.sending === 'true') return;
  backdrop.remove(); reportSelectedFile = null;
}
function formatReportFileSize(bytes) {
  return bytes < 1024 ? bytes + ' б' : bytes < 1048576 ? Math.ceil(bytes / 1024) + ' кб' : (bytes / 1048576).toFixed(1) + ' мб';
}
function getSystemDiagnosticsText() {
  let updatedAt = null;
  try { updatedAt = JSON.parse(localStorage.getItem(SCHEDULE_CACHE_KEY) || 'null')?.updatedAt; } catch {}
  return JSON.stringify(diagnostics({ state, group: state.group, date: iso(state.selected), slots: slotsFor(state.selected),
    parity: parityOf(state.selected), authState: LOCAL_PREVIEW ? 'local' : tgAuthState,
    role: myRole(), notificationPreferences: loadNotifPrefs(), telegramChatStarted,
    cloudStatus: lastCloudStatus, cloudMessage: lastCloudMessage, scheduleCheckedAt, scheduleUpdatedAt: updatedAt }), null, 2);
}
function downloadClientFile(name, blob) {
  const url = URL.createObjectURL(blob), a = document.createElement('a');
  a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}
function openReportSheet() {
  closeReportSheet();
  if (document.getElementById('report-backdrop')) return;
  reportSelectedFile = null;
  const reportId = crypto.randomUUID(), diag = getSystemDiagnosticsText();
  const backdrop = document.createElement('div');
  backdrop.id = 'report-backdrop'; backdrop.className = 'sched-replace-backdrop is-open';
  backdrop.innerHTML = `<div class="sched-replace-sheet sched-report-sheet" role="dialog" aria-modal="true" aria-labelledby="report-title"><div id="report-sheet-content">
    <div class="sched-replace-head"><strong id="report-title">сообщить об ошибке</strong><span>${escapeHtml(state.group || 'группа не выбрана')} · ${escapeHtml(dateLabel(state.selected))}</span></div>
    <label class="sched-replace-field" for="report-message"><span>что произошло?</span><textarea class="sched-report-textarea" id="report-message" rows="3" maxlength="5000" placeholder="например: после переноса пары пропала аудитория" required></textarea></label>
    <input type="file" id="report-file-input" hidden accept=".png,.jpg,.jpeg,.webp,.gif,.heic,.heif,.mp4,.webm,.mov,.txt,.log,.json,.pdf,.doc,.docx">
    <button type="button" class="sched-report-dropzone" id="report-dropzone"><span class="sched-report-dropzone-text"><strong>прикрепить файл</strong><small>скриншот, видео или лог · до 20 мб</small></span></button>
    <div class="sched-report-file-preview" id="report-file-preview" hidden><div class="sched-report-file-info"><strong id="report-file-name"></strong><small id="report-file-size"></small></div><button type="button" id="report-file-remove" aria-label="удалить файл">×</button></div>
    <p id="report-file-error" class="sched-report-file-error" role="alert" hidden></p>
    <label class="sched-report-include"><input id="report-include-diag" type="checkbox" checked><span>прикрепить диагностику</span></label>
    <details class="sched-report-details"><summary>что войдёт в диагностику</summary><p class="sched-report-privacy">полные настройки пользователя, включая уведомления; выбранный день и пары, версия приложения, устройство, состояние подключения и последние ошибки. без токенов, паролей и истории браузера.</p><pre class="sched-report-diag-pre">${escapeHtml(diag)}</pre><button type="button" class="sched-report-download" id="report-download-diag">скачать диагностику</button></details>
    <p class="sched-report-form-error" id="report-form-error" role="alert" hidden></p>
    <div class="sched-replace-actions"><button type="button" data-report="close">отмена</button><button type="button" class="is-primary" id="report-submit-btn">отправить</button></div>
  </div></div>`;
  document.body.appendChild(backdrop);
  backdrop.addEventListener('click', event => { event.stopPropagation(); if (event.target === backdrop || event.target.closest('[data-report="close"]')) closeReportSheet(); });
  const input = backdrop.querySelector('#report-file-input'), zone = backdrop.querySelector('#report-dropzone');
  const preview = backdrop.querySelector('#report-file-preview'), fileError = backdrop.querySelector('#report-file-error');
  const setFile = file => {
    if (backdrop.dataset.sending === 'true') return;
    const error = validateReportFile(file);
    fileError.hidden = !error; fileError.textContent = error;
    if (error) { input.value = ''; return; }
    reportSelectedFile = file || null; preview.hidden = !file; zone.hidden = Boolean(file);
    if (file) { backdrop.querySelector('#report-file-name').textContent = file.name; backdrop.querySelector('#report-file-size').textContent = formatReportFileSize(file.size).toLocaleLowerCase('ru'); }
    else input.value = '';
  };
  zone.addEventListener('click', () => input.click()); input.addEventListener('change', () => setFile(input.files[0]));
  backdrop.querySelector('#report-file-remove').addEventListener('click', () => setFile(null));
  zone.addEventListener('dragover', event => { event.preventDefault(); zone.classList.add('is-dragover'); });
  zone.addEventListener('dragleave', () => zone.classList.remove('is-dragover'));
  zone.addEventListener('drop', event => { event.preventDefault(); zone.classList.remove('is-dragover'); setFile(event.dataTransfer?.files[0]); });
  backdrop.addEventListener('paste', event => { const file = [...(event.clipboardData?.files || [])][0]; if (file) { event.preventDefault(); setFile(file); } });
  backdrop.querySelector('#report-download-diag').addEventListener('click', () => downloadClientFile('sched-diagnostics.json', new Blob([diag], { type: 'application/json' })));
  const button = backdrop.querySelector('#report-submit-btn'), errorEl = backdrop.querySelector('#report-form-error');
  button.addEventListener('click', async () => {
    if (button.disabled) return;
    const message = backdrop.querySelector('#report-message').value.trim();
    if (!message) { errorEl.textContent = 'опиши, что произошло.'; errorEl.hidden = false; backdrop.querySelector('#report-message').focus(); return; }
    if (LOCAL_PREVIEW) { errorEl.textContent = 'локальный просмотр: отчёт не отправляется. диагностику можно скачать.'; errorEl.hidden = false; return; }
    const selectedFile = reportSelectedFile;
    backdrop.dataset.sending = 'true'; button.textContent = 'отправляем…'; errorEl.hidden = true;
    backdrop.querySelectorAll('button,input,textarea').forEach(el => el.disabled = true);
    try {
      const file = await readReportFile(selectedFile);
      const result = await botRequest('reports', { report_id: reportId, message,
        diagnostics: backdrop.querySelector('#report-include-diag').checked ? diag : '', group: state.group || '', file },
        pushSessionToken(), { retries: 1, timeout: 60000 });
      if (!result.report_id || selectedFile && !result.attachment_stored) throw new Error('сервер не подтвердил сохранение вложения. обнови сервер бота.');
      backdrop.dataset.sending = 'false';
      backdrop.querySelector('#report-sheet-content').innerHTML = `<div class="sched-report-success-view"><strong>отчёт принят</strong><span>№ ${escapeHtml(result.report_id.slice(0, 8))}${selectedFile ? '<br>файл сохранён: ' + escapeHtml(selectedFile.name) : ''}<br>спасибо, разберёмся.</span><button type="button" class="sched-telegram-button" data-report="close">готово</button></div>`;
    } catch (error) {
      backdrop.dataset.sending = 'false'; backdrop.querySelectorAll('button,input,textarea').forEach(el => el.disabled = false);
      button.textContent = 'повторить отправку'; errorEl.textContent = 'не удалось отправить: ' + String(error.message).toLocaleLowerCase('ru') + ' текст и файл остались в форме.'; errorEl.hidden = false;
    }
  });
}

/* ---------- просмотр отчётов об ошибках для владельца ---------- */

function closeReportsSheet() {
  const backdrop = document.getElementById("reports-backdrop");
  if (!backdrop) return;
  backdrop.classList.remove("is-open");
  window.setTimeout(() => backdrop.remove(), 220);
}

async function fetchBugReports() {
  const result = {};
  let serverError = null;
  try {
    if (!LOCAL_PREVIEW && tgSessionVerified) {
      const response = await botRequest('reports/list', {}, await ensurePushSession());
      for (const report of response.reports || []) result[report.id] = { ...report, fromBot: true };
    }
  } catch (error) { serverError = error; }
  if (sharedSwapsEnabled()) {
    try {
      const url = await sharedUrlWithAuth(cloudRoot() + '/' + CLOUD_PATHS.reports + '.json');
      const response = await fetch(url, { cache: 'no-store' });
      if (response.ok) Object.assign(result, await response.json() || {});
    } catch {}
  }
  if (serverError && !Object.keys(result).length) throw serverError;
  return result;
}

async function renderReportsSheetBody() {
  const body = document.getElementById("reports-sheet-body");
  if (!body) return;
  body.innerHTML =
    '<div class="sched-replace-head"><strong>отчёты об ошибках</strong><span>загрузка данных…</span></div>' +
    '<p class="sched-replace-hint">загружаем отчёты…</p>';

  let raw;
  try { raw = await fetchBugReports(); }
  catch (error) {
    body.innerHTML = `<div class="sched-replace-head"><strong>отчёты об ошибках</strong></div><p role="alert">${escapeHtml(error.message)}</p><div class="sched-replace-actions"><button data-reports-act="refresh">повторить</button><button data-reports-act="close">закрыть</button></div>`;
    return;
  }
  const list = Object.keys(raw)
    .map((id) => Object.assign({ id }, raw[id]))
    .filter((r) => r && (r.createdAt || r.message));
  list.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));

  let html =
    '<div class="sched-replace-head">' +
    "<strong>отчёты об ошибках</strong>" +
    "<span>всего отчётов: " +
    list.length +
    "</span>" +
    "</div>";

  if (!list.length) {
    html +=
      '<p class="sched-replace-hint sched-updates-empty" style="text-align:center;padding:24px 0;">отчётов пока нет — здесь появятся сообщения от пользователей.</p>';
  } else {
    html += '<div class="sched-reports-list">';
    list.forEach((r) => {
      const timeStr = r.createdAt ? fmtDateTime(r.createdAt) : "время не указано";
      const sender =
        (r.byName ? escapeHtml(r.byName) : "аноним") +
        (r.by ? ' <small style="opacity:0.75">(id: ' + escapeHtml(String(r.by)) + ")</small>" : "");
      const grp = r.group ? escapeHtml(r.group) : "не указана";

      let fileHtml = "";
      if (r.hasFile || r.fileName || r.fileData) {
        const fName = escapeHtml(r.fileName || "вложение");
        const fSize = r.fileSize ? " (" + formatReportFileSize(r.fileSize) + ")" : "";
        if (r.fromBot && r.hasFile) {
          fileHtml = `<div class="sched-report-card-file"><button class="sched-report-download" data-report-download="${escapeHtml(r.id)}">📎 ${fName}${fSize}</button></div>`;
        } else if (r.fileData && /^data:image\/(png|jpeg|gif|webp);base64,[A-Za-z0-9+/=]+$/.test(String(r.fileData))) {
          fileHtml =
            '<div class="sched-report-card-file">' +
            '<div class="sched-report-card-thumb"><img src="' +
            r.fileData +
            '" alt="' +
            fName +
            '"></div>' +
            '<a class="sched-report-file-link" href="' +
            r.fileData +
            '" download="' +
            fName +
            '" target="_blank">📎 ' +
            fName +
            fSize +
            "</a>" +
            "</div>";
        } else if (r.fileData && /^data:[a-z0-9.+/-]+;base64,[A-Za-z0-9+/=]+$/i.test(String(r.fileData))) {
          fileHtml =
            '<div class="sched-report-card-file">' +
            '<a class="sched-report-file-link" href="' +
            r.fileData +
            '" download="' +
            fName +
            '" target="_blank">📎 ' +
            fName +
            fSize +
            "</a>" +
            "</div>";
        } else {
          fileHtml =
            '<div class="sched-report-card-file"><span>📎 ' + fName + fSize + "</span></div>";
        }
      }

      let diagHtml = "";
      if (r.diagnostics) {
        diagHtml =
          '<details class="sched-report-card-diag">' +
          "<summary>диагностика системы</summary>" +
          "<pre>" +
          escapeHtml(r.diagnostics) +
          "</pre>" +
          "</details>";
      }

      html +=
        '<div class="sched-report-card" data-rep-id="' +
        escapeHtml(r.id) +
        '">' +
        '<div class="sched-report-card-top">' +
        '<div class="sched-report-card-sender">' +
        "<strong>" +
        sender +
        "</strong>" +
        "<span>" +
        timeStr +
        " · группа: " +
        grp +
        "</span>" +
        "</div>" +
        '<button type="button" class="sched-report-del-btn" data-del-report="' +
        escapeHtml(r.id) +
        '" data-report-source="' + (r.fromBot ? "bot" : "firebase") + '" title="удалить отчёт">' +
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>' +
        "</button>" +
        "</div>" +
        '<div class="sched-report-card-msg">' +
        escapeHtml(r.message || "") +
        "</div>" +
        fileHtml +
        diagHtml +
        "</div>";
    });
    html += "</div>";
  }

  html +=
    '<div class="sched-replace-actions" style="margin-top:14px;">' +
    '<button type="button" data-reports-act="refresh">обновить</button>' +
    '<button type="button" class="is-primary" data-reports-act="close">закрыть</button>' +
    "</div>";

  body.innerHTML = html;
}

function openReportsSheet() {
  closeReportsSheet();
  const backdrop = document.createElement("div");
  backdrop.id = "reports-backdrop";
  backdrop.className = "sched-replace-backdrop";
  backdrop.innerHTML =
    '<div class="sched-replace-sheet sched-tg-sheet sched-reports-sheet" role="dialog" aria-label="отчёты об ошибках">' +
    '<div id="reports-sheet-body"></div>' +
    "</div>";
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
    const download = e.target.closest('[data-report-download]');
    if (download) {
      download.disabled = true;
      try {
        const result = await botRequest('reports/file', { report_id: download.dataset.reportDownload }, await ensurePushSession(), { timeout: 60000 });
        const bytes = Uint8Array.from(atob(result.file.data), c => c.charCodeAt(0));
        downloadClientFile(result.file.name, new Blob([bytes], { type: 'application/octet-stream' }));
      } catch (error) { toast(error.message); }
      finally { download.disabled = false; }
      return;
    }
    const delBtn = e.target.closest("[data-del-report]");
    if (delBtn) {
      const repId = delBtn.dataset.delReport;
      if (!repId) return;
      if (confirm("удалить этот отчёт об ошибке?")) {
        delBtn.disabled = true;
        try {
          if (delBtn.dataset.reportSource === 'bot') await botRequest('reports/delete', { report_id: repId }, await ensurePushSession());
          else await cloudWrite(CLOUD_PATHS.reports + "/" + repId, null);
        } catch (error) { toast(error.message); return; }
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
  updateTgButton();
  if (!tgSession) prepareTelegramLogin();
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && !LOCAL_PREVIEW) {
      if (!tgSession) telegramLogin.resume();
      else refreshTgSubscription();
    }
  });
  window.addEventListener('online', () => {
    if (LOCAL_PREVIEW) return;
    if (!tgSession) telegramLogin.resume();
    else refreshTgSubscription();
  });
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
