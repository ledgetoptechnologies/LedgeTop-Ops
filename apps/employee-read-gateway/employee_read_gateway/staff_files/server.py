"""HTTP for staff writes: POST /v2/op (Access service assertion + Ops Ed25519 signature) and GET /readyz.

The order is fixed: the NAS link assertion, then the Files signature and its scope, then the body is read (bounded by
the chunk size) and its digest compared with the signed one. Unauthenticated callers get one opaque 404.
"""
from __future__ import annotations

import http.server
import json
import select
import socket
import threading

from ..core import Snapshot
from ..errors import Denied
from .access import AccessKeys, verify_service_assertion
from .service import StaffFiles
from .signing import verify_envelope

MAX_HEADERS = 32768


class StaffFilesServer(http.server.ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self, address, files: StaffFiles, keys, access_keys: AccessKeys, issuer: str, connections=16, reader=None):
        self.files, self.keys, self.access_keys, self.issuer, self.reader = files, keys, access_keys, issuer, reader
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
            self.reply(200 if ok else 503, {"ready": ok, "writes": self.server.files.config.writes_enabled is True,
                                            "reads": self.server.reader is not None})
            return
        self.reply(404, {"error": "not-found"})

    def cancelled(self):
        try:
            if not select.select([self.connection], [], [], 0)[0]:
                return False
            return self.connection.recv(1, socket.MSG_PEEK | socket.MSG_DONTWAIT) == b""
        except (BlockingIOError, TimeoutError):
            return False
        except OSError:
            return True

    def read_v1(self):
        """v1 reads over the NAS link, signed with the files-read Ed25519 key (read.py). Never HMAC."""
        server, reply, started = self.server, None, False
        try:
            if server.reader is None:
                raise Denied("reads-unavailable", 503)
            if sum(len(k) + len(v) for k, v in self.headers.items()) > 16384:
                raise Denied("invalid-request", 431)
            for name in self.headers.keys():
                if len(self.headers.get_all(name)) != 1:
                    raise Denied()
            verify_service_assertion(self.headers.get("Cf-Access-Jwt-Assertion"), issuer=server.issuer,
                                     audience=server.files.config.audience, client_id=server.files.config.client_id,
                                     keys=server.access_keys)
            if self.headers.get("Transfer-Encoding") is not None or self.headers.get("Expect") is not None:
                raise Denied()
            length = self.headers.get("Content-Length", "")
            if not length.isascii() or not length.isdecimal() or str(int(length)) != length or not 0 < int(length) <= 16384:
                raise Denied()
            body = self.rfile.read(int(length))
            if len(body) != int(length):
                raise Denied()
            names = ("Content-Type", "X-Ops-Read-Key-Id", "X-Ops-Read-Signature", "X-Ltfiles-Read-Key-Id", "X-Ltfiles-Read-Time",
                     "X-Ltfiles-Read-Nonce", "X-Ltfiles-Read-Signature")
            reply = server.reader.execute({name: self.headers.get(name) for name in names}, body, self.cancelled)
            self.send_response(reply.status)
            for name, value in reply.headers.items():
                self.send_header(name, value)
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.send_header("Connection", "close")
            self.end_headers()
            started = True
            if isinstance(reply.body, Snapshot):
                for data in reply.body.chunks(self.cancelled):
                    self.wfile.write(data)
            else:
                self.wfile.write(reply.body)
        except Denied as error:
            if not started:
                self.reply(error.status, {"error": error.code})
        except (OSError, TimeoutError):
            if not started:
                try:
                    self.reply(408, {"error": "request-cancelled"})
                except OSError:
                    pass
        except Exception:
            if not started:
                self.reply(503, {"error": "unavailable"})
        finally:
            if reply is not None and isinstance(reply.body, Snapshot):
                reply.body.close()
            self.close_connection = True

    def do_POST(self):
        server = self.server
        if self.path == "/v1/read":
            self.read_v1()
            return
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
