/* Migrates legacy localStorage/sessionStorage keys; owns Firebase path map. */
(function () {
  /* Read-only migration sources — product keys are sched: after copy. */
  var legacyPrefixes = ["weekly:", "weeqo:"];
  function migrate(store) {
    try {
      var keys = [];
      for (var i = 0; i < store.length; i++) keys.push(store.key(i));
      keys.forEach(function (key) {
        var prefix = legacyPrefixes.find(function (p) {
          return key && key.indexOf(p) === 0;
        });
        if (!prefix) return;
        var target = "sched:" + key.slice(prefix.length);
        if (store.getItem(target) === null) store.setItem(target, store.getItem(key));
      });
    } catch (_) {
      /* Storage may be disabled or full. No data is removed. */
    }
  }
  try {
    migrate(localStorage);
  } catch (_) {}
  try {
    migrate(sessionStorage);
  } catch (_) {}
  var nodes = {
    swaps: "sched-swaps",
    pending: "sched-pending",
    reports: "sched-reports",
    users: "sched-users",
    editors: "sched-editors",
    meta: "sched-meta",
    subs: "sched-tg-subs",
  };
  window.SCHED_COMPAT = Object.freeze({ cloudPaths: Object.freeze(nodes) });
})();
