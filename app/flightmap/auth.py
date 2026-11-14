"""The optional login: password hashing, signed session cookies, and the
lock-out after too many wrong passwords.

Only used when AUTH_USER and AUTH_PASSWORD_HASH are set (deploy/set-login.sh).
"""
import hashlib
import hmac
import os
import secrets
import threading
import time
from http.cookies import SimpleCookie

from .config import AUTH_PASSWORD_HASH, AUTH_USER, SECRET_FILE, log
from .settings import current_settings

# Passwords are stored as a PBKDF2 hash: a one-way scramble that is slow to
# guess. Format:  pbkdf2_sha256:<rounds>:<salt hex>:<hash hex>
# (no "$" characters, so it is safe inside a systemd EnvironmentFile).
COOKIE_NAME = "flightmap_session"
PUBLIC_PATHS = {"/login", "/login.html", "/api/login", "/api/health", "/favicon.ico"}
FAILED_LOGINS = {}            # ip address -> list of times of failed logins
FAILED_LOCK = threading.Lock()
MAX_FAILURES = 10             # this many wrong passwords ...
FAILURE_WINDOW = 15 * 60      # ... within 15 minutes locks that address out


def hash_password(password, rounds=600_000):
    salt = secrets.token_bytes(16)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, rounds)
    return f"pbkdf2_sha256:{rounds}:{salt.hex()}:{digest.hex()}"


def verify_password(password, stored):
    try:
        algorithm, rounds, salt_hex, digest_hex = stored.split(":")
        if algorithm != "pbkdf2_sha256":
            return False
        digest = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"),
                                     bytes.fromhex(salt_hex), int(rounds))
    except ValueError:
        return False
    return hmac.compare_digest(digest.hex(), digest_hex)


def load_session_secret():
    """A random key used to sign login cookies, kept so restarts don't log you out."""
    try:
        with open(SECRET_FILE, "rb") as fh:
            secret = fh.read()
        if len(secret) >= 32:
            return secret
    except OSError:
        pass
    secret = secrets.token_bytes(32)
    try:
        os.makedirs(os.path.dirname(SECRET_FILE), exist_ok=True)
        fd = os.open(SECRET_FILE, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "wb") as fh:
            fh.write(secret)
    except OSError as exc:
        log(f"Could not save {SECRET_FILE} ({exc}); logins will end when the server restarts")
    return secret


SESSION_SECRET = b""


def start():
    """Load (or create) the key that signs login cookies. Called once at start-up."""
    global SESSION_SECRET
    SESSION_SECRET = load_session_secret()


def _sign(text):
    # The password hash is part of the signature, so changing the password
    # signs everyone out.
    key = SESSION_SECRET + AUTH_PASSWORD_HASH.encode("utf-8")
    return hmac.new(key, text.encode("utf-8"), hashlib.sha256).hexdigest()


def session_days():
    return current_settings()["sessionDays"]


def make_session_cookie():
    expires = int(time.time()) + session_days() * 86400
    body = f"{AUTH_USER}:{expires}"
    return f"{body}:{_sign(body)}"


def session_is_valid(cookie_header):
    if not cookie_header:
        return False
    try:
        cookie = SimpleCookie(cookie_header)
    except Exception:
        return False
    morsel = cookie.get(COOKIE_NAME)
    if not morsel:
        return False
    parts = morsel.value.rsplit(":", 2)
    if len(parts) != 3:
        return False
    user, expires, signature = parts
    if not hmac.compare_digest(_sign(f"{user}:{expires}"), signature):
        return False
    return user == AUTH_USER and expires.isdigit() and int(expires) > time.time()


def too_many_failures(ip):
    now = time.time()
    with FAILED_LOCK:
        recent = [t for t in FAILED_LOGINS.get(ip, []) if now - t < FAILURE_WINDOW]
        FAILED_LOGINS[ip] = recent
        return len(recent) >= MAX_FAILURES


def record_failure(ip):
    with FAILED_LOCK:
        FAILED_LOGINS.setdefault(ip, []).append(time.time())
