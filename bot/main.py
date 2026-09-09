#!/usr/bin/env python3
"""sched notification and authentication server.

configuration is read only from environment. secrets never belong in public/.
"""
from __future__ import annotations

import argparse
import asyncio
import base64
import hashlib
import hmac
import html
import json
import logging
import os
from pathlib import Path
import re
import signal
import socket
import sqlite3
import sys
import threading
import time
from html import escape
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.error import HTTPError, URLError
from urllib.parse import parse_qs, urlsplit
from urllib.request import Request, urlopen

# Use package-relative imports under `python -m bot.main`, and local imports
# under direct `python bot/main.py` execution. This avoids accidentally loading
# an unrelated installed package named `reports`.
if __package__:
    from .authentication import Auth, AuthError
    from .reports import Reports, ReportError, MAX_BODY as MAX_REPORT_BODY
else:
    bot_dir = str(Path(__file__).resolve().parent)
    if not sys.path or sys.path[0] != bot_dir:
        sys.path.insert(0, bot_dir)
    from authentication import Auth, AuthError
    from reports import Reports, ReportError, MAX_BODY as MAX_REPORT_BODY

LOG = logging.getLogger("sched")
GREETING = "<b>привет=)</b>"
MAX_BODY = 65536


class Config:
    def __init__(self, env=None):
        env = os.environ if env is None else env
        self.token = env.get("TELEGRAM_BOT_TOKEN", "").strip()
        self.secret = env.get("NOTIFY_SECRET", "").strip()
        self.owner = env.get("TELEGRAM_OWNER_ID", "").strip()
        self.admins = {x.strip() for x in env.get("TELEGRAM_ADMIN_IDS", "").split(",") if x.strip()}
        if self.owner:
            self.admins.add(self.owner)
        self.bot_name = env.get("TELEGRAM_BOT_NAME", "").strip().lstrip("@")
        self.telegram_client_id = env.get("TELEGRAM_CLIENT_ID", "").strip()
        self.telegram_client_secret = env.get("TELEGRAM_CLIENT_SECRET", "").strip()
        self.telegram_oidc_algorithm = env.get("TELEGRAM_OIDC_ALGORITHM", "RS256").strip()
        self.firebase_credentials = None
        credential_path = env.get("FIREBASE_SERVICE_ACCOUNT_FILE", "").strip()
        if credential_path:
            path = Path(credential_path).expanduser().resolve()
            public = Path(__file__).resolve().parents[1] / "public"
            if path == public or public in path.parents:
                raise ValueError("ключ firebase должен храниться вне public/.")
            try:
                value = json.loads(path.read_text(encoding="utf-8"))
                if not isinstance(value, dict) or not all(isinstance(value.get(k), str) and value[k] for k in ("client_email", "private_key", "project_id")):
                    raise ValueError()
                self.firebase_credentials = value
            except (ValueError, OSError):
                raise ValueError("не удалось прочитать серверный ключ FIREBASE_SERVICE_ACCOUNT_FILE.") from None
        self.public_url = env.get("BOT_PUBLIC_URL", "").strip().rstrip("/")
        self.base_path = urlsplit(self.public_url).path.rstrip("/")
        self.telegram_redirect_uri = self.public_url + "/auth/callback"
        # These are current AlwaysData variables. Legacy aliases are fallback only.
        self.host = env.get("IP") or env.get("ALWAYSDATA_HTTPD_IP") or env.get("SCHED_HOST") or "::"
        self.port = int(env.get("PORT") or env.get("ALWAYSDATA_HTTPD_PORT") or env.get("SCHED_PORT") or "8080")
        self.origins = {x.strip().rstrip("/") for x in env.get("SCHED_ALLOWED_ORIGINS", "").split(",") if x.strip()}
        default = Path(__file__).resolve().parent / "data"
        self.data_dir = Path(env.get("SCHED_DATA_DIR") or default)
        self.report_quota_bytes = max(32, int(env.get("SCHED_REPORT_QUOTA_MB", "256"))) * 1024 * 1024
        self.telegram_secret = hmac.new(self.secret.encode(), b"sched-telegram-webhook", hashlib.sha256).hexdigest()

    def validate(self):
        if not self.token or ":" not in self.token:
            raise ValueError("задай TELEGRAM_BOT_TOKEN в Environment variables.")
        if len(self.secret) < 32:
            raise ValueError("NOTIFY_SECRET должен содержать не менее 32 случайных символов; только серверный env.")
        u = urlsplit(self.public_url)
        if u.scheme != "https" or not u.hostname or u.username or u.password or u.query or u.fragment:
            raise ValueError("BOT_PUBLIC_URL должен быть публичным HTTPS-адресом бота, без /notify и /telegram в конце.")
        if not self.owner or not all(re.fullmatch(r"[1-9][0-9]{0,19}", x) for x in self.admins):
            raise ValueError("TELEGRAM_OWNER_ID обязателен; TELEGRAM_ADMIN_IDS — числовые ID через запятую.")
        if not 0 <= self.port <= 65535:
            raise ValueError("некорректный PORT.")
        if self.bot_name and not re.fullmatch(r"[A-Za-z0-9_]{5,32}", self.bot_name):
            raise ValueError("TELEGRAM_BOT_NAME — username бота без @.")
        if not re.fullmatch(r"[1-9][0-9]{0,19}", self.telegram_client_id):
            raise ValueError("задай числовой TELEGRAM_CLIENT_ID из BotFather → Web Login.")
        if len(self.telegram_client_secret) < 16:
            raise ValueError("задай TELEGRAM_CLIENT_SECRET из BotFather → Web Login.")
        if self.telegram_oidc_algorithm not in ("RS256", "ES256"):
            raise ValueError("TELEGRAM_OIDC_ALGORITHM должен быть RS256 или ES256 для scope profile.")
        if not self.origins:
            raise ValueError("задай SCHED_ALLOWED_ORIGINS: точные HTTPS-origin сайта, через запятую.")
        for origin in self.origins:
            p = urlsplit(origin)
            if p.scheme != "https" or not p.hostname or p.username or p.password or p.path or p.query or p.fragment:
                raise ValueError("SCHED_ALLOWED_ORIGINS: HTTPS-origin без пути, например https://name.github.io.")


class Store:
    """Durable queue. Every accepted event is stored before an HTTP success response."""
    def __init__(self, path):
        path = Path(path)
        path.parent.mkdir(parents=True, exist_ok=True)
        self.lock = threading.RLock()
        self.db = sqlite3.connect(path, check_same_thread=False)
        self.db.row_factory = sqlite3.Row
        try:
            os.chmod(path, 0o600)
        except OSError:
            pass
        self.db.executescript("""
          PRAGMA journal_mode=DELETE;
          PRAGMA busy_timeout=5000;
          CREATE TABLE IF NOT EXISTS chats (
            id TEXT PRIMARY KEY, active INTEGER NOT NULL DEFAULT 0,
            swaps INTEGER NOT NULL DEFAULT 1, schedule INTEGER NOT NULL DEFAULT 1,
            pending INTEGER NOT NULL DEFAULT 1, group_name TEXT NOT NULL DEFAULT ''
          );
          CREATE TABLE IF NOT EXISTS events (id TEXT PRIMARY KEY, created REAL NOT NULL);
          CREATE TABLE IF NOT EXISTS app_users (
            id TEXT PRIMARY KEY, first_seen REAL NOT NULL, last_seen REAL NOT NULL,
            name TEXT NOT NULL DEFAULT '', username TEXT NOT NULL DEFAULT '',
            logins INTEGER NOT NULL DEFAULT 1
          );
          CREATE TABLE IF NOT EXISTS app_visitors (
            id TEXT PRIMARY KEY, first_seen REAL NOT NULL, last_seen REAL NOT NULL,
            authenticated_user TEXT NOT NULL DEFAULT ''
          );
          CREATE TABLE IF NOT EXISTS outbox (
            event_id TEXT NOT NULL, chat_id TEXT NOT NULL, text TEXT NOT NULL,
            attempts INTEGER NOT NULL DEFAULT 0, state TEXT NOT NULL DEFAULT 'pending',
            PRIMARY KEY(event_id, chat_id)
          );
        """)
        # Additive migrations preserve queue and sessions on existing deployments.
        for table, columns in {
            'chats': {'started':'INTEGER NOT NULL DEFAULT 0', 'prefs_set':'INTEGER NOT NULL DEFAULT 0'},
            'outbox': {'method':"TEXT NOT NULL DEFAULT 'sendMessage'", 'payload':"TEXT NOT NULL DEFAULT ''",
                       'report_id':"TEXT NOT NULL DEFAULT ''", 'part':"TEXT NOT NULL DEFAULT ''"},
        }.items():
            existing = {r['name'] for r in self.db.execute('PRAGMA table_info('+table+')')}
            for name, definition in columns.items():
                if name not in existing:
                    self.db.execute('ALTER TABLE '+table+' ADD COLUMN '+name+' '+definition)
                    if table == 'chats' and name == 'started':
                        self.db.execute('UPDATE chats SET started=1')
                    if table == 'chats' and name == 'prefs_set':
                        self.db.execute('UPDATE chats SET prefs_set=1')
        self.db.commit()

    def subscribe(self, chat_id, active=True, prefs=None, group="", started=True):
        with self.lock, self.db:
            self.db.execute("INSERT OR IGNORE INTO chats(id,active) VALUES (?,0)", (str(chat_id),))
            if started is not None:
                self.db.execute('UPDATE chats SET started=? WHERE id=?', (int(started),str(chat_id)))
            if prefs is None:
                self.db.execute("UPDATE chats SET active=? WHERE id=?", (int(active), str(chat_id)))
                if group: self.db.execute("UPDATE chats SET group_name=? WHERE id=?", (group[:100],str(chat_id)))
            else:
                self.db.execute("UPDATE chats SET active=?,swaps=?,schedule=?,pending=?,group_name=?,prefs_set=1 WHERE id=?",
                                (int(active), int(prefs.get("swaps", True)), int(prefs.get("schedule", True)),
                                 int(prefs.get("pending", True)), group[:100], str(chat_id)))

    def mark_started(self, chat_id, started=True):
        with self.lock, self.db:
            self.db.execute('INSERT OR IGNORE INTO chats(id,active) VALUES (?,0)', (str(chat_id),))
            self.db.execute('UPDATE chats SET started=? WHERE id=?', (int(started),str(chat_id)))

    def subscription(self, chat_id):
        with self.lock:
            row = self.db.execute('SELECT * FROM chats WHERE id=?', (str(chat_id),)).fetchone()
        return {'ok':True, 'chat_started':bool(row and row['started']), 'configured':bool(row and row['prefs_set']),
                'group':row['group_name'] if row else '', 'preferences':{
                    'telegram':bool(row and row['active']), 'swaps':bool(row['swaps']) if row else True,
                    'schedule':bool(row['schedule']) if row else True, 'pending':bool(row['pending']) if row else True}}

    def delivery_allowed(self, row):
        with self.lock:
            current = self.db.execute('SELECT state FROM outbox WHERE event_id=? AND chat_id=?', (row['event_id'],row['chat_id'])).fetchone()
            if not current or current['state'] != 'pending': return False
        kind = next((kind for kind in ('swap','schedule','pending') if row['event_id'].startswith('event:'+kind+':')), None)
        if kind:
            sub = self.subscription(row['chat_id'])
            return sub['chat_started'] and sub['preferences']['telegram'] and sub['preferences']['swaps' if kind == 'swap' else kind]
        return True

    def recipients(self, kind, group=""):
        column = 'pending' if kind == 'pending' else "schedule" if kind == "schedule" else "swaps"
        with self.lock:
            rows = self.db.execute(f"SELECT id,group_name FROM chats WHERE active=1 AND started=1 AND {column}=1").fetchall()
        return [r["id"] for r in rows if kind == "pending" or r["group_name"] and (not group or r["group_name"] == group)]

    def enqueue(self, event_id, text, targets, method="sendMessage", payload=None):
        targets = set(map(str, targets))
        with self.lock, self.db:
            if self.db.execute("SELECT 1 FROM events WHERE id=?", (event_id,)).fetchone():
                return False, 0
            self.db.execute("INSERT INTO events VALUES (?,?)", (event_id, time.time()))
            self.db.executemany("INSERT INTO outbox(event_id,chat_id,text,method,payload) VALUES (?,?,?,?,?)",
                                [(event_id, t, text[:3900], method, json.dumps(payload or {}, ensure_ascii=False)) for t in targets])
            # Bounded housekeeping of already delivered entries, never pending data.
            cutoff = time.time() - 30 * 86400
            self.db.execute("DELETE FROM events WHERE created<? AND id NOT IN (SELECT event_id FROM outbox WHERE state='pending')", (cutoff,))
            self.db.execute("DELETE FROM outbox WHERE state!='pending' AND event_id NOT IN (SELECT id FROM events)")
        return True, len(targets)

    def pending(self):
        with self.lock:
            return self.db.execute("SELECT * FROM outbox WHERE state='pending' ORDER BY rowid LIMIT 64").fetchall()

    def mark(self, row, state):
        with self.lock, self.db:
            self.db.execute("UPDATE outbox SET state=?, attempts=attempts+1 WHERE event_id=? AND chat_id=?",
                            (state, row["event_id"], row["chat_id"]))
            if state != "pending" and row["event_id"].startswith("telegram-auth:"):
                self.db.execute("UPDATE outbox SET text='',payload='' WHERE event_id=? AND chat_id=?", (row["event_id"], row["chat_id"]))

    def record_user(self, user, login=False):
        if not isinstance(user, dict) or not str(user.get("id") or "").isdigit():
            return
        uid = str(user["id"])
        name = " ".join(filter(None, [str(user.get("first_name") or "").strip(), str(user.get("last_name") or "").strip()]))[:240]
        username = str(user.get("username") or "")[:80]
        now = time.time()
        with self.lock, self.db:
            self.db.execute("""
              INSERT INTO app_users(id,first_seen,last_seen,name,username,logins)
              VALUES (?,?,?,?,?,1)
              ON CONFLICT(id) DO UPDATE SET
                last_seen=excluded.last_seen,
                name=CASE WHEN excluded.name!='' THEN excluded.name ELSE app_users.name END,
                username=CASE WHEN excluded.username!='' THEN excluded.username ELSE app_users.username END,
                logins=app_users.logins + ?
            """, (uid, now, now, name, username, int(bool(login))))

    def record_visitor(self, visitor_id, authenticated_user=""):
        """Count a browser without storing its raw installation identifier."""
        if not isinstance(visitor_id, str) or not re.fullmatch(r"[A-Za-z0-9_-]{20,100}", visitor_id):
            raise ValueError("invalid visitor id")
        digest_id = hashlib.sha256(visitor_id.encode("utf-8")).hexdigest()
        user_id = str(authenticated_user or "") if str(authenticated_user or "").isdigit() else ""
        now = time.time()
        with self.lock, self.db:
            self.db.execute("""
              INSERT INTO app_visitors(id,first_seen,last_seen,authenticated_user)
              VALUES (?,?,?,?)
              ON CONFLICT(id) DO UPDATE SET
                last_seen=excluded.last_seen,
                authenticated_user=CASE
                  WHEN excluded.authenticated_user!='' THEN excluded.authenticated_user
                  ELSE app_visitors.authenticated_user
                END
            """, (digest_id, now, now, user_id))
        return True

    def app_stats(self):
        now = time.time()
        with self.lock:
            known = {r[0] for r in self.db.execute("SELECT id FROM app_users")}
            known.update(r[0] for r in self.db.execute("SELECT id FROM chats WHERE started=1"))
            authorized_week = self.db.execute("SELECT COUNT(*) FROM app_users WHERE last_seen>=?", (now-7*86400,)).fetchone()[0]
            authorized_month = self.db.execute("SELECT COUNT(*) FROM app_users WHERE last_seen>=?", (now-30*86400,)).fetchone()[0]
            anonymous = self.db.execute("SELECT COUNT(*) FROM app_visitors WHERE authenticated_user='' ").fetchone()[0]
            anonymous_week = self.db.execute("SELECT COUNT(*) FROM app_visitors WHERE authenticated_user='' AND last_seen>=?", (now-7*86400,)).fetchone()[0]
            anonymous_month = self.db.execute("SELECT COUNT(*) FROM app_visitors WHERE authenticated_user='' AND last_seen>=?", (now-30*86400,)).fetchone()[0]
            bot_users = self.db.execute("SELECT COUNT(*) FROM chats WHERE started=1").fetchone()[0]
            subscribers = self.db.execute("SELECT COUNT(*) FROM chats WHERE active=1 AND started=1").fetchone()[0]
            groups = self.db.execute("SELECT COUNT(DISTINCT group_name) FROM chats WHERE group_name!=''").fetchone()[0]
            deliveries = self.db.execute("""
              SELECT COUNT(*) FROM outbox o JOIN events e ON e.id=o.event_id
              WHERE o.state='sent' AND e.created>=?
            """, (now-30*86400,)).fetchone()[0]
            changes = self.db.execute("SELECT COUNT(*) FROM events WHERE id LIKE 'event:swap:%' AND created>=?", (now-30*86400,)).fetchone()[0]
            reports = self.db.execute("SELECT COUNT(*) FROM events WHERE id LIKE 'report:%:summary' AND created>=?", (now-30*86400,)).fetchone()[0]
        return {
            "ok": True,
            "generated_at": int(now * 1000),
            "users": {
                "total": len(known) + anonymous,
                "authorized": len(known),
                "anonymous": anonymous,
                "active_7d": authorized_week + anonymous_week,
                "active_30d": authorized_month + anonymous_month,
                "anonymous_active_7d": anonymous_week,
                "anonymous_active_30d": anonymous_month,
                "bot_started": bot_users,
            },
            "telegram": {"subscribers": subscribers, "groups": groups, "deliveries_30d": deliveries},
            "activity": {"change_events_30d": changes, "reports_30d": reports},
        }

    def close(self):
        self.db.close()


class TelegramError(Exception):
    def __init__(self, code, retry_after=5):
        self.code = code
        self.retry_after = min(max(int(retry_after), 1), 300)
        super().__init__(f"Telegram HTTP {code}")


class Telegram:
    def __init__(self, token):
        self.token = token

    def call(self, method, payload):
        req = Request("https://api.telegram.org/bot" + self.token + "/" + method,
                      data=json.dumps(payload, ensure_ascii=False).encode(),
                      headers={"Content-Type": "application/json", "User-Agent": "sched-bot/1"})
        try:
            with urlopen(req, timeout=25) as resp:
                data = json.load(resp)
        except HTTPError as e:
            retry = 5
            try:
                retry = json.loads(e.read(4096)).get("parameters", {}).get("retry_after", 5)
            except Exception:
                pass
            raise TelegramError(e.code, retry) from None
        except (URLError, TimeoutError, OSError):
            # Do not log request URLs: Telegram embeds the secret in them.
            raise TelegramError(503) from None
        if not data.get("ok"):
            raise TelegramError(data.get("error_code", 502), data.get("parameters", {}).get("retry_after", 5))
        return data.get("result")


    def send_document(self, chat_id, name, mime, content, caption=''):
        boundary = 'sched-' + os.urandom(16).hex()
        parts = []
        for field, value in {'chat_id':str(chat_id), 'caption':caption[:1000]}.items():
            parts.append(('--'+boundary+'\r\nContent-Disposition: form-data; name="'+field+'"\r\n\r\n'+value+'\r\n').encode())
        safe_name = re.sub(r'["\\\r\n]', '_', name)
        parts.append(('--'+boundary+'\r\nContent-Disposition: form-data; name="document"; filename="'+safe_name+'"\r\nContent-Type: '+mime+'\r\n\r\n').encode())
        parts.extend([content, ('\r\n--'+boundary+'--\r\n').encode()])
        request = Request('https://api.telegram.org/bot'+self.token+'/sendDocument', data=b''.join(parts),
                          headers={'Content-Type':'multipart/form-data; boundary='+boundary, 'User-Agent':'sched-bot/1.3'})
        try:
            with urlopen(request, timeout=60) as response:
                data = json.load(response)
        except HTTPError as error:
            retry = 5
            try: retry = json.loads(error.read(4096)).get('parameters',{}).get('retry_after',5)
            except Exception: pass
            raise TelegramError(error.code, retry) from None
        except (URLError, TimeoutError, OSError):
            raise TelegramError(503) from None
        if not data.get('ok'):
            raise TelegramError(data.get('error_code',502), data.get('parameters',{}).get('retry_after',5))
        return data.get('result')


class App:
    def __init__(self, cfg, store, telegram, auth):
        self.cfg, self.store, self.telegram, self.auth = cfg, store, telegram, auth
        self.reports = Reports(store, cfg.admins, cfg.report_quota_bytes)
        self.loop = None
        self.wakeup = None
        self.rate_lock = threading.Lock()
        self.rates = {}

    def wake(self):
        if self.loop and self.wakeup:
            self.loop.call_soon_threadsafe(self.wakeup.set)

    def limit(self, key, amount=120):
        minute = int(time.time() // 60)
        with self.rate_lock:
            if len(self.rates) > 5000:
                self.rates = {k: v for k, v in self.rates.items() if v[0] == minute}
            bucket, count = self.rates.get(key, (minute, 0))
            count = count + 1 if bucket == minute else 1
            self.rates[key] = (minute, count)
        return count <= amount

    def identity(self, headers):
        key = headers.get("X-Sched-Token", "")
        if key and hmac.compare_digest(key, self.cfg.secret):
            return "server"
        bearer = headers.get("Authorization", "")
        if bearer.startswith("Bearer ") and len(bearer) < 20000:
            session = self.auth.restore(bearer[7:])
            self.store.record_user(session.get("user"))
            return session["id"]
        return None

    def verify_client_auth(self, data, origin=""):
        if isinstance(data.get("session_token"), str):
            return self.auth.restore(data["session_token"])
        raise AuthError("bot_only", "начни вход через бота на сайте", 401)

    def notify(self, data, who):
        kind = data.get("type")
        if kind not in ("swap", "pending", "report", "schedule"):
            return 400, {"ok": False, "error": "Unknown event type"}
        if kind == "schedule" and who != "server":
            return 403, {"ok": False, "error": "Schedule events require server authentication"}
        if kind == "swap" and who != "server" and who not in self.cfg.admins:
            return 403, {"ok": False, "error": "Publisher is not an owner/editor in bot env"}
        if kind == "pending" and not who:
            return 401, {"ok": False, "error": "Telegram login required"}
        eid = data.get("event_id")
        text = data.get("text")
        group = data.get("group", "")
        message_format = data.get("format", "plain")
        if not isinstance(eid, str) or not 1 <= len(eid) <= 512 or not isinstance(text, str) or not text.strip() or len(text) > 3800 or not isinstance(group, str) or len(group) > 100 or message_format not in ("plain", "html"):
            return 400, {"ok": False, "error": "Invalid event"}
        # Private notifications NEVER accept client-selected recipients or fall back to public broadcast.
        if kind in ("pending", "report"):
            targets = self.cfg.admins if kind == "report" else self.cfg.admins.intersection(self.store.recipients("pending"))
            if not who:
                text = "[отчёт без подтверждённого входа]\n" + text
        else:
            targets = self.store.recipients(kind, group)
        payload = {"parse_mode": "HTML"} if message_format == "html" else None
        created, queued = self.store.enqueue("event:" + kind + ":" + eid, text, targets, payload=payload)
        self.wake()
        LOG.info("событие %s: %s; в очереди получателей %d", kind, "принято" if created else "дубликат", queued)
        return 202, {"ok": True, "accepted": created, "duplicate": not created, "queued": queued}

    def telegram_update(self, data):
        uid = data.get("update_id")
        if not isinstance(uid, int):
            return 400, {"ok": False, "error": "Invalid update"}
        message = data.get("message") or {}
        chat = message.get("chat") or {}
        text = message.get("text")
        cid = str(chat.get("id") or "")
        if chat.get("type") != "private" or not cid.isdigit() or not isinstance(text, str):
            return 200, {"ok": True}
        event = "telegram:" + str(uid)
        with self.store.lock:
            if self.store.db.execute("SELECT 1 FROM events WHERE id=?", (event,)).fetchone():
                return 200, {"ok": True}
            self.store.mark_started(cid)
            command = text.strip().split(maxsplit=1)[0].split("@")[0].lower()
            if command == "/stop":
                self.store.subscribe(cid, False, started=True)
                reply = "уведомления выключены — /start, чтобы включить снова"
            else:
                reply = GREETING
            self.store.enqueue(event, reply, [cid], payload={"parse_mode":"HTML"} if command != "/stop" else None)
        self.wake()
        return 200, {"ok": True}

    async def worker(self):
        self.loop = asyncio.get_running_loop()
        self.wakeup = asyncio.Event()
        self.wakeup.set()  # Resume already accepted deliveries after restart.
        while True:
            await self.wakeup.wait()
            self.wakeup.clear()
            while True:
                rows = self.store.pending()
                if not rows:
                    break
                for row in rows:
                    if not self.store.delivery_allowed(row):
                        self.store.mark(row, 'cancelled')
                        continue
                    try:
                        if row['method'] == 'sendDocument':
                            name, mime, content = self.reports.document(row['report_id'], row['part'])
                            await asyncio.to_thread(self.telegram.send_document, row['chat_id'], name, mime, content, row['text'])
                        else:
                            payload = json.loads(row['payload'] or '{}')
                            if row['method'] == 'sendMessage':
                                payload.update({'chat_id':row['chat_id'], 'text':row['text']})
                                if row['report_id']: payload['parse_mode'] = 'HTML'
                            await asyncio.to_thread(self.telegram.call, row['method'], payload)
                    except ReportError:
                        self.store.mark(row, 'cancelled')
                    except TelegramError as e:
                        if e.code in (400, 401, 403) or row["attempts"] >= 6:
                            self.store.mark(row, "failed")
                            if e.code == 403:
                                self.store.mark_started(row["chat_id"], False)
                            LOG.warning("сообщение не доставлено, telegram HTTP %s", e.code)
                        else:
                            self.store.mark(row, "pending")
                            await asyncio.sleep(e.retry_after)
                    else:
                        self.store.mark(row, "sent")
                    await asyncio.sleep(0.05)  # At most 20 outgoing requests/second.


REPORT_ROUTES = ("/reports", "/reports/list", "/reports/file", "/reports/delete")
STATS_ROUTES = ("/stats", "/stats/visit")
AUTH_ROUTES = ("/auth/start", "/auth/status", "/auth/cancel",
               "/auth/verify", "/auth/logout", "/auth/firebase")


def handler_for(app):
    class Handler(BaseHTTPRequestHandler):
        server_version = "sched"

        def setup(self):
            super().setup()
            self.connection.settimeout(15)

        def log_message(self, *_):
            pass

        def route(self):
            path = urlsplit(self.path).path.rstrip("/") or "/"
            base = app.cfg.base_path
            if base and (path == base or path.startswith(base + "/")):
                path = path[len(base):] or "/"
            return path

        def is_origin_allowed(self, origin):
            # No wildcard trust for other people's github.io/alwaysdata sites.
            return not origin or origin in app.cfg.origins

        def respond(self, status, obj):
            body = json.dumps(obj, ensure_ascii=False).encode()
            self.send_response(status)
            origin = self.headers.get("Origin", "")
            if origin and self.is_origin_allowed(origin):
                self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Vary", "Origin")
            if obj.get("retry_after"):
                self.send_header("Retry-After", str(obj["retry_after"]))
            self.send_header("Access-Control-Allow-Methods", "POST, GET, OPTIONS")
            self.send_header("Access-Control-Allow-Headers", "Content-Type, Authorization")
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.send_header("Referrer-Policy", "no-referrer")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            try:
                self.wfile.write(body)
            except (BrokenPipeError, ConnectionResetError):
                pass

        def respond_auth_page(self, query):
            try:
                result = app.auth.callback(query)
                ok, origin = True, result["origin"]
                title, message = "вход подтверждён", "можно вернуться в sched"
            except AuthError as error:
                ok, origin = False, ""
                title, message = "вход не выполнен", str(error)
            script = ""
            if ok:
                target = json.dumps(origin)
                script = ("<script>const o=" + target + ";"
                          "if(window.opener){window.opener.postMessage({type:'sched-oidc-complete'},o);setTimeout(()=>window.close(),250)}"
                          "else{setTimeout(()=>location.replace(o),800)}</script>")
            body = ("<!doctype html><html lang='ru'><meta charset='utf-8'>"
                    "<meta name='viewport' content='width=device-width,initial-scale=1'>"
                    "<title>" + escape(title) + "</title><style>html{color-scheme:light dark}body{font:16px system-ui;"
                    "display:grid;place-content:center;min-height:100vh;margin:0;text-align:center}main{padding:24px}"
                    "h1{font-size:22px}p{opacity:.7}</style><main><h1>" + escape(title) + "</h1><p>" + escape(message) + "</p></main>" + script)
            data = body.encode()
            self.send_response(200 if ok else 400)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'")
            self.send_header("Cache-Control", "no-store")
            self.send_header("Referrer-Policy", "no-referrer")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def do_GET(self):
            path = self.route()
            if path in ("/", "/health"):
                self.respond(200, {"ok": True, "app": "sched", "mode": "push", "auth_version": 4,
                    "build": "2026-09-08.7", "report_attachments": True,
                    "login_methods": ["oidc_authorization_code_pkce"]})
            elif path == "/auth/callback":
                query = {key: values[-1] for key, values in parse_qs(urlsplit(self.path).query, keep_blank_values=True).items()}
                self.respond_auth_page(query)
            else:
                self.respond(404, {"ok": False})

        def do_OPTIONS(self):
            origin = self.headers.get("Origin", "")
            if self.route() not in ("/notify", "/subscribe", "/subscription", *AUTH_ROUTES, *REPORT_ROUTES, *STATS_ROUTES):
                self.respond(404, {"ok": False})
                return
            if origin and not self.is_origin_allowed(origin):
                LOG.warning("CORS: origin %r не входит в SCHED_ALLOWED_ORIGINS — preflight отклонён", origin)
                self.respond(403, {"ok": False})
                return
            self.respond(200, {"ok": True})

        def do_POST(self):
            route = self.route()
            if route not in ("/notify", "/telegram", "/subscribe", "/subscription", *AUTH_ROUTES, *REPORT_ROUTES, *STATS_ROUTES):
                self.respond(404, {"ok": False})
                return
            if route == "/telegram":
                supplied = self.headers.get("X-Telegram-Bot-Api-Secret-Token", "")
                if not hmac.compare_digest(supplied, app.cfg.telegram_secret):
                    self.respond(403, {"ok": False})
                    return
            else:
                origin = self.headers.get("Origin")
                if origin and not self.is_origin_allowed(origin):
                    LOG.warning("CORS: origin %r не входит в SCHED_ALLOWED_ORIGINS — запрос отклонён", origin)
                    self.respond(403, {"ok": False, "error": "Origin not allowed"})
                    return
            try:
                size = int(self.headers.get("Content-Length", "0"))
                maximum = MAX_REPORT_BODY if route == "/reports" else MAX_BODY
                if not 0 < size <= maximum or self.headers.get("Transfer-Encoding"):
                    self.respond(413, {"ok": False, "error": "Invalid body length"})
                    return
                if route == '/reports' and not app.limit('report-upload:' + self.client_address[0], 6):
                    self.respond(429, {'ok':False, 'error':'слишком много отчётов. подожди минуту.', 'retry_after':60})
                    return
                data = json.loads(self.rfile.read(size))
                if not isinstance(data, dict):
                    raise ValueError()
            except (ValueError, UnicodeError, OSError):
                self.respond(400, {"ok": False, "error": "Invalid JSON"})
                return
            try:
                if route == "/telegram":
                    status, result = app.telegram_update(data)
                elif route in AUTH_ROUTES:
                    # Do not trust caller-supplied X-Forwarded-For for rate limits.
                    amount = 120 if route == "/auth/status" else 10 if route == "/auth/start" else 30
                    if not app.limit("auth:" + route + ":" + self.client_address[0], amount):
                        raise AuthError("rate_limited", "слишком много попыток. подождите минуту.", 429, 60)
                    origin = self.headers.get("Origin", "")
                    bearer = self.headers.get("Authorization", "")
                    token = bearer[7:] if bearer.startswith("Bearer ") else ""
                    if route == "/auth/start":
                        result = app.auth.start(data, origin)
                    elif route == "/auth/status":
                        result = app.auth.status(data, origin)
                    elif route == "/auth/cancel":
                        result = app.auth.cancel(data, origin)
                    elif route == "/auth/logout":
                        result = app.auth.logout(token)
                    elif route == "/auth/firebase":
                        result = app.auth.firebase_token(token)
                    else:
                        result = app.verify_client_auth(data, origin)
                    status = 200
                else:
                    who = app.identity(self.headers)
                    rate_key = who or self.client_address[0]
                    if not app.limit(rate_key, 120 if who else 10):
                        self.respond(429, {"ok": False, "error": "Too many requests"})
                        return
                    if route == "/stats/visit":
                        visitor_id = data.get("visitor_id")
                        if not app.limit("visit:" + self.client_address[0], 30):
                            status, result = 429, {"ok": False, "error": "Too many requests"}
                        else:
                            app.store.record_visitor(visitor_id, who if who not in (None, "server") else "")
                            status, result = 200, {"ok": True}
                    elif route == "/stats":
                        # The UI exposes this aggregate-only view to owners/editors.
                        # Any verified session may fetch it so Firebase-granted editors
                        # (not only env admins) work without trusting a client role flag.
                        if not who or who == "server":
                            status, result = 403, {"ok": False, "error": "нужен подтверждённый вход."}
                        else:
                            status, result = 200, app.store.app_stats()
                    elif route in REPORT_ROUTES:
                        if route == '/reports':
                            name = ''
                            if who and who != 'server':
                                bearer = self.headers.get('Authorization', '')
                                user = app.auth.restore(bearer[7:])['user']
                                name = ' '.join(filter(None, [user['first_name'],user['last_name']])) or user['username']
                            result = app.reports.submit(data, who if who != 'server' and who else '', name)
                            app.wake(); status = 202
                        elif who not in app.cfg.admins:
                            status, result = 403, {'ok':False, 'error':'отчёты доступны только владельцу и редакторам.'}
                        elif route == '/reports/list':
                            status, result = 200, app.reports.listing()
                        elif not isinstance(data.get('report_id'), str):
                            raise ReportError('некорректный номер отчёта.')
                        elif route == '/reports/file':
                            status, result = 200, app.reports.file_response(data['report_id'])
                        else:
                            status, result = 200, app.reports.delete(data['report_id'])
                    elif route == '/subscription':
                        if not who or who == 'server':
                            raise AuthError('login_required', 'войди через telegram.', 401)
                        status, result = 200, app.store.subscription(who)
                    elif route == "/subscribe":
                        if not who or who == "server":
                            self.respond(401, {"ok": False, "error": "Telegram login required"})
                            return
                        prefs = data.get("preferences", {})
                        group = data.get("group", "")
                        if not isinstance(prefs, dict) or set(prefs) != {"telegram","swaps","schedule","pending"} or any(type(v) is not bool for v in prefs.values()) or not isinstance(group, str) or len(group) > 100:
                            self.respond(400, {"ok": False, "error": "Invalid preferences"})
                            return
                        app.store.subscribe(who, prefs.get("telegram", False), prefs, group, started=None)
                        status, result = 200, app.store.subscription(who)
                    else:
                        status, result = app.notify(data, who)
            except ReportError as e:
                status, result = e.status, {"ok":False, "error":str(e), "code":"report_error"}
            except AuthError as e:
                status, result = e.status, {"ok": False, "code": e.code, "error": str(e)}
                if e.retry_after:
                    result["retry_after"] = e.retry_after
            except PermissionError as e:
                status, result = 401, {"ok": False, "error": str(e)}
            except ValueError:
                status, result = 400, {"ok": False, "error": "Invalid request"}
            except Exception:
                LOG.error("не удалось обработать событие; запрос можно повторить с тем же event_id")
                status, result = 500, {"ok": False, "error": "Internal error"}
            self.respond(status, result)
    return Handler


class ServerV6(ThreadingHTTPServer):
    address_family = socket.AF_INET6
    daemon_threads = True


def create_server(cfg, app):
    klass = ServerV6 if ":" in cfg.host else ThreadingHTTPServer
    server = klass((cfg.host, cfg.port), handler_for(app))
    server.daemon_threads = True
    return server


async def run(cfg, store, tg, auth):
    identity = await asyncio.to_thread(tg.call, "getMe", {})
    actual_name = str((identity or {}).get("username", ""))
    if not re.fullmatch(r"[A-Za-z0-9_]{5,32}", actual_name):
        raise ValueError("telegram не вернул username бота.")
    if cfg.bot_name and cfg.bot_name.lower() != actual_name.lower():
        raise ValueError("TELEGRAM_BOT_NAME не соответствует TELEGRAM_BOT_TOKEN.")
    cfg.bot_name = actual_name
    app = App(cfg, store, tg, auth)
    server = create_server(cfg, app)  # Fail immediately if binding IP/PORT fails.
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    stop = asyncio.Event()
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGINT, signal.SIGTERM):
        try:
            loop.add_signal_handler(sig, stop.set)
        except NotImplementedError:
            pass
    worker = asyncio.create_task(app.worker())
    try:
        await asyncio.to_thread(tg.call, "setWebhook", {
            "url": cfg.public_url + "/telegram",
            "secret_token": cfg.telegram_secret,
            "allowed_updates": ["message"],
            "drop_pending_updates": False,
        })
        LOG.info("sched запущен: HTTP [%s]:%s, telegram webhook включён; опросов firebase нет", cfg.host, server.server_port)
        LOG.info("SCHED_ALLOWED_ORIGINS: %s", ", ".join(sorted(cfg.origins)))
        await stop.wait()
    finally:
        worker.cancel()
        await asyncio.gather(worker, return_exceptions=True)
        await asyncio.to_thread(server.shutdown)
        server.server_close()


def main():
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    parser = argparse.ArgumentParser(description="sched push bot; all settings in environment")
    parser.add_argument("--check-config", action="store_true", help="Validate environment without network requests")
    parser.add_argument("--test", action="store_true", help="Send a test ONLY to TELEGRAM_OWNER_ID")
    args = parser.parse_args()
    try:
        cfg = Config()
        cfg.validate()
        if args.check_config:
            LOG.info("конфигурация корректна. секреты не выводятся.")
            return 0
        tg = Telegram(cfg.token)
        if args.test:
            tg.call("sendMessage", {"chat_id": cfg.owner, "text": "sched: тестовое сообщение. канал telegram доступен."})
            LOG.info("тест отправлен владельцу.")
            return 0
        store = Store(cfg.data_dir / "sched.sqlite3")
        try:
            auth = Auth(cfg, store)
            asyncio.run(run(cfg, store, tg, auth))
        finally:
            store.close()
        return 0
    except ImportError:
        LOG.error("установи зависимости: python3 -m pip install -r bot/requirements.txt")
    except ValueError as e:
        LOG.error("%s", e)
    except TelegramError as e:
        LOG.error("telegram HTTP %s. проверь токен, HTTPS BOT_PUBLIC_URL и доступность /health.", e.code)
    except OSError:
        LOG.error("не удалось открыть IP/PORT или файл данных. проверь env, права и второй экземпляр процесса.")
    return 1


if __name__ == "__main__":
    sys.exit(main())
