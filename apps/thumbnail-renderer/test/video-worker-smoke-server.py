import hashlib
import http.server
import json
import os
import re
import ssl
import sys
import threading

ROOT = "/scratch"
OUTPUT = os.path.join(ROOT, "received.webp")
TOKEN = "synthetic-renderer-token-at-least-32-bytes"
R2_HOST = "0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com"
API_PREFIX = "/api/internal/thumbnail-renderer/v1"
claimed = False
KIND = os.environ.get("SMOKE_KIND", "video")
SOURCE = os.path.join(ROOT, os.environ.get("SMOKE_SOURCE_FILE") or {
    "image": "source.jpg",
    "pdf": "source.pdf",
    "video": "source.mp4",
}[KIND])
SOURCE_KEY = os.environ.get("SMOKE_SOURCE_KEY") or {
    "image": "Jobs/Synthetic/smoke.jpg",
    "pdf": "Jobs/Synthetic/smoke.pdf",
    "video": "Jobs/Synthetic/smoke.mp4",
}[KIND]
REQUIRE_TAIL_RANGE = os.environ.get("SMOKE_REQUIRE_TAIL_RANGE", "0") == "1"
REQUIRE_PARTIAL_TRANSFER = os.environ.get("SMOKE_REQUIRE_PARTIAL_TRANSFER", "0") == "1"
INCLUDE_PRESIGNED = os.environ.get("SMOKE_INCLUDE_PRESIGNED", "1") == "1"
RANGE_BUDGET = 512 * 1024 * 1024
MAX_UPSTREAM_RANGE_BYTES = 8 * 1024 * 1024
range_lock = threading.Lock()
range_requests = []
range_bytes = 0
full_video_get = False
SOURCE_CONTENT_TYPE = os.environ.get("SMOKE_CONTENT_TYPE") or {
    "image": "image/jpeg",
    "pdf": "application/pdf",
    "video": "video/mp4",
}[KIND]


def reply(handler, status, body):
    encoded = json.dumps(body, separators=(",", ":")).encode()
    handler.send_response(status)
    handler.send_header("Content-Type", "application/json")
    handler.send_header("Content-Length", str(len(encoded)))
    handler.end_headers()
    handler.wfile.write(encoded)


class Handler(http.server.BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *_args):
        pass

    def authorized(self):
        return self.headers.get("Authorization") == f"Bearer {TOKEN}"

    def do_POST(self):
        global claimed
        if not self.authorized():
            reply(self, 401, {"error": "unauthorized"})
            return
        length = int(self.headers.get("Content-Length", "0"))
        payload = json.loads(self.rfile.read(length) or b"{}")
        if self.path == API_PREFIX + "/claim?includeKind=all":
            assert not self.headers.get("CF-Access-Client-Id")
            claimed = True
            size = os.path.getsize(SOURCE)
            body = {
                "status": "claimed", "leaseId": "synthetic-lease", "sourceKey": SOURCE_KEY,
                "sourceSize": size, "mediaKind": KIND, "sourceContentType": SOURCE_CONTENT_TYPE,
                "thumbnailKey": "_ltds/synthetic.webp",
                "r2SourceUrl": API_PREFIX + "/source/synthetic", "r2UploadUrl": API_PREFIX + "/thumbnail/synthetic",
            }
            if KIND == "video" and INCLUDE_PRESIGNED:
                body["r2PresignedUrl"] = f"https://{R2_HOST}/video?signature=synthetic"
            reply(self, 200, body)
        elif self.path == API_PREFIX + "/heartbeat":
            assert payload == {"sourceKey": SOURCE_KEY, "leaseId": "synthetic-lease"}
            reply(self, 200, {"status": "ok"})
        elif self.path == API_PREFIX + "/complete":
            assert claimed and os.path.exists(OUTPUT)
            assert payload["leaseId"] == "synthetic-lease"
            assert payload["thumbnailKey"] == "_ltds/synthetic.webp"
            assert payload["thumbnailSize"] == os.path.getsize(OUTPUT)
            assert payload["thumbnailEtag"] == hashlib.sha256(open(OUTPUT, "rb").read()).hexdigest()
            if KIND == "video":
                source_size = os.path.getsize(SOURCE)
                with range_lock:
                    assert range_requests
                    assert not full_video_get
                    assert 0 < range_bytes <= RANGE_BUDGET
                    assert all(0 < end - start + 1 <= MAX_UPSTREAM_RANGE_BYTES for start, end in range_requests)
                    if REQUIRE_TAIL_RANGE:
                        assert any(start >= source_size // 2 for start, _end in range_requests)
                    if REQUIRE_PARTIAL_TRANSFER:
                        assert source_size > 2 * MAX_UPSTREAM_RANGE_BYTES
                        assert range_bytes < source_size // 4, (range_bytes, source_size)
                    print(
                        f"range-proof requests={len(range_requests)} bytes={range_bytes} "
                        f"tail={any(start >= source_size // 2 for start, _end in range_requests)}",
                        file=sys.stderr,
                        flush=True,
                    )
            open(os.path.join(ROOT, "completed"), "x").close()
            reply(self, 200, {"status": "ready"})
        elif self.path == API_PREFIX + "/fail":
            reply(self, 200, {"status": "failed"})
        else:
            reply(self, 404, {"error": "not_found"})

    def do_PUT(self):
        if not self.authorized() or self.path != API_PREFIX + "/thumbnail/synthetic":
            reply(self, 401, {"error": "unauthorized"})
            return
        length = int(self.headers["Content-Length"])
        data = self.rfile.read(length)
        assert self.headers.get("Content-Type") == "image/webp"
        assert data[:4] == b"RIFF" and data[8:12] == b"WEBP" and length <= 131072
        with open(OUTPUT, "wb") as handle:
            handle.write(data)
        reply(self, 200, {"status": "stored", "etag": hashlib.sha256(data).hexdigest(), "size": len(data)})

    def do_GET(self):
        proxy_source = self.path == API_PREFIX + "/source/synthetic"
        if proxy_source and KIND != "video":
            if not self.authorized():
                reply(self, 401, {"error": "unauthorized"})
                return
            data = open(SOURCE, "rb").read()
            self.send_response(200)
            self.send_header("Content-Type", "application/octet-stream")
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Accept-Ranges", "bytes")
            self.end_headers()
            self.wfile.write(data)
            return
        if KIND != "video" or (not proxy_source and not self.path.startswith("/video?")):
            reply(self, 404, {"error": "not_found"})
            return
        if proxy_source and not self.authorized():
            reply(self, 401, {"error": "unauthorized"})
            return
        global range_bytes, full_video_get
        source_size = os.path.getsize(SOURCE)
        range_header = self.headers.get("Range")
        if range_header:
            match = re.fullmatch(r"bytes=(\d+)-(\d*)", range_header)
            if not match:
                self.send_error(416)
                return
            start = int(match.group(1))
            end = int(match.group(2)) if match.group(2) else source_size - 1
            end = min(end, source_size - 1)
            if start >= source_size or end < start or end - start + 1 > MAX_UPSTREAM_RANGE_BYTES:
                self.send_error(416)
                return
            with range_lock:
                range_requests.append((start, end))
            self.send_response(206)
            self.send_header("Content-Range", f"bytes {start}-{end}/{source_size}")
        else:
            with range_lock:
                full_video_get = True
            self.send_error(416)
            return
        self.send_header("Content-Type", "video/mp4")
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("Content-Length", str(end - start + 1))
        self.end_headers()
        remaining = end - start + 1
        with open(SOURCE, "rb") as handle:
            handle.seek(start)
            while remaining > 0:
                chunk = handle.read(min(64 * 1024, remaining))
                if not chunk:
                    break
                try:
                    self.wfile.write(chunk)
                    self.wfile.flush()
                except (BrokenPipeError, ConnectionResetError, ssl.SSLEOFError):
                    break
                with range_lock:
                    range_bytes += len(chunk)
                    if range_bytes > RANGE_BUDGET:
                        self.close_connection = True
                        return
                remaining -= len(chunk)


server = http.server.ThreadingHTTPServer(("0.0.0.0", 443), Handler)
context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
context.load_cert_chain("/scratch/server.crt", "/scratch/server.key")
server.socket = context.wrap_socket(server.socket, server_side=True)
server.serve_forever()
