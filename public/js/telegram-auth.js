/* Telegram OIDC Authorization Code flow with server-held PKCE verifier. */
const ATTEMPT_KEY = 'sched:telegram-oidc:v1';

export class TelegramLogin {
  constructor({request, authOrigin = '', onSession, onChange = () => {}, storage,
    openAuth = url => {
      const popup = window.open(url, 'sched-telegram-login', 'popup,width=520,height=720');
      if (!popup) window.location.assign(url);
      return popup;
    }}) {
    Object.assign(this, {request, authOrigin, onSession, onChange, openAuth});
    try { this.storage = storage === undefined ? globalThis.sessionStorage : storage; } catch { this.storage = null; }
    this.phase = 'idle'; this.error = ''; this.attempt = null; this.popup = null;
    this.epoch = 0; this.timer = null; this.preparing = null;
    try {
      const saved = JSON.parse(this.storage?.getItem(ATTEMPT_KEY) || 'null');
      if (this.valid(saved) && saved.expires_at * 1000 > Date.now() + 10000) {
        this.attempt = saved; this.phase = 'waiting'; this.pollLater(0);
      } else this.clearSaved();
    } catch { this.clearSaved(); }
    if (globalThis.window?.addEventListener) {
      window.addEventListener('message', event => {
        if (event.origin === this.authOrigin && event.data?.type === 'sched-oidc-complete') this.poll();
      });
    }
  }
  get snapshot() { return {phase:this.phase, error:this.error, authUrl:this.attempt?.auth_url || ''}; }
  emit(phase = this.phase, error = '') { this.phase = phase; this.error = error; this.onChange(this.snapshot); }
  valid(a) {
    if (!a || a.method !== 'oidc_pkce' || !/^[A-Za-z0-9_-]{32}$/.test(a.attempt_id || '') ||
        !/^[A-Za-z0-9_-]{32}$/.test(a.attempt_secret || '') || !Number.isFinite(a.expires_at)) return false;
    try {
      const url = new URL(a.auth_url);
      return url.origin === 'https://oauth.telegram.org' && url.pathname === '/auth' &&
        url.searchParams.get('response_type') === 'code' && url.searchParams.get('state') === a.attempt_id &&
        url.searchParams.get('code_challenge_method') === 'S256';
    } catch { return false; }
  }
  credentials(a = this.attempt) { return {attempt_id:a?.attempt_id, attempt_secret:a?.attempt_secret}; }
  remember() { try { this.storage?.setItem(ATTEMPT_KEY, JSON.stringify(this.attempt)); } catch {} }
  clearSaved() { try { this.storage?.removeItem(ATTEMPT_KEY); } catch {} }
  async prepare() {
    if (['waiting','authenticated'].includes(this.phase)) return;
    if (this.preparing) return this.preparing;
    if (this.phase === 'ready' && this.attempt?.expires_at * 1000 > Date.now() + 15000) return;
    const run = ++this.epoch;
    clearTimeout(this.timer); this.emit('loading');
    const job = (async () => {
      try {
        const attempt = await this.request('auth/start', {});
        if (run !== this.epoch) return;
        if (!this.valid(attempt)) throw new Error('сервер вернул некорректный oidc-запрос');
        this.attempt = attempt; this.remember(); this.emit('ready');
      } catch (error) {
        if (run === this.epoch) this.emit('error', error.message || 'не удалось подготовить вход');
      }
    })();
    this.preparing = job;
    try { await job; } finally { if (this.preparing === job) this.preparing = null; }
  }
  start() {
    if (this.phase === 'waiting' && this.attempt) {
      this.popup = this.openAuth(this.attempt.auth_url); return;
    }
    if (this.phase !== 'ready') { if (this.phase !== 'loading') this.prepare(); return; }
    if (this.attempt.expires_at * 1000 <= Date.now()) { this.phase = 'idle'; this.prepare(); return; }
    this.remember(); this.emit('waiting');
    this.popup = this.openAuth(this.attempt.auth_url);
    this.pollLater(1200);
  }
  accept(session) {
    if (!session?.session_token?.startsWith('sess_') || !session.id || !session.user) throw new Error('сервер не подтвердил вход');
    ++this.epoch; clearTimeout(this.timer); this.popup?.close?.(); this.popup = null;
    this.attempt = null; this.clearSaved(); this.emit('authenticated'); this.onSession(session);
  }
  pollLater(ms) { clearTimeout(this.timer); this.timer = setTimeout(() => this.poll(), ms); this.timer?.unref?.(); }
  async poll() {
    if (this.phase !== 'waiting' || !this.attempt) return;
    if (this.attempt.expires_at * 1000 <= Date.now()) {
      this.attempt = null; this.clearSaved(); this.emit('error', 'время входа истекло. начни заново'); return;
    }
    if (globalThis.document?.hidden || globalThis.navigator?.onLine === false) { this.pollLater(2500); return; }
    const run = this.epoch;
    try {
      const result = await this.request('auth/status', this.credentials());
      if (run !== this.epoch) return;
      if (result.session_token) { this.accept(result); return; }
      this.emit('waiting'); this.pollLater(1800);
    } catch (error) {
      if (run !== this.epoch) return;
      if ([401,403,410].includes(error.status)) {
        this.attempt = null; this.clearSaved(); this.emit('error', error.message);
      } else {
        this.emit('waiting', 'проверяем соединение…'); this.pollLater(5000);
      }
    }
  }
  async cancel() {
    const attempt = this.attempt;
    ++this.epoch; clearTimeout(this.timer); this.popup?.close?.(); this.popup = null;
    this.attempt = null; this.preparing = null; this.clearSaved(); this.emit('idle');
    if (attempt) await this.request('auth/cancel', this.credentials(attempt)).catch(() => {});
  }
  resume() {
    if (this.phase === 'waiting') this.pollLater(0);
    else if (!['authenticated','loading'].includes(this.phase)) this.prepare();
  }
}
