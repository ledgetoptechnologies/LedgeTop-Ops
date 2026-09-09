#!/usr/bin/env python3
"""Prepare private, bounded inventory callbacks; never print proof material."""
import json
import os
import sys
import uuid

PAGE_BYTES = 48 * 1024
MAX_INPUT_BYTES = 1024 * 1024


def pages(document, proof):
    inventory_id = str(uuid.uuid5(uuid.UUID(proof["claimToken"]), proof["sha256"]))
    if document.get("status") != "ready":
        reason = document.get("category", "inventory_unavailable")
        if not isinstance(reason, str) or not reason.replace("_", "").isalnum() or len(reason) > 64:
            reason = "inventory_unavailable"
        return [("archive-inventory-unavailable", {**proof, "inventoryId": inventory_id, "reason": reason})]
    entries = document.get("entries")
    if not isinstance(entries, list) or len(entries) > 10000:
        raise ValueError("invalid inventory")
    result = []
    batch = []
    for entry in entries:
        candidate = {**proof, "inventoryId": inventory_id, "page": len(result), "complete": False, "entries": batch + [entry]}
        if len(batch) >= 250 or len(json.dumps(candidate, separators=(",", ":")).encode()) > PAGE_BYTES:
            if not batch:
                raise ValueError("oversized entry")
            result.append(("archive-inventory", {**candidate, "entries": batch}))
            batch = []
            candidate["page"] = len(result)
            candidate["entries"] = [entry]
            if len(json.dumps(candidate, separators=(",", ":")).encode()) > PAGE_BYTES:
                raise ValueError("oversized entry")
        batch.append(entry)
    result.append(("archive-inventory", {**proof, "inventoryId": inventory_id, "page": len(result), "complete": True, "entries": batch}))
    return result


def main():
    try:
        with open(sys.argv[1], "rb") as source:
            raw = source.read(MAX_INPUT_BYTES + 1)
        if len(raw) > MAX_INPUT_BYTES:
            raise ValueError("oversized inventory")
        proof = json.loads(os.environ["INCOMING_INVENTORY_PROOF"])
        result = pages(json.loads(raw), proof)
        os.mkdir(sys.argv[2], mode=0o700)
        for index, (action, payload) in enumerate(result):
            target = os.path.join(sys.argv[2], f"{index:04d}.{action}.json")
            descriptor = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            with os.fdopen(descriptor, "w", encoding="utf-8") as output:
                json.dump(payload, output, separators=(",", ":"))
                output.flush()
                os.fsync(output.fileno())
        return 0
    except (OSError, ValueError, KeyError, IndexError, TypeError):
        print("inventory receipt preparation failed", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
