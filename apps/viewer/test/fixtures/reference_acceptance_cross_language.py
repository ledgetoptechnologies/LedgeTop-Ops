"""Synthetic probe invoked by the optional Viewer/Processing pairing test."""
import copy
import hashlib
import io
import json
import os
import sys
import urllib.request
from urllib.error import HTTPError
from urllib.parse import urlsplit, urlunsplit

ROOT = os.environ["LTDS_PROCESSING_REPO"]
sys.path.insert(0, ROOT)

from processing import reference_protocol as protocol  # noqa: E402
from processing.viewer_acceptance_transfer import (  # noqa: E402
    PATH, PATH_V2, ViewerAcceptanceTransfer, ViewerTransferUnavailable,
)
from processing.viewer_result_manifest import derive_viewer_result_manifest  # noqa: E402


class LoopbackOpener:
    """Route the sender's HTTPS-shaped URL to the local synthetic Express API."""

    def __init__(self, target):
        self.target = target.rstrip("/")
        self.inner = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        self.drop_next_commit = False
        self.last_error_body = b""

    def open(self, request, timeout=30):
        parsed = urlsplit(request.full_url)
        local_url = urlunsplit(("http", urlsplit(self.target).netloc,
            parsed.path, parsed.query, ""))
        mapped = urllib.request.Request(local_url, data=request.data,
            headers=dict(request.header_items()), method=request.get_method())
        try:
            response = self.inner.open(mapped, timeout=timeout)
        except HTTPError as error:
            self.last_error_body = error.read()
            raise
        if self.drop_next_commit and request.get_method() == "POST" and parsed.path.endswith("/commit"):
            self.drop_next_commit = False
            response.read()
            response.close()
            raise OSError("synthetic lost commit response after remote commit")
        return ResponseAdapter(response, request.full_url)


class ResponseAdapter:
    def __init__(self, response, original_url):
        self.response = response
        self.original_url = original_url
        self.status = response.status
        self.headers = response.headers

    def geturl(self):
        return self.original_url

    def read(self, size=-1):
        return self.response.read(size)

    def close(self):
        self.response.close()


class ResultProxy:
    def __init__(self, objects):
        self.objects = objects

    def open(self, _job, _manifest, object_id, *, range_header=None):
        value = self.objects[object_id]
        if range_header is not None:
            start, end = map(int, range_header.removeprefix("bytes=").split("-"))
            value = value[start:end + 1]
        return io.BytesIO(value)


def manifest(objects, *, job_id, environment, pipeline_digest, engine_versions):
    result = {
        "schemaVersion": 1,
        "jobId": job_id,
        "generation": 1,
        "environment": environment,
        "pipelineDigest": pipeline_digest,
        "engineVersions": engine_versions,
        "objects": [
            {"id": object_id, "role": role, "byteSize": len(data),
             "sha256": hashlib.sha256(data).hexdigest()}
            for object_id, role, data in objects
        ],
    }
    result["resultManifestSha256"] = protocol.digest(result)
    return result


def make_job(accepted_receipt_id, *, environment="staging", use_treedar=False):
    contract_path = os.path.join(ROOT, "contracts", "reference-v1.contract.json")
    fixture = json.loads(open(contract_path, "r", encoding="utf-8").read())
    submission = fixture["submission"]
    checked_submission = protocol.validate_submission(submission,
        environment="staging", capability_fingerprint=submission["capabilityFingerprint"])
    job_id = "job-pair-v2" if use_treedar else "job-pair-v1"
    if use_treedar:
        roles = ["ground_model", "canopy_height", "canopy_height_unfiltered", "crown_labels",
            "crowns", "tree_table", "tree_features", "run_summary", "report", "preview",
            "area_map_preview", "engine_manifest"]
        object_values = [(f"td-{role}", role, f"synthetic:{role}".encode()) for role in roles]
        engines = {"treedar": "synthetic-treedar-1"}
    else:
        object_values = [("result-1", "pointcloud", b"abc"), ("result-2", "report", b"")]
        engines = {"odm": "synthetic-odm-1"}
    internal = manifest(object_values, job_id=job_id, environment=environment,
        pipeline_digest=checked_submission["pipelineDigest"], engine_versions=engines)
    job = {
        "jobId": job_id,
        "generation": 1,
        "environment": environment,
        "manifestSha256": submission["manifest"]["sha256"],
        "pipelineDigest": checked_submission["pipelineDigest"],
        "nodeId": "synthetic-node",
        "submission": submission,
        "resultManifest": internal,
        "resultManifestSha256": internal["resultManifestSha256"],
    }
    viewer_manifest = derive_viewer_result_manifest(internal, job_id=job_id,
        generation=1, environment=environment, pipeline_digest=job["pipelineDigest"])
    acceptance = {
        "schemaVersion": 1,
        "receiptId": accepted_receipt_id,
        "storageReceiptId": "storage-" + accepted_receipt_id,
        "jobId": job_id,
        "generation": 1,
        "environment": environment,
        "inputManifestSha256": job["manifestSha256"],
        "pipelineDigest": job["pipelineDigest"],
        "resultManifestSha256": viewer_manifest["resultManifestSha256"],
        "acceptedObjectIds": [item["id"] for item in viewer_manifest["objects"]],
        "acceptedAt": "2026-11-02T12:00:00.000Z",
        "validationVersion": protocol.VALIDATION_VERSION,
    }
    return job, acceptance, viewer_manifest, {object_id: data for object_id, _role, data in object_values}


def make_client(job, objects, trusted_keys, opener, *, key_id=None, secret=None):
    issuer_id = os.environ["LTDS_VIEWER_RECEIPT_ISSUER_ID"]
    receipt_key_id = os.environ["LTDS_VIEWER_RECEIPT_KEY_ID"]
    public_key = os.environ["LTDS_VIEWER_RECEIPT_PUBLIC_KEY_PEM"]
    keys = {receipt_key_id: {"issuerId": issuer_id, "publicKeyPem": public_key}}
    return ViewerAcceptanceTransfer(os.environ["LTDS_VIEWER_ORIGIN"],
        key_id=key_id or os.environ["LTDS_VIEWER_SERVICE_KEY_ID"],
        secret=secret or os.environ["LTDS_VIEWER_SERVICE_SECRET"],
        trusted_receipt_keys=trusted_keys or keys,
        result_proxy=ResultProxy(objects), opener=opener.open, chunk_bytes=8, timeout=10)


def main():
    opener = LoopbackOpener(os.environ["LTDS_VIEWER_LOOPBACK"])
    job1, acceptance1, _viewer1, objects1 = make_job("receipt-pair-v1")
    client1 = make_client(job1, objects1, None, opener)
    opener.drop_next_commit = True
    try:
        client1.transfer(job1, acceptance1)
        raise AssertionError("the synthetic lost commit response was not observed")
    except ViewerTransferUnavailable as error:
        assert str(error) == "viewer_transport_unavailable", str(error)
    recovered = client1.transfer(job1, acceptance1)
    replayed = client1.transfer(job1, acceptance1)
    assert recovered == replayed
    assert recovered["acceptance"] == acceptance1
    assert recovered["viewerReceipt"]["acceptedObjectIds"] == acceptance1["acceptedObjectIds"]

    job2, acceptance2, viewer2, objects2 = make_job("receipt-pair-v2", use_treedar=True)
    client2 = make_client(job2, objects2, None, opener)
    accepted_v2 = client2.transfer(job2, acceptance2, viewer_result_manifest=viewer2)
    assert accepted_v2["acceptance"] == acceptance2
    assert accepted_v2["viewerReceipt"]["resultManifestSha256"] == viewer2["resultManifestSha256"]

    bad_auth = make_client(job1, objects1, None, opener, secret="wrong-synthetic-secret-000000000000000000000000")
    auth_status, _ = bad_auth._request("GET", PATH + "/receipt-auth-mismatch", allowed=(401,))
    assert auth_status == 401

    production_job, production_acceptance, _production_viewer, production_objects = make_job(
        "receipt-pair-environment-mismatch", environment="production")
    production_client = make_client(production_job, production_objects, None, opener)
    try:
        production_client.transfer(production_job, production_acceptance)
        raise AssertionError("environment mismatch was accepted")
    except ViewerTransferUnavailable as error:
        assert str(error) == "viewer_http_409", str(error)
    environment_status = 409
    environment_error = json.loads(opener.last_error_body.decode("utf-8"))["code"]
    assert environment_error == "BINDING_MISMATCH", environment_error

    wrong_schema_acceptance = copy.deepcopy(acceptance1)
    wrong_schema_acceptance["receiptId"] = "receipt-pair-schema-mismatch"
    wrong_schema_acceptance["storageReceiptId"] = "storage-schema-mismatch"
    expected = {
        "jobId": job1["jobId"], "generation": job1["generation"], "environment": job1["environment"],
        "inputManifestSha256": job1["manifestSha256"], "pipelineDigest": job1["pipelineDigest"],
        "resultManifestSha256": job1["resultManifestSha256"],
        "objectIds": [item["id"] for item in job1["resultManifest"]["objects"]],
    }
    wrong_schema_body = protocol.canonical_json({
        "inputManifest": job1["submission"]["manifest"], "expected": expected,
        "resultManifest": job1["resultManifest"], "acceptance": wrong_schema_acceptance,
    })
    schema_status, schema_error = client1._request("PUT",
        PATH_V2 + "/" + wrong_schema_acceptance["receiptId"], wrong_schema_body,
        allowed=(202, 400, 409))
    schema_error = json.loads(opener.last_error_body.decode("utf-8"))
    assert schema_status == 400, (schema_status, schema_error)
    assert schema_error["code"] == "INVALID_PROTOCOL", schema_error

    print(json.dumps({
        "v1": "accepted_after_lost_commit_and_status_replay",
        "v2": "accepted",
        "authMismatch": auth_status,
        "environmentMismatch": environment_status,
        "environmentError": environment_error,
        "schemaMismatch": schema_status,
        "schemaError": schema_error.get("code"),
    }, sort_keys=True))


if __name__ == "__main__":
    main()
