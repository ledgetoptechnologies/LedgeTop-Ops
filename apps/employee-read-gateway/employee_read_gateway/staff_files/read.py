"""Read cutover (slice 2c): the v1 read protocol, authenticated by the Ops files-read Ed25519 key instead of HMAC.

Same body, operations and responses as v1 (core.Gateway). Only the signature differs, and only one scheme is accepted
here: this container never accepts an HMAC read signature, and a files-write key never authorizes a read.

Signed bytes (exact, LF-joined): "ltfiles-v1read", gatewayId, keyId, timestamp, nonce, "POST", "/v1/read", sha256(body).
Headers: X-Ltfiles-Read-Key-Id, X-Ltfiles-Read-Time, X-Ltfiles-Read-Nonce, X-Ltfiles-Read-Signature (base64url, 64 bytes).
"""
from __future__ import annotations

import hashlib

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey

from ..core import Gateway
from ..errors import Denied
from .access import b64url


class Ed25519ReadGateway(Gateway):
    def __init__(self, gateway_id, roots, read_keys: dict[str, Ed25519PublicKey], replay, spool, **limits):
        if not read_keys or len(read_keys) > 2:
            raise ValueError("One or two files-read keys are required")
        self.read_keys = dict(read_keys)
        # The parent requires a non-empty key map; it holds only the raw public keys, never used for HMAC here.
        raw = {key_id: key.public_bytes_raw() for key_id, key in read_keys.items()}
        super().__init__(gateway_id, roots, raw, replay, spool, **limits)

    def verify_signature(self, headers, body):
        if any(headers.get(name) is not None for name in ("X-Ops-Read-Key-Id", "X-Ops-Read-Signature")):
            raise Denied("unauthorized", 401)  # one scheme per request: HMAC headers are refused outright
        key_id = self.signed_header(headers, "X-Ltfiles-Read-Key-Id", r"[A-Za-z0-9_-]{1,64}")
        timestamp = self.signed_header(headers, "X-Ltfiles-Read-Time", r"[1-9][0-9]{0,15}")
        nonce = self.signed_header(headers, "X-Ltfiles-Read-Nonce", r"[a-f0-9]{32}")
        signature_text = self.signed_header(headers, "X-Ltfiles-Read-Signature", r"[A-Za-z0-9_-]{86}")
        key = self.read_keys.get(key_id)
        if key is None:
            raise Denied("unauthorized", 401)
        message = "\n".join(["ltfiles-v1read", self.gateway_id, key_id, timestamp, nonce, "POST", "/v1/read",
                             hashlib.sha256(body).hexdigest()]).encode("ascii")
        try:
            signature = b64url(signature_text)
            if len(signature) != 64:
                raise ValueError("size")
            key.verify(signature, message)
        except (InvalidSignature, ValueError):
            raise Denied("unauthorized", 401) from None
        return key_id, timestamp, nonce
