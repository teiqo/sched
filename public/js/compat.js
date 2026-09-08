/* Only this file owns old browser/cloud namespaces. Existing data is not renamed remotely. */
(function () {
  var prefixes = ["weekly:", "weeqo:"];
  function migrate(store) {
    try {
      var keys = [];
      for (var i = 0; i < store.length; i++) keys.push(store.key(i));
      keys.forEach(function (key) {
        var prefix = prefixes.find(function (p) {
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
    swaps: "weeqo-swaps",
    pending: "weeqo-pending",
    reports: "weeqo-reports",
    users: "weeqo-users",
    editors: "weeqo-editors",
    meta: "weeqo-meta",
    subs: "weeqo-tg-subs",
  };
  window.SCHED_COMPAT = Object.freeze({ cloudPaths: Object.freeze(nodes) });
})();
