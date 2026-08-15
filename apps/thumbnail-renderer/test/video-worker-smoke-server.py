import hashlib
import http.server
import json
import os
import re
import ssl

ROOT = "/scratch"
VIDEO = os.path.join(ROOT, "source.mp4")
OUTPUT = os.path.join(ROOT, "received.webp")
TOKEN = "synthetic-renderer-token-at-least-32-bytes"
R2_HOST = "0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com"
API_PREFIX = "/api/internal/thumbnail-renderer/v1"
claimed = False


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
        if self.path == API_PREFIX + "/claim?includeKind=video":
            assert not self.headers.get("CF-Access-Client-Id")
            claimed = True
            size = os.path.getsize(VIDEO)
            reply(self, 200, {
                "status": "claimed", "leaseId": "synthetic-lease", "sourceKey": "Jobs/Synthetic/smoke.mp4",
                "sourceSize": size, "mediaKind": "video", "thumbnailKey": "_ltds/synthetic.webp",
                "r2SourceUrl": API_PREFIX + "/source/synthetic", "r2PresignedUrl": f"https://{R2_HOST}/video?signature=synthetic",
                "r2UploadUrl": API_PREFIX + "/thumbnail/synthetic",
            })
        elif self.path == API_PREFIX + "/heartbeat":
            assert payload == {"sourceKey": "Jobs/Synthetic/smoke.mp4", "leaseId": "synthetic-lease"}
            reply(self, 200, {"status": "ok"})
        elif self.path == API_PREFIX + "/complete":
            assert claimed and os.path.exists(OUTPUT)
            assert payload["leaseId"] == "synthetic-lease"
            assert payload["thumbnailKey"] == "_ltds/synthetic.webp"
            assert payload["thumbnailSize"] == os.path.getsize(OUTPUT)
            assert payload["thumbnailEtag"] == hashlib.sha256(open(OUTPUT, "rb").read()).hexdigest()
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
        if not self.path.startswith("/video?"):
            reply(self, 404, {"error": "not_found"})
            return
        data = open(VIDEO, "rb").read()
        range_header = self.headers.get("Range")
        if range_header:
            match = re.fullmatch(r"bytes=(\d+)-(\d*)", range_header)
            if not match:
                self.send_error(416)
                return
            start = int(match.group(1))
            end = int(match.group(2)) if match.group(2) else len(data) - 1
            end = min(end, len(data) - 1)
            chunk = data[start:end + 1]
            self.send_response(206)
            self.send_header("Content-Range", f"bytes {start}-{end}/{len(data)}")
        else:
            chunk = data
            self.send_response(200)
        self.send_header("Content-Type", "video/mp4")
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("Content-Length", str(len(chunk)))
        self.end_headers()
        self.wfile.write(chunk)


server = http.server.ThreadingHTTPServer(("0.0.0.0", 443), Handler)
context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
context.load_cert_chain("/scratch/server.crt", "/scratch/server.key")
server.socket = context.wrap_socket(server.socket, server_side=True)
server.serve_forever()
