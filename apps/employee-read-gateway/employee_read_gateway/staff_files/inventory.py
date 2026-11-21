"""The root inventory gate for writes (contract R3.3).

Writes are enabled only by a positively verified inventory bound to this exact host, dataset, gateway and configuration:

  { "host", "dataset", "gatewayId", "configSha256",
    "otherRoots": [{"gatewayId", "rootId", "hostPath"}], "smbShares": [...], "cloudSyncSources": [...],
    "managedRoots": [...], "verifiedBy": "<QA receipt id>" }

Every list must be present (an empty list is written as []). A missing, malformed, partial, unverified or differently bound
inventory disables writes; reads are unaffected. The container checks ancestor/descendant overlap of the served dataset
with every listed host path, and same-identity aliases (this root id listed under another gateway or path). It cannot
prove the inventory is complete: completeness is the QA receipt, and only for synthetic staging.
"""
from __future__ import annotations

import hashlib
import json
import posixpath
import re

KEYS = {"host", "dataset", "gatewayId", "configSha256", "otherRoots", "smbShares", "cloudSyncSources", "managedRoots", "verifiedBy"}
LISTS = ("smbShares", "cloudSyncSources", "managedRoots")
_UUID = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\Z")
_HOST = re.compile(r"[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?\Z")
_RECEIPT = re.compile(r"[A-Za-z0-9._:-]{8,128}\Z")


def config_sha256(host: str, dataset: str, gateway_id: str, root_id: str, root_generation: int, root_fingerprint: str) -> str:
    material = json.dumps([host, dataset, gateway_id, root_id, root_generation, root_fingerprint], separators=(",", ":"))
    return hashlib.sha256(material.encode("utf-8")).hexdigest()


def _host_path(value) -> str:
    if not isinstance(value, str) or not value.startswith("/") or value != posixpath.normpath(value) or value == "/" \
            or len(value) > 1024 or any(ord(c) < 32 for c in value):
        raise ValueError("path")
    return value


def _overlaps(a: str, b: str) -> bool:
    return a == b or a.startswith(b + "/") or b.startswith(a + "/")


def check_inventory(text: str | None, *, host: str, dataset: str, gateway_id: str, root_id: str, root_generation: int,
                    root_fingerprint: str) -> tuple[bool, str]:
    """(writes_enabled, reason). Never raises: anything unexpected disables writes."""
    try:
        if not text:
            return False, "inventory-missing"
        value = json.loads(text)
        if not isinstance(value, dict) or set(value) != KEYS:
            return False, "inventory-malformed"
        if value["host"] != host or not _HOST.match(host) or value["dataset"] != _host_path(dataset) \
                or value["gatewayId"] != gateway_id or not _UUID.match(gateway_id) \
                or value["configSha256"] != config_sha256(host, dataset, gateway_id, root_id, root_generation, root_fingerprint):
            return False, "inventory-unbound"
        if not isinstance(value["verifiedBy"], str) or not _RECEIPT.match(value["verifiedBy"]):
            return False, "inventory-unverified"
        if not isinstance(value["otherRoots"], list) or any(not isinstance(value[name], list) for name in LISTS):
            return False, "inventory-malformed"
        for name in LISTS:
            for path in value[name]:
                if _overlaps(_host_path(path), dataset):
                    return False, f"overlap-{name}"
        for other in value["otherRoots"]:
            if not isinstance(other, dict) or set(other) != {"gatewayId", "rootId", "hostPath"} \
                    or not _UUID.match(str(other["gatewayId"])) or not _UUID.match(str(other["rootId"])):
                return False, "inventory-malformed"
            if other["rootId"] == root_id:
                return False, "alias-root"  # the same root registered under another gateway or path
            if _overlaps(_host_path(other["hostPath"]), dataset):
                return False, "overlap-otherRoots"
        return True, "ok"
    except (ValueError, TypeError, KeyError):
        return False, "inventory-malformed"
