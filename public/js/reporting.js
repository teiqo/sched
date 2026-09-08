export const BUILD = '1.4.0 · 2026-09-08.7';
export const MAX_REPORT_FILE_SIZE = 20 * 1024 * 1024;
const recent = [];
export function redact(text) {
  return String(text ?? '')
    .replace(/(?:sess_[A-Za-z0-9_.-]+|sched2_[A-Za-z0-9_-]+|Bearer\s+\S+|\b[0-9]{6,}:[A-Za-z0-9_-]{20,}\b|\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)/gi, '[скрыто]')
    .replace(/(token|secret|password|authorization|api[_-]?key|initData)\s*[=:]\s*[^\s,;]+/gi, '$1=[скрыто]')
    .replace(/https?:\/\/[^\s"<>]+/g, raw => { try { const url = new URL(raw); return url.origin + url.pathname; } catch { return '[ссылка]'; } })
    .slice(0, 2000);
}
export function recordError(kind, message) {
  recent.push({ at: new Date().toISOString(), kind, message: redact(message).slice(0, 500) });
  if (recent.length > 5) recent.shift();
}
if (typeof window !== 'undefined') {
  window.addEventListener('error', event => { if (event.message) recordError('javascript', event.message); });
  window.addEventListener('unhandledrejection', event => recordError('promise', event.reason?.message || 'необработанная ошибка'));
}
export function diagnostics({ state, group, date, slots, parity, authState, role, notificationPreferences = {},
  telegramChatStarted, cloudStatus, cloudMessage, scheduleCheckedAt, scheduleUpdatedAt }) {
  return {
    build: BUILD, capturedAt: new Date().toISOString(), timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    page: location.origin + location.pathname, online: navigator.onLine,
    viewport: { width: innerWidth, height: innerHeight, dpr: devicePixelRatio || 1 }, userAgent: navigator.userAgent,
    pwa: matchMedia('(display-mode: standalone)').matches || navigator.standalone === true,
    group: group || 'не выбрано', selectedDate: date, parity,
    // Explicit allowlist: never dump localStorage or the authentication session.
    settings: {
      group: state.group || '', theme: state.theme, themeManual: Boolean(state.themeManual),
      palette: state.palette, accent: state.accent, perfMode: Boolean(state.perfMode),
      windows: Boolean(state.windows), showVacancies: Boolean(state.showVacancies),
      showSelfStudy: state.showSelfStudy !== false, showSwapButtons: state.showSwapButtons, light: Boolean(state.light),
      scope: state.scope, tab: state.tab, parityMode: state.parityMode, onboarded: Boolean(state.onboarded),
      notifications: {
        swaps: Boolean(notificationPreferences.swaps), schedule: Boolean(notificationPreferences.schedule),
        pending: Boolean(notificationPreferences.pending), telegram: Boolean(notificationPreferences.telegram),
      },
    },
    language: navigator.language, languages: Array.from(navigator.languages || []),
    reducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches,
    auth: { state: authState, role, telegramChatStarted: telegramChatStarted ?? null },
    cloud: { status: cloudStatus || 0, message: redact(cloudMessage || '') },
    schedule: { checkedAt: scheduleCheckedAt ? new Date(scheduleCheckedAt).toISOString() : null, updatedAt: scheduleUpdatedAt || null,
      slots: slots.map(({n,from,to,subject,teacher,room,self,window,cancelled,swapped,moved,movedFrom}) =>
        ({n,from,to,subject,teacher,room,self,window,cancelled,swapped,moved,movedFrom})) },
    recentErrors: recent.slice(),
  };
}
export function validateReportFile(file) {
  if (!file) return '';
  if (!file.size) return 'файл пустой.';
  if (file.size > MAX_REPORT_FILE_SIZE) return 'максимальный размер файла — 20 мб.';
  if (!/\.(png|jpe?g|webp|gif|heic|heif|mp4|webm|mov|txt|log|json|pdf|docx?)$/i.test(file.name)) return 'прикрепи изображение, видео, pdf, документ или текстовый лог.';
  return '';
}
export function readReportFile(file) {
  if (!file) return Promise.resolve(null);
  const error = validateReportFile(file); if (error) return Promise.reject(new Error(error));
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve({ name: file.name, mime: file.type || 'application/octet-stream', size: file.size, data: String(reader.result).split(',')[1] });
    reader.onerror = () => reject(new Error('не удалось прочитать файл. выбери его ещё раз.'));
    reader.readAsDataURL(file);
  });
}
