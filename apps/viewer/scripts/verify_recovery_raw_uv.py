#!/usr/bin/env python3
"""Bound raw-atlas pixels and declared LOD0 UV association to a host inventory.

Uses the existing atlas and SourceUvIndex verifiers without changing their
proof mathematics. Association covers candidate triangles, not the union of
original faces; clipping/retriangulation is allowed by those verifiers.
Does not inspect emitted B3DM attributes, KTX pixels, or establish readiness.
The caller must provide immutable isolated inputs, runtime budgets, and the
existing GDAL sidecar/network restrictions.
"""
from __future__ import annotations

import argparse
from contextlib import contextmanager
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import stat
import sys

MAX_TILES = 4096
MAX_INVENTORY_BYTES = 2 * 1024 * 1024
MAX_ENTRIES = 65536
MAX_DEPTH = 32
MAX_PATH_BYTES = 4096
MANIFEST_SUFFIX = ".texture-mapping-manifest.json"
MAPPING_SUFFIX = ".texture-mapping.jsonl"
INVENTORY_SCOPE = "reachable-lod0-b3dm-v1"
RECEIPT_SCOPE = "recovery-lod0-raw-atlas-and-source-uv-association-v1"


class RunnerError(ValueError):
    pass


def require(value, code):
    if not value:
        raise RunnerError(code)


def relative(value):
    require(isinstance(value, str) and value and len(value.encode("utf-8")) <= MAX_PATH_BYTES
            and "\\" not in value and ":" not in value
            and not any(ord(char) < 32 or ord(char) == 127 for char in value), "invalid_inventory_path")
    path = PurePosixPath(value)
    require(not path.is_absolute() and str(path) == value
            and all(part not in (".", "..") for part in path.parts), "invalid_inventory_path")
    return path


def absolute_path(value, directory=False):
    require(isinstance(value, str) and value and len(value.encode("utf-8")) <= MAX_PATH_BYTES,
            "invalid_host_path")
    path = Path(value)
    require(path.is_absolute() and path.resolve(strict=True) == path, "invalid_host_path")
    info = path.lstat()
    require(stat.S_ISDIR(info.st_mode) if directory else stat.S_ISREG(info.st_mode), "invalid_host_path")
    return path


def sha256(value):
    require(isinstance(value, str) and re.fullmatch(r"[0-9a-f]{64}", value), "invalid_expected_digest")
    return value


def encoded(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=True,
                      allow_nan=False).encode("utf-8")


def load_inventory(path, atlas):
    before = atlas.identity(path)
    require(0 < before[2] <= MAX_INVENTORY_BYTES, "inventory_size_limit")
    with atlas.checked_stream(path, before) as stream:
        raw = stream.read(MAX_INVENTORY_BYTES + 1)
    require(len(raw) <= MAX_INVENTORY_BYTES, "inventory_size_limit")
    data = atlas.json_object(raw.decode("utf-8", errors="strict"))
    require(set(data) == {"schemaVersion", "scope", "tiles"}
            and type(data["schemaVersion"]) is int and data["schemaVersion"] == 1
            and data["scope"] == INVENTORY_SCOPE, "inventory_schema_unsupported")
    tiles = data["tiles"]
    require(isinstance(tiles, list) and 0 < len(tiles) <= MAX_TILES, "inventory_tile_limit")
    seen_b3dm, seen_manifest, previous = set(), set(), None
    for tile in tiles:
        require(isinstance(tile, dict)
                and set(tile) == {"b3dmRelativePath", "manifestRelativePath", "b3dmSha256"},
                "inventory_tile_schema_unsupported")
        b3dm, manifest = relative(tile["b3dmRelativePath"]), relative(tile["manifestRelativePath"])
        require(len(b3dm.parts) == 2 and b3dm.parts[0] == "LOD-0" and b3dm.name.endswith(".b3dm")
                and re.fullmatch(r"LOD-0/[A-Za-z0-9_.-]+\.b3dm", str(b3dm)),
                "inventory_lod0_layout_unsupported")
        require(manifest == b3dm.with_name(b3dm.name[:-5] + MANIFEST_SUFFIX), "inventory_pair_mismatch")
        sha256(tile["b3dmSha256"])
        require(str(b3dm).casefold() not in seen_b3dm and str(manifest).casefold() not in seen_manifest,
                "duplicate_inventory_tile")
        require(previous is None or previous < str(b3dm), "inventory_order_invalid")
        seen_b3dm.add(str(b3dm).casefold()); seen_manifest.add(str(manifest).casefold()); previous = str(b3dm)
    return tiles, hashlib.sha256(raw).hexdigest(), before


def inventory_tree(root, atlas):
    """Bounded LOD0 tree snapshot, rejecting links and special files everywhere."""
    result, directories = {}, {}
    count = 0

    def visit(directory, depth):
        nonlocal count
        require(depth <= MAX_DEPTH, "lod0_depth_limit")
        before = directory.lstat()
        require(stat.S_ISDIR(before.st_mode), "lod0_directory_invalid")
        directories[directory] = atlas.stat_identity(before)
        with os.scandir(directory) as entries:
            for entry in entries:
                count += 1
                require(count <= MAX_ENTRIES, "lod0_entry_limit")
                path = Path(entry.path)
                key = path.relative_to(root.parent).as_posix()
                relative(key)
                info = entry.stat(follow_symlinks=False)
                if stat.S_ISDIR(info.st_mode):
                    visit(path, depth + 1)
                else:
                    require(stat.S_ISREG(info.st_mode), "lod0_link_or_special_file")
                    result[key] = atlas.stat_identity(info)
        require(atlas.stat_identity(directory.lstat()) == directories[directory], "lod0_directory_changed")

    visit(root, 0)
    return result, directories


def check_tree_sets(files, tiles):
    b3dm = {key for key in files if key.lower().endswith(".b3dm")}
    manifests = {key for key in files if key.lower().endswith(MANIFEST_SUFFIX)}
    mappings = {key for key in files if key.lower().endswith(MAPPING_SUFFIX)}
    require(b3dm == {tile["b3dmRelativePath"] for tile in tiles}, "lod0_b3dm_inventory_mismatch")
    require(manifests == {tile["manifestRelativePath"] for tile in tiles}, "lod0_manifest_inventory_mismatch")
    require(mappings == {tile["b3dmRelativePath"][:-5] + MAPPING_SUFFIX for tile in tiles},
            "lod0_mapping_inventory_mismatch")


def verify(source_obj, output, expected_source_sha256, expected_lod0_inventory):
    # Import only the installed sibling primitives; never a path from data.
    from verify_source_uv import SourceUvIndex, atlas

    source = absolute_path(source_obj)
    root = absolute_path(output, directory=True)
    inventory = absolute_path(expected_lod0_inventory)
    expected_sha = sha256(expected_source_sha256)
    tiles, inventory_sha, inventory_id = load_inventory(inventory, atlas)
    lod0 = root / "LOD-0"
    require(lod0.is_dir() and not lod0.is_symlink(), "lod0_directory_missing")
    before_files, before_directories = inventory_tree(lod0, atlas)
    check_tree_sets(before_files, tiles)
    source_id = atlas.identity(source)

    raw_digest = hashlib.sha256(b"ltds-recovery-raw-proof-receipts-v1\0")
    raw_faces = raw_charts = raw_atlases = 0
    proof_jsonl = set()
    backend = atlas.GdalBackend()
    try:
        prepared = atlas.PreparedSourceClosure(source, backend=backend)
        require(prepared.snapshot(source)[0] == expected_sha, "source_digest_mismatch")
        with SourceUvIndex(source, backend=backend, prepared_source=prepared, max_tiles=MAX_TILES) as index:
            require(index.obj_sha == expected_sha, "source_digest_mismatch")
            actual_source_sha = index.obj_sha
            for tile in tiles:
                manifest = atlas.regular(root, tile["manifestRelativePath"])
                # Bind the manifest to this exact reachable B3DM and mapping.
                require(atlas.identity(manifest)[2] <= atlas.LINE_LIMIT, "manifest_size_limit")
                descriptor = atlas.json_object(manifest.read_bytes())
                b3dm_name = PurePosixPath(tile["b3dmRelativePath"]).name
                require(descriptor.get("b3dmIdentity") == b3dm_name
                        and descriptor.get("mappingIdentity") == b3dm_name[:-5] + MAPPING_SUFFIX
                        and descriptor.get("b3dmSha256") == tile["b3dmSha256"], "manifest_pair_mismatch")
                proof_path = atlas.regular(manifest.parent, descriptor.get("proofRelativePath"))
                if proof_path.name.lower().endswith(".jsonl"):
                    proof_jsonl.add(proof_path.relative_to(root).as_posix())
                # verify_tile hashes the B3DM and checks the descriptor digest,
                # now already bound to the host inventory; no duplicate hash.
                raw = atlas.verify_tile(source, manifest, lod0=True, backend=backend, prepared_source=prepared)
                require(raw.get("mappingVerified") is True and raw.get("pixelEqualityVerified") is True
                        and raw.get("lod0") is True, "raw_proof_incomplete")
                raw_digest.update(encoded({"b3dmRelativePath": tile["b3dmRelativePath"], "receipt": raw}) + b"\n")
                raw_faces += raw["faceRecords"]; raw_charts += raw["charts"]; raw_atlases += raw["atlases"]
                require(raw_faces <= 10_000_000, "candidate_face_budget_exceeded")
                index.verify_manifest(manifest)
        # SourceUvIndex performs its once-final retained-input check on exit.
        uv = index.receipt()
        require(uv.get("retainedProofInputsFinalCheckCompleted") is True
                and uv.get("sourceUvAssociationVerified") is True
                and uv.get("tiles") == len(tiles) and uv.get("declaredFaces") == raw_faces,
                "source_uv_final_check_incomplete")
        require({key for key in before_files if key.lower().endswith(".jsonl")}
                == {tile["b3dmRelativePath"][:-5] + MAPPING_SUFFIX for tile in tiles} | proof_jsonl,
                "lod0_unlisted_jsonl")
    finally:
        backend.close()

    # Per-tile raw proof checks are not enough: retain all LOD0 files through
    # the final tile and check that no earlier atlas/proof/B3DM changed.
    after_files, after_directories = inventory_tree(lod0, atlas)
    check_tree_sets(after_files, tiles)
    require(before_files == after_files and before_directories == after_directories, "lod0_inputs_changed")
    index.check_inputs()
    require(atlas.identity(source) == source_id and atlas.identity(inventory) == inventory_id,
            "host_inputs_changed")
    receipt = {
        "schemaVersion": 1, "scope": RECEIPT_SCOPE,
        "sourceObjSha256": actual_source_sha, "expectedLod0InventorySha256": inventory_sha,
        "lod0Tiles": len(tiles), "rawFaceRecords": raw_faces, "rawCharts": raw_charts,
        "rawAtlasReferences": raw_atlases, "orderedRawProofReceiptsSha256": raw_digest.hexdigest(),
        "rawAtlasPixelEqualityVerified": True, "sourceUvAssociationVerified": True,
        "reachableLod0ProofInventoryVerified": True, "retainedInputsFinalCheckCompleted": True,
        "sourceUv": uv, "originalGeometryCoverageVerified": False,
        "finalB3dmUvAssociationVerified": False, "finalKtxEquivalenceVerified": False,
    }
    receipt["receiptSha256"] = hashlib.sha256(b"ltds-recovery-raw-uv-receipt-v1\0" + encoded(receipt)).hexdigest()
    return receipt


@contextmanager
def quiet_proof_output():
    """Native decoder diagnostics can include paths; publish only static JSON."""
    sys.stdout.flush(); sys.stderr.flush()
    saved = [os.dup(1), os.dup(2)]
    try:
        with open(os.devnull, "wb") as sink:
            os.dup2(sink.fileno(), 1); os.dup2(sink.fileno(), 2)
            yield
    finally:
        try:
            sys.stdout.flush(); sys.stderr.flush()
        finally:
            os.dup2(saved[0], 1); os.dup2(saved[1], 2)
            os.close(saved[0]); os.close(saved[1])


class PrivateParser(argparse.ArgumentParser):
    def error(self, _message):
        raise RunnerError("invalid_arguments")


def main():
    try:
        parser = PrivateParser(add_help=False, allow_abbrev=False)
        parser.add_argument("--source-obj", required=True)
        parser.add_argument("--output", required=True)
        parser.add_argument("--expected-source-sha256", required=True)
        parser.add_argument("--expected-lod0-inventory", required=True)
        args = parser.parse_args()
        with quiet_proof_output():
            receipt = verify(args.source_obj, args.output, args.expected_source_sha256,
                             args.expected_lod0_inventory)
        print(encoded(receipt).decode("ascii"))
        return 0
    except BaseException as error:
        # Never expose exception messages from model parsers, GDAL or the OS.
        code = str(error) if isinstance(error, RunnerError) else "recovery_raw_uv_proof_failed"
        if not re.fullmatch(r"[a-z][a-z0-9_]{0,79}", code):
            code = "recovery_raw_uv_proof_failed"
        print(json.dumps({"schemaVersion": 1, "scope": RECEIPT_SCOPE, "error": code,
                          "rawAtlasPixelEqualityVerified": False, "sourceUvAssociationVerified": False},
                         sort_keys=True, separators=(",", ":")))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
