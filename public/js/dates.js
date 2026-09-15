/* Pure calendar helpers — no DOM, no app state. */
export const SHORT = ["пн", "вт", "ср", "чт", "пт", "сб", "вс"];

export const MONTHS = [
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

export function startOfDay(d) {
  const x = new Date(d.getTime());
  x.setHours(0, 0, 0, 0);
  return x;
}

export function addDays(d, n) {
  const x = new Date(d.getTime());
  x.setDate(x.getDate() + n);
  return startOfDay(x);
}

export function weekStart(d) {
  const x = startOfDay(d);
  const shift = (x.getDay() + 6) % 7;
  return addDays(x, -shift);
}

export function sameDay(a, b) {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

export function isoWeek(d) {
  const x = startOfDay(d);
  const day = (x.getDay() + 6) % 7;
  x.setDate(x.getDate() - day + 3);
  const first = new Date(x.getFullYear(), 0, 4);
  const fd = (first.getDay() + 6) % 7;
  first.setDate(first.getDate() - fd + 3);
  return 1 + Math.round((x - first) / 604800000);
}

export function iso(d) {
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
