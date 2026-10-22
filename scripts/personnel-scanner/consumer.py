"""Isolated personnel scanner. No NAS, S3 credentials, pickup or public delivery."""
from __future__ import annotations
import datetime as dt
import hashlib
import io
import json
import os
from pathlib import Path, PurePosixPath
import re
import ssl
import stat
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
import warnings
import xml.etree.ElementTree as ET
import zipfile

MAX_BYTES = 25 * 1024 * 1024
MAX_EXPANDED = 64 * 1024 * 1024
POLICY = "personnel-v1"
ALLOWED_ORIGINS = {"https://ops-staging.ledgetopdroneservices.com", "https://ops-staging.ledgetop.app"}
UUID = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}")
HEX = re.compile(r"[0-9a-f]{64}")
OFFICE = {"application/vnd.openxmlformats-officedocument.wordprocessingml.document": (".docx", "word/document.xml", "document", "wordprocessingml"),
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": (".xlsx", "xl/workbook.xml", "workbook", "spreadsheetml")}
FORMULAS = {'SUM','AVERAGE','MIN','MAX','COUNT','COUNTA','COUNTIF','COUNTIFS','SUMIF','SUMIFS','IF','IFERROR','ROUND','ROUNDUP','ROUNDDOWN','ABS','AND','OR','NOT','DATE','YEAR','MONTH','DAY','TODAY','TEXT','LEN','LEFT','RIGHT','MID','CONCAT','CONCATENATE','TRIM','UPPER','LOWER','ISBLANK','ISNUMBER','VLOOKUP','HLOOKUP','XLOOKUP','INDEX','MATCH'}

class Rejected(Exception):
    """Deterministic file-policy rejection; never an engine outage."""
class Retry(Exception):
    def __init__(self, code): self.code = code

def xml_part(data):
    if b"\x00" in data or b"<!DOCTYPE" in data.upper() or b"<!ENTITY" in data.upper(): raise Rejected("xml-entities-or-encoding")
    root = ET.fromstring(data)
    if sum(1 for _ in root.iter()) > 100_000: raise Rejected("xml-nodes")
    return root

def validate_office(path, mime):
    extension, main, root_name, namespace = OFFICE[mime]
    total = 0
    parts = {}
    with zipfile.ZipFile(path) as archive:
        entries = archive.infolist()
        if not 3 <= len(entries) <= 500: raise Rejected("zip-count")
        seen = set()
        for entry in entries:
            name = entry.filename
            p = PurePosixPath(name)
            if (not name or name != entry.orig_filename or len(name) > 240 or "\\" in name or ':' in name or p.is_absolute()
                    or any(s in ("", ".", "..") for s in name.rstrip("/").split("/"))
                    or any(ord(c) < 32 or ord(c) == 127 for c in name)
                    or name.casefold() in seen or entry.flag_bits & 1
                    or entry.compress_type not in (zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED)
                    or stat.S_IFMT(entry.external_attr >> 16) not in (0, stat.S_IFREG, stat.S_IFDIR)):
                raise Rejected("zip-entry")
            seen.add(name.casefold())
            lower = name.casefold()
            if any(term in lower for term in ("vbaproject", "activex", "embeddings/", "externallinks/", "macrosheets/", "customui/")):
                raise Rejected("office-active")
            if entry.is_dir(): continue
            if not lower.endswith((".xml", ".rels", ".png", ".jpg", ".jpeg")): raise Rejected("office-part-type")
            if entry.file_size > 8 * 1024 * 1024 or entry.file_size > max(1, entry.compress_size) * 100:
                raise Rejected("zip-expansion")
            chunks = []
            with archive.open(entry) as stream:
                while chunk := stream.read(64 * 1024):
                    total += len(chunk)
                    if total > MAX_EXPANDED: raise Rejected("zip-total")
                    chunks.append(chunk)
            parts[name] = b"".join(chunks)
            if lower.endswith((".png", ".jpg", ".jpeg")):
                from PIL import Image
                Image.MAX_IMAGE_PIXELS = 20_000_000
                with warnings.catch_warnings():
                    warnings.simplefilter("error")
                    with Image.open(io.BytesIO(parts[name])) as image:
                        if image.format != ("PNG" if lower.endswith(".png") else "JPEG") or getattr(image, "n_frames", 1) != 1: raise Rejected("office-image-format")
                        image.verify()
        if not {"[Content_Types].xml", "_rels/.rels", main}.issubset(parts): raise Rejected("office-main")
        if ("xl/workbook.xml" in parts) == ("word/document.xml" in parts): raise Rejected("office-mixed")
        content = xml_part(parts["[Content_Types].xml"])
        if content.tag != "{http://schemas.openxmlformats.org/package/2006/content-types}Types": raise Rejected("office-types")
        main_type = "application/vnd.openxmlformats-officedocument." + ("wordprocessingml.document.main+xml" if extension == ".docx" else "spreadsheetml.sheet.main+xml")
        if not any(e.attrib.get("PartName") == "/" + main and e.attrib.get("ContentType") == main_type for e in content):
            raise Rejected("office-main-type")
        for element in content:
            declared = element.attrib.get("ContentType", "")
            if not (declared.startswith("application/vnd.openxmlformats-") or declared in ("application/xml", "image/png", "image/jpeg")):
                raise Rejected("office-content-type")
            if any(s in declared.lower() for s in ("macro", "activex", "oleobject", "external")): raise Rejected("office-active-type")
        root = xml_part(parts[main])
        if root.tag != f"{{http://schemas.openxmlformats.org/{namespace}/2006/main}}{root_name}": raise Rejected("office-root")
        found_main = False
        for name, data in parts.items():
            if not name.endswith((".xml", ".rels")): continue
            tree = xml_part(data)
            for element in tree.iter():
                local = element.tag.rsplit("}", 1)[-1]
                if local == "Relationship":
                    target = element.attrib.get("Target", "")
                    reltype = element.attrib.get("Type", "").lower()
                    if (element.attrib.get("TargetMode", "Internal") != "Internal" or ":" in target or "\\" in target or '%' in target
                            or target.startswith("/") or any(s in reltype for s in ("vba", "oleobject", "package", "control", "attachedtemplate", "externallink"))):
                        raise Rejected("office-relationship")
                    if name == "_rels/.rels" and reltype.endswith("/officedocument") and target == main: found_main = True
                if local in ("instrText", "fldSimple"): raise Rejected("office-field")
                value = element.text or ""
                if local in ("f", "definedName") and ("[" in value or "|" in value or re.search(r"(?i)(WEBSERVICE|HYPERLINK|FILTERXML|RTD|DDE|CALL|REGISTER|EXEC|EVALUATE)\s*\(", value)
                        or element.attrib.get("name", "").lower() in ("auto_open", "auto_close")):
                    raise Rejected("office-formula")
                if local in ('f', 'definedName') and any(function.upper().removeprefix('_XLFN.') not in FORMULAS for function in re.findall(r'([A-Za-z_][A-Za-z0-9_.]*)\s*\(', value)):
                    raise Rejected('office-unknown-function')
        if not found_main: raise Rejected("office-main-relationship")

def validate_pdf(path):
    from pypdf import PdfReader
    from pypdf.generic import DictionaryObject, ArrayObject, IndirectObject, StreamObject
    with path.open('rb') as stream:
        if stream.read(5) != b'%PDF-': raise Rejected('pdf-header')
        stream.seek(max(0, path.stat().st_size - 1024))
        if not stream.read().rstrip().endswith(b'%%EOF'): raise Rejected('pdf-tail')
    reader = PdfReader(path, strict=True)
    if reader.is_encrypted or len(reader.pages) > 1000: raise Rejected("pdf-encrypted-or-pages")
    stack = [reader.trailer]
    seen = set()
    nodes = expanded = 0
    forbidden = {"/AA", "/OpenAction", "/JS", "/JavaScript", "/Launch", "/RichMedia", "/XFA", "/EmbeddedFiles", "/EF", "/Filespec", "/URI", "/SubmitForm", "/ImportData", "/GoToR", "/GoToE"}
    while stack:
        value = stack.pop()
        nodes += 1
        if nodes > 20_000: raise Rejected("pdf-objects")
        if isinstance(value, IndirectObject):
            identity = (value.idnum, value.generation)
            if identity in seen: continue
            seen.add(identity)
            stack.append(value.get_object())
        elif isinstance(value, DictionaryObject):
            if forbidden.intersection(str(k) for k in value): raise Rejected("pdf-active")
            if str(value.get("/S", "")) in forbidden: raise Rejected("pdf-action")
            if isinstance(value, StreamObject):
                decoded = value.get_data()
                expanded += len(decoded)
                if len(decoded) > 8 * 1024 * 1024 or expanded > MAX_EXPANDED: raise Rejected("pdf-stream")
            stack.extend(value.values())
        elif isinstance(value, ArrayObject): stack.extend(value)

def validate_file(path, filename, mime):
    if path.stat().st_size < 1 or path.stat().st_size > MAX_BYTES: raise Rejected("size")
    if filename != Path(filename).name or "/" in filename or "\\" in filename: raise Rejected("filename")
    suffix = Path(filename).suffix.lower()
    try:
        if mime in OFFICE:
            if suffix != OFFICE[mime][0]: raise Rejected("extension")
            validate_office(path, mime)
        elif mime == "application/pdf" and suffix == ".pdf": validate_pdf(path)
        elif mime in ("image/png", "image/jpeg") and suffix in ((".png",) if mime == "image/png" else (".jpg", ".jpeg")):
            from PIL import Image
            Image.MAX_IMAGE_PIXELS = 20_000_000
            with warnings.catch_warnings():
                warnings.simplefilter("error")
                with Image.open(path) as image:
                    if image.format != ("PNG" if mime == "image/png" else "JPEG") or getattr(image, "n_frames", 1) != 1: raise Rejected("image-format")
                    image.verify()
                with Image.open(path) as image: image.load()
        elif mime == "text/plain" and suffix == ".txt":
            text = path.read_bytes().decode("utf-8", errors="strict")
            if re.search(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]", text): raise Rejected("text-controls")
        else: raise Rejected("unsupported-type")
    except ImportError as exc: raise Retry("validation_unavailable") from exc
    except (Rejected, Retry): raise
    except Exception as exc: raise Rejected("invalid-structure") from exc

class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *_args, **_kwargs): raise Retry("download_failed")

class API:
    def __init__(self, origin, token, access_id=None, access_secret=None):
        if origin not in ALLOWED_ORIGINS or len(token) < 32 or len(token) > 512 or re.search(r"[\r\n]", token): raise ValueError("invalid configuration")
        self.origin, self.token = origin, token
        if bool(access_id) != bool(access_secret) or any(re.search(r"[\r\n]", v) for v in (access_id or '', access_secret or '')): raise ValueError('invalid Access configuration')
        self.access_id, self.access_secret = access_id, access_secret
        self.opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), urllib.request.HTTPSHandler(context=ssl.create_default_context()), NoRedirect())
    def open(self, path, body=None, lease=None):
        if not path.startswith("/api/staff-personnel/scanner/") or "?" in path or "#" in path or ".." in path: raise ValueError("invalid path")
        headers = {"Authorization": "Bearer " + self.token}
        if self.access_id:
            headers['CF-Access-Client-Id'] = self.access_id
            headers['CF-Access-Client-Secret'] = self.access_secret
        if lease: headers["X-Scan-Lease"] = lease
        if body is not None: headers["Content-Type"] = "application/json"
        request = urllib.request.Request(self.origin + path, data=None if body is None else json.dumps(body, separators=(",", ":")).encode(), headers=headers)
        return self.opener.open(request, timeout=30)
    def post(self, path, body, lease=None):
        with self.open(path, body, lease) as response:
            if response.status != 200: raise Retry("download_failed")
            data = response.read(16385)
            if len(data) > 16384: raise Retry("download_failed")
            return json.loads(data)

def validate_job(job):
    required = {"documentId", "leaseToken", "leaseUntil", "attempt", "filename", "contentType", "size", "sha256", "etag", "objectVersion", "contentPath", "receiptPath", "retryPath", "policyVersion"}
    if not isinstance(job, dict) or set(job) != required: raise Retry("download_failed")
    if not UUID.fullmatch(job["documentId"]) or not HEX.fullmatch(job["leaseToken"]) or not HEX.fullmatch(job["sha256"]): raise Retry("download_failed")
    if not isinstance(job["size"], int) or isinstance(job["size"], bool) or not 1 <= job["size"] <= MAX_BYTES or job["policyVersion"] != POLICY: raise Retry("download_failed")
    if not isinstance(job['objectVersion'], str) or not 1 <= len(job['objectVersion']) <= 1024 or any(ord(char)<32 for char in job['objectVersion']): raise Retry('download_failed')
    base = "/api/staff-personnel/scanner/" + job["documentId"]
    for key, suffix in (("contentPath", "/content"), ("receiptPath", "/receipt"), ("retryPath", "/retry")):
        if job[key] != base + suffix: raise Retry("download_failed")
    until = dt.datetime.fromisoformat(job["leaseUntil"].replace("Z", "+00:00"))
    remaining = (until - dt.datetime.now(dt.timezone.utc)).total_seconds()
    if not 60 <= remaining <= 610: raise Retry("download_failed")

def download(api, job, path):
    digest, total = hashlib.sha256(), 0
    with api.open(job["contentPath"], lease=job["leaseToken"]) as response, path.open("xb") as output:
        if response.status != 200 or response.headers.get("X-Document-ETag") != job["etag"] or response.headers.get("X-Document-SHA256") != job["sha256"] or response.headers.get('X-Document-Version') != job['objectVersion']: raise Retry("object_mismatch")
        if response.headers.get("Content-Length") != str(job["size"]): raise Retry("object_mismatch")
        deadline = time.monotonic() + 90
        while chunk := response.read(64 * 1024):
            total += len(chunk)
            if total > job["size"] or total > MAX_BYTES or time.monotonic() > deadline: raise Retry("object_mismatch")
            digest.update(chunk)
            output.write(chunk)
    if total != job["size"] or digest.hexdigest() != job["sha256"]: raise Retry("object_mismatch")

def definitions():
    try:
        output = subprocess.run(["clamscan", "--version"], check=True, capture_output=True, timeout=10, text=True).stdout.strip()
        engine, version, stamp = output.removeprefix("ClamAV ").split("/", 2)
        built = dt.datetime.strptime(" ".join(stamp.split()), "%a %b %d %H:%M:%S %Y").replace(tzinfo=dt.timezone.utc)
        age = (dt.datetime.now(dt.timezone.utc) - built).total_seconds()
        if not -21600 <= age <= 48 * 3600: raise Retry("definitions_stale")
        return engine, version + ":" + built.isoformat()
    except Retry: raise
    except Exception as exc: raise Retry("scan_unavailable") from exc

def scan_av(path):
    engine, db = definitions()
    args = ["clamscan", "--no-summary", "--infected", "--heuristic-alerts=yes", "--max-filesize=25M", "--max-scansize=64M", "--max-recursion=8", "--max-files=500", "--max-scantime=120000", "--alert-exceeds-max=yes", "--alert-encrypted=yes", "--alert-macros=yes", "--alert-broken-media=yes", "--", str(path)]
    try: result = subprocess.run(args, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=180)
    except (OSError, subprocess.TimeoutExpired) as exc: raise Retry("scan_unavailable") from exc
    if result.returncode not in (0, 1): raise Retry("scan_unavailable")
    return ("clean" if result.returncode == 0 else "rejected"), engine, db

def validate_isolated(path, filename, mime):
    try:
        result = subprocess.run([sys.executable, __file__, "validate", str(path), filename, mime], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=30)
    except subprocess.TimeoutExpired as exc: raise Rejected("validation-limit") from exc
    if result.returncode == 10: raise Rejected("file-policy")
    if result.returncode != 0: raise Retry("validation_unavailable")

def process_job(api, job):
    validate_job(job)
    with tempfile.TemporaryDirectory(prefix="personnel-", dir=os.environ.get("PERSONNEL_SCRATCH", "/work")) as directory:
        path = Path(directory) / "document"
        download(api, job, path)
        # AV availability and freshness are checked even for a policy rejection;
        # an engine outage never becomes a successful scan verdict.
        engine, db = definitions()
        try: validate_isolated(path, job["filename"], job["contentType"])
        except Rejected: verdict = "rejected"
        else: verdict, engine, db = scan_av(path)
        return api.post(job["receiptPath"], {"sha256": job["sha256"], "etag": job["etag"], "objectVersion":job['objectVersion'], "verdict": verdict, "engineVersion": engine, "definitionsVersion": db, "policyVersion": POLICY}, job["leaseToken"])

def refresh():
    try: subprocess.run(["freshclam", "--stdout", "--datadir=/var/lib/clamav", "--user=personnel"], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=180)
    except (OSError, subprocess.SubprocessError) as exc: raise Retry("definitions_stale") from exc
    return definitions()

def main():
    token = Path("/run/secrets/personnel_scanner_token").read_text().strip()
    def optional_secret(name):
        path = Path('/run/secrets') / name
        return path.read_text().strip() if path.exists() else None
    api = API(os.environ.get("PERSONNEL_OPS_ORIGIN", ""), token, optional_secret('personnel_access_client_id'), optional_secret('personnel_access_client_secret'))
    worker = os.environ.get("PERSONNEL_WORKER_ID", "personnel-stage-1")
    if not re.fullmatch(r"[A-Za-z0-9_-]{1,64}", worker): raise ValueError("invalid worker ID")
    last_refresh = None
    while True:
        job = None
        try:
            if last_refresh is None or time.monotonic() - last_refresh > 3600:
                refresh()
                last_refresh = time.monotonic()
            value = api.post("/api/staff-personnel/scanner/claim", {"workerId": worker})
            job = value["job"]
            if job is not None: process_job(api, job)
        except Retry as exc:
            if job:
                try: api.post(job["retryPath"], {"code": exc.code}, job["leaseToken"])
                except Exception: pass  # Lease expiry recovers the interrupted job.
            print(json.dumps({"event": "personnel-scanner.retry", "code": exc.code}), flush=True)
        except Exception:
            print(json.dumps({"event": "personnel-scanner.unavailable"}), flush=True)
        time.sleep(15)

if __name__ == "__main__":
    if len(sys.argv) == 5 and sys.argv[1] == "validate":
        try:
            import resource
            resource.setrlimit(resource.RLIMIT_AS, (512 * 1024 * 1024,) * 2)
            resource.setrlimit(resource.RLIMIT_CPU, (20, 20))
            resource.setrlimit(resource.RLIMIT_NOFILE, (64, 64))
            validate_file(Path(sys.argv[2]), sys.argv[3], sys.argv[4])
        except Retry: sys.exit(20)
        except Exception: sys.exit(10)
    else: main()
