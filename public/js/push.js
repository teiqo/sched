/* Telegram keys and secrets stay on the server. The browser uses sched sessions. */
export class BotApiError extends Error {
  constructor(message, status = 0, code = "network_error") {
    super(message);
    this.name = "BotApiError";
    this.status = status;
    this.code = code;
    this.permanent = status >= 400 && status < 500 && status !== 429;
  }
}

export function botEndpoint(path) {
  const raw = String(window.SCHED_NOTIFY_URL || "").trim();
  if (!raw) throw new BotApiError("адрес бота не настроен", 0, "not_configured");
  const url = new URL(raw, location.href);
  if (url.protocol !== "https:" || url.username || url.password) {
    throw new BotApiError("для бота нужен HTTPS-адрес без логина и пароля", 0, "bad_endpoint");
  }
  url.pathname = url.pathname.replace(/\/(?:notify|subscribe|auth(?:\/.*)?)\/?$/, "").replace(/\/$/, "") + "/" + path;
  url.search = "";
  url.hash = "";
  return url.href;
}

export async function botRequest(path, body = {}, token = "", { retries = 0, timeout = 10000 } = {}) {
  const url = botEndpoint(path);
  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    let delay = 500 * (attempt + 1);
    try {
      const headers = { "Content-Type": "application/json" };
      if (token) headers.Authorization = "Bearer " + token;
      const response = await fetch(url, {
        method: "POST", headers, body: JSON.stringify(body), signal: controller.signal,
        credentials: "omit", cache: "no-store", referrerPolicy: "no-referrer",
      });
      const result = await response.json().catch(() => null);
      if (response.ok && result?.ok === true) return result;
      const fallback = response.status === 401
        ? "сессия не подтверждена — войди через телеграм заново"
        : response.status === 403
          ? "бот отклонил доступ — проверь origin сайта и ID редактора в настройках сервера"
          : "бот временно недоступен";
      const error = new BotApiError(result?.error || fallback, response.status, result?.code || "http_error");
      if (response.status === 429) {
        const seconds = Number(response.headers.get("Retry-After") || result?.retry_after || 1);
        if (seconds > 5) throw error;
        delay = Math.max(1000, seconds * 1000);
      }
      // Never retry 401 or 403. The caller invalidates a rejected session once.
      if (error.permanent || attempt === retries || response.status === 429 && delay > 5000) throw error;
    } catch (error) {
      if (error instanceof BotApiError && (error.permanent || error.status === 429) || attempt === retries) {
        throw error instanceof BotApiError ? error : new BotApiError(
          error.name === "AbortError" ? "бот не ответил вовремя — попробуй позже" : "нет связи с сервером бота — попробуй позже",
        );
      }
    } finally {
      clearTimeout(timer);
    }
    await new Promise(resolve => setTimeout(resolve, delay));
  }
}

export async function sendBotEvent(event, token) {
  if (!token && event.type !== "report") {
    throw new BotApiError("для уведомлений нужен подтверждённый вход через телеграм", 401, "login_required");
  }
  return (await botRequest("notify", event, token, { retries: 2 })).ok === true;
}

export async function updateBotSubscription(preferences, group, token) {
  if (!token) throw new BotApiError("войди через телеграм, чтобы настроить уведомления", 401, "login_required");
  return botRequest("subscribe", { preferences, group }, token, { retries: 1 });
}

export function verifyAuthWithBot(authData) {
  return botRequest("auth/verify", authData);
}
