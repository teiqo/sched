const escape = value => String(value || '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export const TELEGRAM_ICON = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M20.7 3.4 3.1 10.2c-1.2.5-1.2 1.2-.2 1.5l4.5 1.4 10.5-6.6c.5-.3.9-.1.5.3l-8.5 7.7-.3 4.5c.4 0 .6-.2.9-.5l2.2-2.1 4.6 3.4c.9.5 1.5.3 1.7-.9l3-14.1c.3-1.4-.5-1.9-1.3-1.4Z"/></svg>';
export function authButtonHtml(view = {}, local = false) {
  const busy = view.phase === 'loading' && !local;
  const waiting = view.phase === 'waiting';
  const label = local ? 'тестовый вход' : waiting ? 'продолжить вход' : busy ? 'готовим вход…' : 'войти через телеграм';
  return `<div class="sched-login"><button type="button" class="sched-telegram-button" data-auth-action="login"${busy ? ' disabled' : ''} aria-busy="${busy}">
    ${TELEGRAM_ICON}<span>${label}</span>${busy ? '<i class="sched-login-spinner" aria-hidden="true"></i>' : ''}</button>
    ${waiting ? '<p class="sched-login-note" role="status">заверши вход в окне телеграм</p>' : ''}
    ${view.error ? `<p class="sched-login-error" role="alert">${escape(view.error)}</p>` : ''}
  </div>`;
}
