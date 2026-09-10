"""Telegram OpenID Connect Authorization Code flow with PKCE.

The browser never receives the Telegram client secret, PKCE verifier, access
token, or an unverified identity. It only receives a signed sched session after
Telegram redirects an authorization code to this server and the ID token passes
signature and claim validation.
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import json
import re
import secrets
import time
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode, urlsplit
from urllib.request import Request, urlopen

SESSION_TTL = 30 * 86400
ATTEMPT_TTL = 300
OIDC_ISSUER = "https://oauth.telegram.org"
OIDC_AUTH_URL = OIDC_ISSUER + "/auth"
OIDC_TOKEN_URL = OIDC_ISSUER + "/token"
OIDC_JWKS_URL = OIDC_ISSUER + "/.well-known/jwks.json"


class AuthError(Exception):
    def __init__(self, code, message, status=400, retry_after=None):
        self.code, self.status, self.retry_after = code, status, retry_after
        super().__init__(message)


def digest(value):
    return hashlib.sha256(str(value).encode("utf-8", errors="replace")).hexdigest()


def valid_id(value):
    return bool(re.fullmatch(r"[1-9][0-9]{0,19}", str(value)))


def b64url(value):
    return base64.urlsafe_b64encode(value).decode().rstrip("=")


class Auth:
    def __init__(self, cfg, store):
        self.cfg, self.store = cfg, store
        self.session_key = hashlib.sha256((cfg.secret + ":sched-auth").encode()).digest()
        try:
            import jwt
            self.jwt = jwt
            self.keys = jwt.PyJWKClient(OIDC_JWKS_URL, cache_keys=True, lifespan=300, timeout=8)
        except ImportError:
            self.jwt = self.keys = None
        with self.store.lock, self.store.db:
            self.store.db.executescript("""
                CREATE TABLE IF NOT EXISTS auth_revoked (
                    token_hash TEXT PRIMARY KEY, expires REAL NOT NULL
                );
                CREATE TABLE IF NOT EXISTS auth_attempts (
                    id TEXT PRIMARY KEY, secret_hash TEXT NOT NULL,
                    origin TEXT NOT NULL, method TEXT NOT NULL, nonce TEXT NOT NULL,
                    expires REAL NOT NULL, state TEXT NOT NULL DEFAULT 'pending',
                    user_json TEXT, code_hash TEXT, tries INTEGER NOT NULL DEFAULT 0,
                    result_token TEXT, completed_at REAL
                );
            """)
            columns = {r["name"] for r in self.store.db.execute("PRAGMA table_info(auth_attempts)")}
            if "confirmation" not in columns:
                self.store.db.execute("ALTER TABLE auth_attempts ADD COLUMN confirmation TEXT NOT NULL DEFAULT 'oidc'")
            if "context_json" not in columns:
                self.store.db.execute("ALTER TABLE auth_attempts ADD COLUMN context_json TEXT NOT NULL DEFAULT '{}'")

    def role(self, uid):
        return "owner" if uid == self.cfg.owner else "editor" if uid in self.cfg.admins else "user"

    def user(self, info):
        uid = str(info.get("id") or info.get("sub") or "")
        if not valid_id(uid):
            raise AuthError("invalid_user", "телеграм вернул некорректный идентификатор", 401)
        photo = str(info.get("picture") or info.get("photo_url") or "")[:2048]
        try:
            parsed = urlsplit(photo)
            if photo and (parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password):
                photo = ""
        except ValueError:
            photo = ""
        name = str(info.get("name") or "")[:240].strip()
        first = str(info.get("given_name") or info.get("first_name") or "")[:120].strip()
        last = str(info.get("family_name") or info.get("last_name") or "")[:120].strip()
        if not first and name:
            first, _, inferred_last = name.partition(" ")
            if not last:
                last = inferred_last
        return {
            "id": uid,
            "first_name": first,
            "last_name": last,
            "username": str(info.get("preferred_username") or info.get("username") or "")[:80],
            "photo_url": photo,
        }

    def create_session(self, user_info):
        user = self.user(user_info)
        data = {**user, "ts": int(time.time()), "jti": secrets.token_urlsafe(18)}
        raw = b64url(json.dumps(data, separators=(",", ":"), ensure_ascii=False).encode())
        signature = hmac.new(self.session_key, raw.encode(), hashlib.sha256).hexdigest()
        return self.restore("sess_" + raw + "." + signature)

    def restore(self, token):
        if not isinstance(token, str) or len(token) > 16000 or not token.startswith("sess_") or "." not in token:
            raise AuthError("invalid_session", "войди через телеграм заново", 401)
        raw, signature = token[5:].rsplit(".", 1)
        if not re.fullmatch(r"[A-Za-z0-9_-]+", raw) or not re.fullmatch(r"[a-f0-9]{64}", signature):
            raise AuthError("invalid_session", "некорректный формат сессии", 401)
        expected = hmac.new(self.session_key, raw.encode(), hashlib.sha256).hexdigest()
        if not hmac.compare_digest(signature, expected):
            raise AuthError("invalid_session", "подпись сессии недействительна", 401)
        try:
            data = json.loads(base64.urlsafe_b64decode(raw + "=" * (-len(raw) % 4)))
            issued = float(data["ts"])
            if not isinstance(data, dict) or not issued <= time.time() + 30 or not issued > time.time() - SESSION_TTL:
                raise AuthError("session_expired", "сессия истекла. войди заново", 401)
            user = self.user(data)
        except AuthError:
            raise
        except (ValueError, TypeError, KeyError, UnicodeError):
            raise AuthError("invalid_session", "повреждённая сессия", 401) from None
        with self.store.lock:
            revoked = self.store.db.execute("SELECT 1 FROM auth_revoked WHERE token_hash=?", (digest(token),)).fetchone()
        if revoked:
            raise AuthError("session_revoked", "сессия завершена. войди заново", 401)
        return {
            "ok": True, **user, "user": user, "role": self.role(user["id"]),
            "session_token": token, "auth_date": int(issued), "expires_at": int(issued + SESSION_TTL),
            "firebase_enabled": bool(self.cfg.firebase_credentials and self.jwt),
        }

    def verify(self, token):
        return self.restore(token)["id"]

    def logout(self, token):
        if token:
            try:
                session = self.restore(token)
            except AuthError as error:
                if error.status != 401:
                    raise
            else:
                with self.store.lock, self.store.db:
                    self.store.db.execute("INSERT OR REPLACE INTO auth_revoked VALUES (?,?)", (digest(token), session["expires_at"]))
        return {"ok": True}

    def start(self, data, origin, context=None):
        if origin not in self.cfg.origins:
            raise AuthError("invalid_origin", "открой разрешённый адрес сайта", 403)
        if not self.jwt or not self.keys:
            raise AuthError("auth_unavailable", "на сервере не установлена поддержка oidc", 503)
        attempt_id, browser_secret, nonce = (secrets.token_urlsafe(24) for _ in range(3))
        verifier = secrets.token_urlsafe(48)
        challenge = b64url(hashlib.sha256(verifier.encode()).digest())
        expires = time.time() + ATTEMPT_TTL
        private_context = {"code_verifier": verifier, "browser": (context or {}).get("browser", "")}
        with self.store.lock, self.store.db:
            self.store.db.execute("DELETE FROM auth_attempts WHERE expires < ?", (time.time(),))
            self.store.db.execute("DELETE FROM auth_revoked WHERE expires < ?", (time.time(),))
            self.store.db.execute(
                "INSERT INTO auth_attempts(id,secret_hash,origin,method,nonce,expires,confirmation,context_json) VALUES (?,?,?,'oidc',?,?,'pkce',?)",
                (attempt_id, digest(browser_secret), origin, nonce, expires, json.dumps(private_context)),
            )
        query = urlencode({
            "client_id": self.cfg.telegram_client_id,
            "redirect_uri": self.cfg.telegram_redirect_uri,
            "response_type": "code",
            "scope": "openid profile",
            "state": attempt_id,
            "nonce": nonce,
            "code_challenge": challenge,
            "code_challenge_method": "S256",
        })
        return {
            "ok": True, "attempt_id": attempt_id, "attempt_secret": browser_secret,
            "expires_at": int(expires), "method": "oidc_pkce", "auth_url": OIDC_AUTH_URL + "?" + query,
        }

    def attempt(self, data, origin):
        if not isinstance(data.get("attempt_id"), str) or not isinstance(data.get("attempt_secret"), str):
            raise AuthError("invalid_attempt", "начни вход заново", 401)
        row = self.store.db.execute("SELECT * FROM auth_attempts WHERE id=?", (data["attempt_id"],)).fetchone()
        if not row or row["method"] != "oidc" or not hmac.compare_digest(row["secret_hash"], digest(data["attempt_secret"])) or row["origin"] != origin:
            raise AuthError("invalid_attempt", "эта попытка входа не принадлежит вкладке", 401)
        if row["expires"] < time.time() or row["state"] == "cancelled":
            raise AuthError("attempt_expired", "время входа истекло. начни заново", 401)
        return row

    def status(self, data, origin):
        with self.store.lock:
            row = self.attempt(data, origin)
            if row["state"] in ("approved", "complete"):
                return self.finish(row, json.loads(row["user_json"]) if row["user_json"] else {})
            return {"ok": True, "state": row["state"], "expires_at": int(row["expires"])}

    def cancel(self, data, origin):
        with self.store.lock, self.store.db:
            row = self.attempt(data, origin)
            if row["result_token"]:
                self.logout(row["result_token"])
            self.store.db.execute("UPDATE auth_attempts SET state='cancelled',user_json=NULL,result_token=NULL,context_json='{}' WHERE id=?", (row["id"],))
        return {"ok": True}

    def finish(self, row, user):
        if row["state"] == "complete":
            if row["completed_at"] and time.time() - row["completed_at"] <= 60:
                return self.restore(row["result_token"])
            raise AuthError("attempt_used", "эта попытка входа уже использована", 401)
        result = self.create_session(user)
        self.store.db.execute(
            "UPDATE auth_attempts SET state='complete',result_token=?,completed_at=?,user_json=NULL,context_json='{}' WHERE id=?",
            (result["session_token"], time.time(), row["id"]),
        )
        self.store.db.commit()
        return result

    def callback(self, query):
        state = str(query.get("state") or "")
        if not re.fullmatch(r"[A-Za-z0-9_-]{32}", state):
            raise AuthError("invalid_state", "не удалось проверить состояние входа", 400)
        with self.store.lock:
            row = self.store.db.execute("SELECT * FROM auth_attempts WHERE id=?", (state,)).fetchone()
            if not row or row["method"] != "oidc" or row["expires"] < time.time() or row["state"] == "cancelled":
                raise AuthError("attempt_expired", "запрос входа устарел", 410)
            origin = row["origin"]
            if row["state"] in ("approved", "complete"):
                return {"ok": True, "origin": origin}
            nonce = row["nonce"]
            try:
                verifier = json.loads(row["context_json"])["code_verifier"]
            except (ValueError, KeyError, TypeError):
                raise AuthError("invalid_attempt", "данные pkce повреждены", 500) from None
        if query.get("error"):
            with self.store.lock, self.store.db:
                self.store.db.execute("UPDATE auth_attempts SET state='cancelled',context_json='{}' WHERE id=?", (state,))
            raise AuthError("telegram_denied", "вход отменён в телеграм", 401)
        code = query.get("code")
        if not isinstance(code, str) or not 1 <= len(code) <= 4096:
            raise AuthError("missing_code", "телеграм не вернул код авторизации", 400)
        token_data = self.exchange_code(code, verifier)
        user = self.validate_id_token(token_data.get("id_token"), nonce)
        with self.store.lock, self.store.db:
            fresh = self.store.db.execute("SELECT * FROM auth_attempts WHERE id=?", (state,)).fetchone()
            if not fresh or fresh["expires"] < time.time() or fresh["state"] == "cancelled":
                raise AuthError("attempt_expired", "запрос входа устарел", 410)
            if fresh["state"] == "pending":
                self.store.db.execute("UPDATE auth_attempts SET state='approved',user_json=?,context_json='{}' WHERE id=?", (json.dumps(user), state))
        return {"ok": True, "origin": origin}

    def exchange_code(self, code, verifier):
        credentials = base64.b64encode((self.cfg.telegram_client_id + ":" + self.cfg.telegram_client_secret).encode()).decode()
        body = urlencode({
            "grant_type": "authorization_code", "code": code,
            "redirect_uri": self.cfg.telegram_redirect_uri,
            "client_id": self.cfg.telegram_client_id,
            "code_verifier": verifier,
        }).encode()
        request = Request(OIDC_TOKEN_URL, data=body, headers={
            "Authorization": "Basic " + credentials,
            "Content-Type": "application/x-www-form-urlencoded",
            "Accept": "application/json",
            "User-Agent": "sched/1.4",
        })
        try:
            with urlopen(request, timeout=10) as response:
                raw = response.read(1024 * 1024 + 1)
            if len(raw) > 1024 * 1024:
                raise ValueError()
            result = json.loads(raw)
        except HTTPError as error:
            if error.code in (400, 401):
                raise AuthError("token_exchange_rejected", "телеграм отклонил код или настройки клиента", 401) from None
            raise AuthError("telegram_unavailable", "телеграм временно недоступен", 503) from None
        except (URLError, TimeoutError, OSError, ValueError, json.JSONDecodeError):
            raise AuthError("telegram_unavailable", "не удалось получить ответ от телеграм", 503) from None
        if not isinstance(result, dict) or not isinstance(result.get("id_token"), str):
            raise AuthError("invalid_token_response", "телеграм не вернул id token", 502)
        return result

    def validate_id_token(self, token, nonce):
        if not self.jwt or not self.keys or not isinstance(token, str) or not 1 < len(token) < 16000:
            raise AuthError("invalid_id_token", "не удалось проверить id token", 401)
        try:
            header = self.jwt.get_unverified_header(token)
            if header.get("alg") != self.cfg.telegram_oidc_algorithm or not isinstance(header.get("kid"), str):
                raise ValueError()
            key = self.keys.get_signing_key_from_jwt(token)
            claims = self.jwt.decode(
                token, key.key, algorithms=[self.cfg.telegram_oidc_algorithm],
                audience=self.cfg.telegram_client_id, issuer=OIDC_ISSUER, leeway=30,
                options={"require": ["exp", "iat", "iss", "aud", "sub", "nonce"]},
            )
            if not isinstance(claims.get("nonce"), str) or not hmac.compare_digest(claims["nonce"], nonce):
                raise ValueError()
            return self.user(claims)
        except self.jwt.PyJWKClientConnectionError:
            raise AuthError("telegram_keys_unavailable", "не удалось получить ключи подписи телеграм", 503) from None
        except (self.jwt.PyJWTError, ValueError, TypeError):
            raise AuthError("invalid_id_token", "подпись или параметры id token не подтверждены", 401) from None

    def firebase_token(self, token):
        session = self.restore(token)
        credentials = self.cfg.firebase_credentials
        if not credentials or not self.jwt:
            raise AuthError("firebase_not_configured", "на сервере не настроен ключ firebase", 503)
        now = int(time.time())
        claims = {
            "iss": credentials["client_email"], "sub": credentials["client_email"],
            "aud": "https://identitytoolkit.googleapis.com/google.identity.identitytoolkit.v1.IdentityToolkit",
            "iat": now, "exp": now + 3600, "uid": "telegram:" + session["id"],
            "claims": {"tg_id": session["id"], "sched_role": session["role"]},
        }
        try:
            custom_token = self.jwt.encode(claims, credentials["private_key"], algorithm="RS256")
        except Exception:
            raise AuthError("firebase_key_invalid", "не удалось подписать firebase-токен", 503) from None
        return {"ok": True, "custom_token": custom_token}
