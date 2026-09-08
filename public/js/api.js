/* Public bot transport. Authentication responses are never cached or logged. */
export class ApiError extends Error {
  constructor(message, { status = 0, code = "network", retryAfter = 0 } = {}) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.retryAfter = retryAfter;
  }
  get transient() { return !this.status || this.status >= 500 || this.status === 429; }
}

export function botEndpoint(path) {
  const raw = String(globalThis.window?.SCHED_NOTIFY_URL || "").trim();
  if (!raw) throw new ApiError("администратор ещё не настроил сервер входа.", { code: "not_configured", status: 400 });
  let url;
  try { url = new URL(raw); } catch { throw new ApiError("неверный адрес сервера входа.", { code: "configuration", status: 400 }); }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
    throw new ApiError("для сервера нужен HTTPS-адрес без пароля и параметров.", { code: "configuration", status: 400 });
  }
  url.pathname = url.pathname.replace(/\/(?:notify|subscribe|auth\/(?:verify|start|status|cancel|logout|firebase|bot\/complete))\/?$/, "").replace(/\/$/, "") + "/" + path;
  return url.href;
}

export async function botRequest(path, body = {}, { token = "", signal, timeout = 12000 } = {}) {
  const url = botEndpoint(path);
  const controller = new AbortController();
  const cancel = () => controller.abort();
  if (signal?.aborted) cancel();
  signal?.addEventListener("abort", cancel, { once: true });
  const timer = setTimeout(cancel, timeout);
  try {
    const headers = { "Content-Type": "application/json", Accept: "application/json" };
    if (token) headers.Authorization = "Bearer " + token;
    const response = await fetch(url, {
      method: "POST", headers, body: JSON.stringify(body), signal: controller.signal,
      credentials: "omit", cache: "no-store", referrerPolicy: "no-referrer", redirect: "error",
    });
    let result;
    try { result = await response.json(); } catch {
      throw new ApiError("сервер вернул непонятный ответ. проверьте его адрес или повторите позже.", { status: response.status >= 400 ? response.status : 502, code: "bad_response" });
    }
    if (!response.ok || result?.ok !== true) {
      throw new ApiError(typeof result?.error === "string" ? result.error.slice(0, 300) : "сервер отклонил запрос.", {
        status: response.status, code: result?.code || "request_failed",
        retryAfter: Math.min(300, Math.max(0, Number(result?.retry_after || response.headers.get("Retry-After")) || 0)),
      });
    }
    return result;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(signal?.aborted ? "запрос отменён." : controller.signal.aborted
      ? "сервер не ответил вовремя. попробуйте ещё раз."
      : "нет связи с сервером входа. проверьте интернет и повторите.", { code: signal?.aborted ? "cancelled" : "network" });
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", cancel);
  }
}
