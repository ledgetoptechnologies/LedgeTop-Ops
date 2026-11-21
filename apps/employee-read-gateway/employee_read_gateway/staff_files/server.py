"""HTTP for staff writes: POST /v2/op (Access service assertion + Ops Ed25519 signature) and GET /readyz.

The order is fixed: the NAS link assertion, then the Files signature and its scope, then the body is read (bounded by
the chunk size) and its digest compared with the signed one. Unauthenticated callers get one opaque 404.
"""
from __future__ import annotations

import http.server
import json
import threading

from ..errors import Denied
from .access import AccessKeys, verify_service_assertion
from .service import StaffFiles
from .signing import verify_envelope

MAX_HEADERS = 32768


class StaffFilesServer(http.server.ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self, address, files: StaffFiles, keys, access_keys: AccessKeys, issuer: str, connections=16):
        self.files, self.keys, self.access_keys, self.issuer = files, keys, access_keys, issuer
        self.connections = threading.BoundedSemaphore(connections)
        super().__init__(address, StaffFilesHandler)

    def process_request(self, request, client_address):
        if not self.connections.acquire(blocking=False):
            self.shutdown_request(request)
            return
        try:
            super().process_request(request, client_address)
        except BaseException:
            self.connections.release()
            raise

    def process_request_thread(self, request, client_address):
        try:
            super().process_request_thread(request, client_address)
        finally:
            self.connections.release()

    def handle_error(self, request, client_address):
        pass  # never log headers, paths or exception details


class StaffFilesHandler(http.server.BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.0"
    server_version = "LedgeTopFiles"
    sys_version = ""

    def setup(self):
        super().setup()
        self.connection.settimeout(60)

    def log_message(self, *args):
        pass

    def reply(self, status: int, body: dict):
        data = json.dumps({"schemaVersion": 2, **body}, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Connection", "close")
        self.end_headers()
        self.wfile.write(data)
        self.close_connection = True

    def send_error(self, code, message=None, explain=None):
        self.reply(code if code in (400, 404, 405, 408, 413, 431) else 400, {"error": "invalid-request"})

    def do_GET(self):
        if self.path == "/readyz":
            ok = self.server.files.ready() and self.server.access_keys.ready()
            self.reply(200 if ok else 503, {"ready": ok})
            return
        self.reply(404, {"error": "not-found"})

    def do_POST(self):
        server = self.server
        try:
            if self.path != "/v2/op":
                raise Denied("not-found", 404)
            if sum(len(k) + len(v) for k, v in self.headers.items()) > MAX_HEADERS:
                raise Denied("invalid-request", 431)
            for name in self.headers.keys():
                if len(self.headers.get_all(name)) != 1:
                    raise Denied()
            verify_service_assertion(self.headers.get("Cf-Access-Jwt-Assertion"), issuer=server.issuer,
                                     audience=server.files.config.audience, client_id=server.files.config.client_id,
                                     keys=server.access_keys)
            envelope = verify_envelope(self.headers.get("X-Ltfiles-Envelope"), self.headers.get("X-Ltfiles-Signature"),
                                       "files-write", server.keys)
            if self.headers.get("Transfer-Encoding") is not None or self.headers.get("Expect") is not None:
                raise Denied()
            length = self.headers.get("Content-Length", "0")
            if not length.isascii() or not length.isdecimal() or str(int(length)) != length:
                raise Denied()
            if int(length) > server.files.config.limits.chunk_size:
                raise Denied("too-large", 413)
            body = self.rfile.read(int(length)) if int(length) else b""
            if len(body) != int(length):
                raise Denied()
            result = server.files.execute(envelope, body)
            self.reply(result.status, result.body)
        except Denied as error:
            self.reply(error.status, {"error": error.code})
        except (OSError, TimeoutError):
            try:
                self.reply(503, {"error": "unavailable"})
            except OSError:
                pass
        except Exception:
            self.reply(503, {"error": "unavailable"})

    do_PUT = do_DELETE = do_PATCH = do_HEAD = lambda self: self.reply(405, {"error": "method-not-allowed"})
