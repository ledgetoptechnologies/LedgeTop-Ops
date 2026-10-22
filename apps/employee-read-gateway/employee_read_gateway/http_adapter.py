"""Fixed POST adapter. Deploy only behind an operator-configured TLS reverse proxy."""
import http.server
import json
import socket
import select
import threading

from .core import Denied, Snapshot


class ReadServer(http.server.ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self, address, gateway, connections=16):
        self.gateway = gateway
        self.connections = threading.BoundedSemaphore(connections)
        super().__init__(address, ReadHandler)

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
        # Never log signed request headers, filesystem paths or exception details.
        pass


class ReadHandler(http.server.BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.0"  # One request, no pipelining or reusable body ambiguity.
    server_version = "OpsReadGateway"
    sys_version = ""

    def setup(self):
        super().setup()
        self.connection.settimeout(5)

    def log_message(self, *args):
        pass

    def send_error(self, code, message=None, explain=None):
        self.error(Denied("invalid-request", code))

    def error(self, error):
        body = json.dumps({"schemaVersion": 1, "error": error.code}, separators=(",", ":")).encode()
        self.send_response(error.status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("Connection", "close")
        self.end_headers()
        self.wfile.write(body)
        self.close_connection = True

    def cancelled(self):
        try:
            if not select.select([self.connection], [], [], 0)[0]:
                return False
            return self.connection.recv(1, socket.MSG_PEEK | socket.MSG_DONTWAIT) == b""
        except (BlockingIOError, TimeoutError):
            return False
        except OSError:
            return True

    def do_POST(self):
        reply, started = None, False
        try:
            if self.path != "/v1/read":
                raise Denied("not-found", 404)
            if sum(len(k) + len(v) for k, v in self.headers.items()) > 8192:
                raise Denied("invalid-request", 431)
            for name in self.headers.keys():
                if len(self.headers.get_all(name)) != 1:
                    raise Denied()
            if self.headers.get("Transfer-Encoding") is not None or self.headers.get("Expect") is not None:
                raise Denied()
            length = self.headers.get("Content-Length", "")
            if not length.isascii() or not length.isdecimal() or str(int(length)) != length or not 0 < int(length) <= 16384:
                raise Denied()
            body = self.rfile.read(int(length))
            if len(body) != int(length):
                raise Denied()
            # Header names are case-insensitive on HTTP; the core's injected dictionary is canonical.
            names = ("Content-Type", "X-Ops-Read-Key-Id", "X-Ops-Read-Time", "X-Ops-Read-Nonce", "X-Ops-Read-Signature")
            headers = {name: self.headers.get(name) for name in names}
            reply = self.server.gateway.execute(headers, body, self.cancelled)
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
                self.error(error)
        except (OSError, TimeoutError):
            if not started:
                try:
                    self.error(Denied("request-cancelled", 408))
                except OSError:
                    pass
        except Exception:
            if not started:
                self.error(Denied("gateway-unavailable", 503))
        finally:
            if reply is not None and isinstance(reply.body, Snapshot):
                reply.body.close()
            self.close_connection = True

    def do_GET(self):
        self.error(Denied("method-not-allowed", 405))

    do_HEAD = do_GET
    do_PUT = do_GET
    do_DELETE = do_GET
