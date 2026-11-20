"""Ops request signatures: Ed25519, verified with PUBLIC keys only (the NAS holds no Files secret).

Keys come from OPS_FILES_SIGNING_PUBLIC_KEYS in the shared nas-link.env, as comma-separated
`scope:keyId:base64url(32-byte raw key)` entries. Scopes are `files-read` and `files-write`; each scope holds one key,
or two during a rotation overlap. A key is accepted only for its own scope.

Wire format: `X-Ltfiles-Envelope: base64url(envelope JSON bytes)` and `X-Ltfiles-Signature: base64url(64 bytes)`.
The signature covers b"ltfiles-v2\\n" + the exact envelope bytes, so no canonicalization is needed; the JSON must
still have unique keys and no floats.
"""
from __future__ import annotations

import json
import re
import time

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey

from ..errors import Denied
from .access import b64url

SCOPES = ("files-read", "files-write")
CONTEXT = b"ltfiles-v2\n"
MAX_ENVELOPE = 8192
MAX_LIFETIME = 30
SKEW = 30
_KEY_ID = re.compile(r"[A-Za-z0-9_-]{1,64}\Z")


def parse_public_keys(value: str | None) -> dict[str, dict[str, Ed25519PublicKey]]:
    if not isinstance(value, str) or not value.strip():
        raise ValueError("OPS_FILES_SIGNING_PUBLIC_KEYS is required")
    keys: dict[str, dict[str, Ed25519PublicKey]] = {scope: {} for scope in SCOPES}
    seen_ids = set()
    for entry in value.split(","):
        fields = entry.strip().split(":")
        if len(fields) != 3 or fields[0] not in SCOPES or not _KEY_ID.match(fields[1]) or fields[1] in seen_ids:
            raise ValueError("Invalid OPS_FILES_SIGNING_PUBLIC_KEYS entry")
        raw = b64url(fields[2])
        if len(raw) != 32:
            raise ValueError("Ed25519 public keys are 32 bytes")
        keys[fields[0]][fields[1]] = Ed25519PublicKey.from_public_bytes(raw)
        seen_ids.add(fields[1])
    if any(len(scoped) > 2 for scoped in keys.values()):
        raise ValueError("At most two keys per scope (rotation overlap)")
    if not keys["files-write"]:
        raise ValueError("A files-write key is required")
    return keys


def _unique(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("duplicate key")
        result[key] = value
    return result


def _no_float(_):
    raise ValueError("float")


def verify_envelope(envelope_header: str | None, signature_header: str | None, scope: str,
                    keys: dict[str, dict[str, Ed25519PublicKey]], clock=time.time) -> dict:
    """Verifies the signature for exactly `scope` and the time window; returns the parsed envelope."""
    if scope not in SCOPES or not isinstance(envelope_header, str) or not isinstance(signature_header, str) \
            or len(envelope_header) > MAX_ENVELOPE * 2 or len(signature_header) > 128:
        raise Denied("unauthorized", 401)
    try:
        raw, signature = b64url(envelope_header), b64url(signature_header)
        if len(raw) > MAX_ENVELOPE or len(signature) != 64:
            raise ValueError("size")
        envelope = json.loads(raw.decode("utf-8", errors="strict"), object_pairs_hook=_unique,
                              parse_float=_no_float, parse_constant=_no_float)
    except (ValueError, UnicodeError, RecursionError):
        raise Denied("unauthorized", 401) from None
    if not isinstance(envelope, dict) or envelope.get("scope") != scope:
        raise Denied("unauthorized", 401)
    key = keys.get(scope, {}).get(envelope.get("keyId")) if isinstance(envelope.get("keyId"), str) else None
    if key is None:
        raise Denied("unauthorized", 401)
    try:
        key.verify(signature, CONTEXT + raw)
    except InvalidSignature:
        raise Denied("unauthorized", 401) from None
    now = int(clock())
    issued, expires = envelope.get("issuedAt"), envelope.get("expiresAt")
    if type(issued) is not int or type(expires) is not int or abs(now - issued) > SKEW \
            or not issued < expires <= issued + MAX_LIFETIME or now >= expires:
        raise Denied("expired", 401)
    return envelope
