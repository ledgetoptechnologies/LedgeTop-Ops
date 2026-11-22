"""Origin check of the NAS link: a Cloudflare Access service-token assertion (RS256).

Same claim shape as the reviewed logs-local verifier (apps/logs-local/src/access-jwt.mjs): type 'app', sub present
and empty, no email, common_name exactly the NAS link client id, one pinned audience, the fixed team issuer.
Verification uses pyca `cryptography`; there is no algorithm negotiation. Every failure is one opaque denial.
"""
from __future__ import annotations

import base64
import json
import re
import ssl
import threading
import time
import urllib.request
from typing import Callable

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.asymmetric import padding, rsa

from ..errors import Denied

DEFAULT_ISSUER = "https://ledgetoptechnologies.cloudflareaccess.com"
MAX_ASSERTION = 16384
MAX_JWKS_BYTES = 64 * 1024
MAX_EXP = 253402300799
_ISSUER = re.compile(r"https://[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.cloudflareaccess\.com\Z")
_AUDIENCE = re.compile(r"[A-Za-z0-9_-]{16,128}\Z")
_CLIENT_ID = re.compile(r"[A-Za-z0-9._-]{1,256}\Z")
_B64URL = re.compile(r"[A-Za-z0-9_-]+\Z")


def _deny() -> Denied:
    return Denied("not-found", 404)


def b64url(value: str) -> bytes:
    if not _B64URL.match(value):
        raise ValueError("base64url")
    return base64.urlsafe_b64decode(value + "=" * (-len(value) % 4))


def canonical_issuer(issuer: str) -> str:
    if not isinstance(issuer, str) or not _ISSUER.match(issuer):
        raise ValueError("Access issuer must be https://<team>.cloudflareaccess.com")
    return issuer


def _unique(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("duplicate key")
        result[key] = value
    return result


def _json(raw: bytes):
    return json.loads(raw.decode("utf-8", errors="strict"), object_pairs_hook=_unique)


def _default_fetch(url: str, timeout: float) -> bytes:
    context = ssl.create_default_context()  # system CAs, hostname verification on

    class NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, *args, **kwargs):
            return None

    opener = urllib.request.build_opener(urllib.request.HTTPSHandler(context=context), NoRedirect())
    with opener.open(urllib.request.Request(url, headers={"Accept": "application/json"}), timeout=timeout) as response:
        if response.status != 200:
            raise OSError("jwks unavailable")
        body = response.read(MAX_JWKS_BYTES + 1)
        if len(body) > MAX_JWKS_BYTES:
            raise OSError("jwks too large")
        return body


class AccessKeys:
    """Signing keys of the one pinned issuer, fetched only from <issuer>/cdn-cgi/access/certs over verified TLS.

    An unknown kid triggers at most one refresh per `cooldown` seconds; keys are refreshed every `refresh` seconds;
    with no successful refresh for `max_age` seconds every key is refused (fail closed).
    """

    def __init__(self, issuer: str, *, fetch: Callable[[str, float], bytes] = _default_fetch, clock=time.time,
                 cooldown=300, refresh=12 * 3600, max_age=7 * 86400, timeout=5.0):
        self.url = canonical_issuer(issuer) + "/cdn-cgi/access/certs"
        self.fetch, self.clock, self.cooldown, self.refresh_after, self.max_age, self.timeout = \
            fetch, clock, cooldown, refresh, max_age, timeout
        self.keys: dict[str, rsa.RSAPublicKey] = {}
        self.fetched_at = float("-inf")
        self.attempted_at = float("-inf")
        self.lock = threading.Lock()

    def fresh(self) -> bool:
        return self.clock() - self.fetched_at < self.max_age

    def _refresh(self) -> None:
        self.attempted_at = self.clock()
        body = _json(self.fetch(self.url, self.timeout))
        keys = {}
        for jwk in body.get("keys", []) if isinstance(body, dict) else []:
            if not isinstance(jwk, dict) or jwk.get("kty") != "RSA" or not isinstance(jwk.get("kid"), str) \
                    or jwk.get("alg", "RS256") != "RS256" or jwk.get("use", "sig") != "sig":
                continue
            try:
                n = int.from_bytes(b64url(jwk["n"]), "big")
                e = int.from_bytes(b64url(jwk["e"]), "big")
                key = rsa.RSAPublicNumbers(e, n).public_key()
            except (KeyError, TypeError, ValueError):
                continue
            if key.key_size >= 2048:
                keys[jwk["kid"]] = key
        if not keys:
            raise OSError("jwks empty")
        self.keys, self.fetched_at = keys, self.clock()

    def ready(self) -> bool:
        with self.lock:
            if not self.fresh() and self.clock() - self.attempted_at >= self.cooldown:
                try:
                    self._refresh()
                except (OSError, ValueError):
                    pass
            return self.fresh()

    def get(self, kid: str) -> rsa.RSAPublicKey:
        with self.lock:
            now = self.clock()
            stale = now - self.fetched_at >= self.refresh_after
            if (stale or kid not in self.keys) and now - self.attempted_at >= self.cooldown:
                try:
                    self._refresh()
                except (OSError, ValueError):
                    pass  # known, still-fresh keys only
            if self.fresh() and kid in self.keys:
                return self.keys[kid]
            raise _deny()


def verify_service_assertion(assertion: str | None, *, issuer: str, audience: str, client_id: str, keys: AccessKeys,
                             clock=time.time) -> int:
    """Returns the assertion expiry (Unix seconds) for the exact NAS link service token, else raises 404."""
    if not _AUDIENCE.match(audience or "") or not _CLIENT_ID.match(client_id or ""):
        raise Denied("not-configured", 503)
    if not isinstance(assertion, str) or not assertion or len(assertion) > MAX_ASSERTION:
        raise _deny()
    parts = assertion.split(".")
    if len(parts) != 3:
        raise _deny()
    try:
        header, payload, signature = _json(b64url(parts[0])), _json(b64url(parts[1])), b64url(parts[2])
    except (ValueError, UnicodeError):
        raise _deny() from None
    if not isinstance(header, dict) or header.get("alg") != "RS256" or not isinstance(header.get("kid"), str) \
            or "crit" in header:
        raise _deny()
    key = keys.get(header["kid"])
    try:
        key.verify(signature, f"{parts[0]}.{parts[1]}".encode("ascii"), padding.PKCS1v15(), hashes.SHA256())
    except InvalidSignature:
        raise _deny() from None
    seconds = int(clock())
    audiences = [payload.get("aud")] if isinstance(payload, dict) and isinstance(payload.get("aud"), str) \
        else (payload.get("aud") if isinstance(payload, dict) else None)

    def safe_int(value):
        return type(value) is int and 0 <= value <= MAX_EXP

    if not isinstance(payload, dict) or payload.get("iss") != canonical_issuer(issuer) \
            or not isinstance(audiences, list) or audiences != [audience] \
            or payload.get("type") != "app" or payload.get("sub") != "" or "email" in payload \
            or payload.get("common_name") != client_id \
            or not safe_int(payload.get("iat")) or not safe_int(payload.get("exp")) \
            or payload["iat"] > seconds or payload["exp"] <= seconds or payload["iat"] >= payload["exp"] \
            or ("nbf" in payload and not (safe_int(payload["nbf"]) and payload["nbf"] <= seconds)):
        raise _deny()
    return payload["exp"]
