# Manual steps after `cleanup/sched-rename-and-declutter`

Code and rules now use `sched-*` Firebase paths and `sched:` storage prefixes. Deploy order matters.

## 1. Export / migrate Firebase RTDB data

Copy (or move) these root nodes so live data is not lost when rules switch:

| Old node        | New node        |
|-----------------|-----------------|
| `weeqo-swaps`   | `sched-swaps`   |
| `weeqo-pending` | `sched-pending` |
| `weeqo-users`   | `sched-users`   |
| `weeqo-editors` | `sched-editors` |
| `weeqo-meta`    | `sched-meta`    |
| `weeqo-tg-subs` | `sched-tg-subs` |
| `weeqo-reports` | `sched-reports` |

Suggested approach in Firebase console or Admin SDK:

1. Export each `weeqo-*` node (or full DB backup).
2. Write the same JSON under the matching `sched-*` path.
3. Smoke-check reads/writes on `sched-*`.
4. Only then delete the old `weeqo-*` nodes (keep a backup).

Keep **public read** on `sched-swaps` and **anonymous pending** writes (`anonymous: true`, `by: anon:<64 hex>`) — rules already preserve that under the new names.

## 2. Deploy Firebase rules

Publish `config/firebase.rules.json` (now keyed as `sched-*`) to the RTDB project used by the site/bot.

## 3. Clear caches / bump service worker

This branch bumps the SW cache id to `…v125-sched-rename-declutter`. After Pages deploy:

- Hard-refresh the PWA (or uninstall/re-add).
- Or call the existing SW `purge` message / clear site data once so old `weeqo-groups-*` / `weekly-groups-*` / `weekly:` / `weeqo:` caches and storage leftovers go away.
- `public/js/compat.js` still **reads** legacy `weekly:` / `weeqo:` localStorage keys and copies them to `sched:` (one-way migrate). It does not delete old keys.

## 4. External dashboard / env / bot

- Update any Firebase console bookmarks, scripts, or metrics that pointed at `weeqo-*`.
- Redeploy the Telegram bot if it embeds RTDB paths (current bot code mostly uses logical names via the web client; confirm no hard-coded `weeqo-` in your private deploy config).
- Rebuild site config (`scripts/build_config.py` / `stage_site.py`) so `public/js/config.js` on the host stays secret-free.

## 5. Redeploy Pages (and bot)

1. Stage/publish `public/` only (per README).
2. Redeploy bot services that serve auth/notify/reports.
3. Verify: schedule loads, shared swaps visible while logged out, anonymous suggest still posts to `sched-pending`, editor login still writes `sched-swaps`.

## 6. Optional cleanup later

- Split `public/css/app-ui.css` (formerly `overrides.css`) further into `palettes` / `layout` / `components` and drop remaining `!important` where the cascade allows.
- Remove legacy localStorage migrate prefixes from `compat.js` after most clients have visited once on `sched:`.
