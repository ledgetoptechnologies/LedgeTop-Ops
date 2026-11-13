#!/usr/bin/env python3
"""Verify declared diffuse source-to-raw-atlas mapping, not geometry/KTX fidelity.

The converter receipt is untrusted. Source OBJ/MTL and raster bytes are read
independently. LOD0 requires exact RGBA crop pixels and unit texel scale. Coarse
mapping can be checked, but resampled pixels are expressly NOT verified.
"""
from __future__ import annotations

import argparse
from contextlib import contextmanager
import hashlib
import json
import math
import os
from pathlib import Path, PurePosixPath
import re
import sqlite3
import stat
import tempfile

POLICY = "bounded-texture-mapping-candidate-v1"
LINE_LIMIT = 16384
FILE_LIMIT = 2 * 1024**3
RECORD_LIMIT = 5_000_000
MAX_ATLASES = 4096
MAX_MATERIALS = 4096
NORMAL_ROLES = {"bump", "map_bump", "norm", "normal", "map_normal", "map_kn"}


class ProofError(ValueError):
    pass


def require(value, code):
    if not value:
        raise ProofError(code)


def integer(value, minimum=0, maximum=2**31 - 1):
    require(type(value) is int and minimum <= value <= maximum, "invalid_integer")
    return value


def number(value):
    require(type(value) in (int, float) and math.isfinite(value), "invalid_number")
    return value


def digest(value):
    require(isinstance(value, str) and re.fullmatch(r"[0-9a-f]{64}", value), "invalid_digest")
    return value


def identity(path):
    s = path.stat(follow_symlinks=False)
    require(stat.S_ISREG(s.st_mode), "not_regular_file")
    return stat_identity(s)


def stat_identity(s):
    # Windows Python stat and fstat expose different ctime meanings. Linux
    # qualification retains inode change time; Windows unit fixtures compare
    # device/inode/size/write time without pretending birth time is change time.
    return (s.st_dev, s.st_ino, s.st_size, s.st_mtime_ns,
            s.st_ctime_ns if os.name != "nt" else None)


def regular(root, relative):
    require(isinstance(relative, str) and relative and "\\" not in relative and ":" not in relative,
            "invalid_relative_path")
    p = PurePosixPath(relative)
    require(not p.is_absolute() and str(p) == relative and all(x not in (".", "..") for x in p.parts),
            "invalid_relative_path")
    root = Path(root).absolute()
    require(root.resolve() == root and root.is_dir() and not root.is_symlink(), "invalid_root")
    current = root
    for index, part in enumerate(p.parts):
        current = current / part
        s = current.lstat()
        require(not stat.S_ISLNK(s.st_mode), "symlink_forbidden")
        require(stat.S_ISREG(s.st_mode) if index == len(p.parts) - 1 else stat.S_ISDIR(s.st_mode),
                "invalid_file_type")
    return current


def basename(value):
    require(isinstance(value, str) and PurePosixPath(value).name == value and value not in ("", ".", "..")
            and "/" not in value and "\\" not in value and ":" not in value, "invalid_basename")
    return value


def hash_file(path):
    before = identity(path)
    h = hashlib.sha256()
    with checked_stream(path, before) as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            h.update(block)
    return h.hexdigest(), before


@contextmanager
def checked_stream(path, before):
    flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_BINARY", 0)
    with os.fdopen(os.open(path, flags), "rb") as stream:
        s = os.fstat(stream.fileno())
        require(stat_identity(s) == before, "file_changed")
        yield stream
        require(stat_identity(os.fstat(stream.fileno())) == before, "file_changed")
    require(identity(path) == before, "file_changed")


def json_object(raw):
    def pairs(items):
        result = {}
        for key, value in items:
            require(key not in result, "duplicate_json_key")
            result[key] = value
        return result
    result = json.loads(raw, object_pairs_hook=pairs,
                        parse_constant=lambda _: (_ for _ in ()).throw(ProofError("nonfinite_json")))
    require(isinstance(result, dict), "record_not_object")
    return result


def records(path):
    before = identity(path)
    require(before[2] <= FILE_LIMIT, "mapping_file_too_large")
    with checked_stream(path, before) as stream:
        for count in range(RECORD_LIMIT + 1):
            line = stream.readline(LINE_LIMIT + 1)
            if not line:
                break
            require(count < RECORD_LIMIT and len(line) <= LINE_LIMIT, "record_limit_exceeded")
            require(line.strip(), "empty_record")
            yield json_object(line)
        else:
            raise ProofError("record_limit_exceeded")
    require(identity(path) == before, "file_changed")


def text_lines(path):
    before = identity(path)
    require(before[2] <= FILE_LIMIT, "source_file_too_large")
    with checked_stream(path, before) as stream:
        while True:
            line = stream.readline(LINE_LIMIT + 1)
            if not line:
                break
            require(len(line) <= LINE_LIMIT, "source_line_too_large")
            yield line.decode("utf-8", errors="strict").split("#", 1)[0].strip()
    require(identity(path) == before, "file_changed")


def relative_from(root, base, name):
    # No options, escaping, absolute paths, traversal, or symlinks are inferred.
    require(isinstance(name, str) and name and not name.startswith("-") and "\\" not in name,
            "unsupported_texture_locator")
    candidate = base / name
    require(candidate.is_relative_to(root), "source_outside_root")
    return regular(root, candidate.relative_to(root).as_posix())


class GdalBackend:
    """Byte RGB/RGBA only; GDAL reads one bounded window row at a time."""
    def __init__(self):
        from osgeo import gdal
        self.gdal = gdal
        self.old_cache = gdal.GetCacheMax()
        gdal.SetCacheMax(16 * 1024**2)

    def close(self):
        self.gdal.SetCacheMax(self.old_cache)

    def open(self, path):
        gdal = self.gdal
        # Restrict decoder selection BEFORE opening: a .png filename can contain
        # a VRT that references unrelated files or remote resources. A later
        # GetDriver check alone does not fence those initial driver effects.
        ds = gdal.OpenEx(str(path), gdal.OF_RASTER | gdal.OF_READONLY,
                         allowed_drivers=["PNG"])
        require(ds is not None and ds.RasterCount in (3, 4), "unsupported_raster")
        require(ds.GetDriver().ShortName == "PNG", "only_png_pixel_proof_supported")
        expected = [gdal.GCI_RedBand, gdal.GCI_GreenBand, gdal.GCI_BlueBand, gdal.GCI_AlphaBand]
        for index in range(ds.RasterCount):
            band = ds.GetRasterBand(index + 1)
            require(band.DataType == gdal.GDT_Byte and band.GetColorInterpretation() == expected[index],
                    "unsupported_raster_bands")

        class Raster:
            width, height = ds.RasterXSize, ds.RasterYSize
            def row_rgba(self, x, y, width):
                result = bytearray(b"\xff" * (width * 4))
                for index in range(ds.RasterCount):
                    row = ds.GetRasterBand(index + 1).ReadRaster(x, y, width, 1, buf_type=gdal.GDT_Byte)
                    require(row is not None and len(row) == width, "raster_read_failed")
                    result[index::4] = row
                return bytes(result)
            def close(self):
                nonlocal ds
                ds = None
        return Raster()


def source_closure(source_obj, backend):
    root = source_obj.parent
    obj_sha, obj_id = hash_file(source_obj)
    mtls = []
    for line in text_lines(source_obj):
        parts = line.split(None, 1)
        if parts and parts[0] == "mtllib":
            require(len(parts) == 2, "material_library_missing")
            require(len(mtls) < MAX_MATERIALS, "too_many_material_libraries")
            mtls.append(relative_from(root, root, parts[1]))
    require(mtls and len(set(mtls)) == len(mtls), "missing_or_duplicate_material_library")
    textures, files = {}, {source_obj: obj_id}
    for mtl in mtls:
        _, files[mtl] = hash_file(mtl)
        material, has_diffuse = None, False
        for line in text_lines(mtl):
            if not line:
                continue
            parts = line.split(None, 1)
            key, value = parts[0].lower(), parts[1].strip() if len(parts) == 2 else ""
            require(key not in NORMAL_ROLES, "normal_or_bump_unsupported")
            require(not (key.startswith("map_") and key != "map_kd")
                    and key not in {"disp", "decal", "refl"}, "unsupported_material_map")
            if key == "newmtl":
                require(value, "missing_material_name")
                material, has_diffuse = value, False
            if key == "map_kd":
                require(material is not None and not has_diffuse, "duplicate_or_unowned_diffuse")
                has_diffuse = True
                image_path = relative_from(root, mtl.parent, value)
                sha, file_id = hash_file(image_path)
                raster = backend.open(image_path)
                try:
                    width, height = raster.width, raster.height
                    integer(width, 1, 8192); integer(height, 1, 8192)
                finally:
                    raster.close()
                require(identity(image_path) == file_id, "source_changed")
                require(len(textures) < MAX_MATERIALS or sha in textures, "too_many_materials")
                textures[sha] = (image_path, width, height)
                files[image_path] = file_id
    require(textures, "source_diffuse_missing")
    return obj_sha, textures, files


def verify_tile(source_obj, manifest_path, *, lod0=True, backend=None):
    owned_backend = backend is None
    backend = backend or GdalBackend()
    try:
        return _verify_tile(Path(source_obj).absolute(), Path(manifest_path).absolute(), lod0, backend)
    finally:
        if owned_backend:
            backend.close()


def _verify_tile(source_obj, manifest_path, lod0, backend):
    source_obj = regular(source_obj.parent, source_obj.name)
    manifest_path = regular(manifest_path.parent, manifest_path.name)
    require(identity(manifest_path)[2] <= LINE_LIMIT, "manifest_too_large")
    manifest_sha, manifest_id = hash_file(manifest_path)
    receipt = json_object(manifest_path.read_bytes())
    require(type(receipt.get("schemaVersion")) is int and receipt["schemaVersion"] == 1
            and receipt.get("policy") == POLICY, "unsupported_receipt")
    root = manifest_path.parent
    mapping = regular(root, basename(receipt.get("mappingIdentity")))
    b3dm = regular(root, basename(receipt.get("b3dmIdentity")))
    proof = regular(root, receipt.get("proofRelativePath"))
    mapping_sha, mapping_id = hash_file(mapping)
    b3dm_sha, b3dm_id = hash_file(b3dm)
    proof_sha, proof_id = hash_file(proof)
    require(mapping_sha == digest(receipt.get("mappingSha256")), "mapping_digest_mismatch")
    require(b3dm_sha == digest(receipt.get("b3dmSha256")), "b3dm_digest_mismatch")
    require(proof_sha == digest(receipt.get("proofManifestSha256")), "proof_digest_mismatch")
    obj_sha, sources, stable = source_closure(source_obj, backend)
    stable.update({manifest_path: manifest_id, mapping: mapping_id, b3dm: b3dm_id, proof: proof_id})
    atlases = {}
    for record in records(proof):
        require(type(record.get("schemaVersion")) is int and record["schemaVersion"] == 1, "unsupported_proof")
        name = basename(record.get("identity"))
        require(name not in atlases and len(atlases) < MAX_ATLASES, "duplicate_or_excess_atlas")
        path = regular(proof.parent, name)
        sha, file_id = hash_file(path)
        require(sha == digest(record.get("sha256")) and file_id[2] == integer(record.get("byteSize"), 1),
                "atlas_digest_or_size_mismatch")
        w, h = integer(record.get("width"), 1, 16384), integer(record.get("height"), 1, 16384)
        raster = backend.open(path)
        try:
            require((raster.width, raster.height) == (w, h), "atlas_dimensions_mismatch")
        finally:
            raster.close()
        atlases[name] = (path, sha, w, h)
        stable[path] = file_id
    require(atlases, "proof_atlas_missing")
    count, charts, mapped_atlases, atlas_records = 0, 0, set(), set()
    prefix = "LOD-0-" if lod0 else None
    expected_tile = None
    with tempfile.TemporaryDirectory(prefix="ltds-atlas-proof-") as scratch:
        ledger = sqlite3.connect(str(Path(scratch) / "identities.sqlite"))
        try:
            ledger.executescript("PRAGMA cache_size=-1024; PRAGMA journal_mode=OFF; PRAGMA temp_store=FILE; "
                                 "CREATE TABLE faces(id INTEGER PRIMARY KEY); "
                                 "CREATE TABLE charts(material INTEGER, chart INTEGER, description TEXT, PRIMARY KEY(material,chart));")
            for position, r in enumerate(records(mapping)):
                require(type(r.get("schemaVersion")) is int and r["schemaVersion"] == 1, "unsupported_mapping")
                kind = r.get("recordType")
                if position == 0:
                    require(kind == "source" and r.get("sourceBound") is True and r.get("policy") == POLICY
                            and r.get("sourceObjSha256") == obj_sha, "source_binding_mismatch")
                    continue
                if kind == "atlas":
                    name = basename(r.get("identity"))
                    require(name in atlases and name not in atlas_records, "duplicate_or_unknown_atlas_record")
                    _, sha, w, h = atlases[name]
                    require((r.get("sha256"), r.get("width"), r.get("height")) == (sha, w, h), "atlas_record_mismatch")
                    atlas_records.add(name)
                    continue
                require(kind == "face", "unexpected_mapping_record")
                tile = r.get("lodTileIdentity")
                require(isinstance(tile, str) and (tile.startswith(prefix) if lod0 else re.fullmatch(r"LOD-[1-9][0-9]*-.+", tile)),
                        "lod_scope_mismatch")
                require(expected_tile is None or expected_tile == tile, "mixed_tile_identity")
                expected_tile = tile
                require(r.get("normalSha256") is None, "normal_or_bump_unsupported")
                source_sha = digest(r.get("sourceSha256"))
                require(source_sha in sources, "source_not_in_diffuse_closure")
                image_path, sw, sh = sources[source_sha]
                require((integer(r.get("sourceWidth"), 1, 8192), integer(r.get("sourceHeight"), 1, 8192)) == (sw, sh),
                        "source_dimensions_mismatch")
                atlas_name = basename(r.get("atlasIdentity"))
                require(atlas_name in atlases, "atlas_not_in_proof")
                atlas_path, _, aw, ah = atlases[atlas_name]
                edge = integer(r.get("atlasEdge"), 1, 16384)
                require((aw, ah) == (edge, edge), "atlas_edge_mismatch")
                x, y = integer(r.get("cropX")), integer(r.get("cropTopY"))
                cw, ch = integer(r.get("cropWidth"), 1), integer(r.get("cropHeight"), 1)
                ax, ay = integer(r.get("atlasInnerX")), integer(r.get("atlasInnerY"))
                sx, sy = number(r.get("scaleX")), number(r.get("scaleY"))
                require(0 < sx <= 1 and 0 < sy <= 1 and (not lod0 or sx == sy == 1), "invalid_texel_scale")
                require(x + cw <= sw and y + ch <= sh and ax + cw * sx <= aw and ay + ch * sy <= ah,
                        "crop_or_placement_out_of_bounds")
                tu, tv = integer(r.get("sourceTileU"), -2**20, 2**20), integer(r.get("sourceTileV"), -2**20, 2**20)
                original, mapped = r.get("originalUv"), r.get("atlasUv")
                triangle = r.get("triangle")
                require(isinstance(original, list) and len(original) == 6 and isinstance(mapped, list) and len(mapped) == 6
                        and isinstance(triangle, list) and len(triangle) == 9, "invalid_face_arrays")
                for value in original + mapped + triangle:
                    number(value)
                for index in (0, 2, 4):
                    u, v = original[index] - tu, original[index + 1] - tv
                    require(-1e-4 <= u <= 1 + 1e-4 and -1e-4 <= v <= 1 + 1e-4, "source_uv_out_of_bounds")
                    expected_u = (ax + (u * sw - x) * sx) / edge
                    expected_v = 1 - (ay + ((1 - v) * sh - y) * sy) / edge
                    require(abs(mapped[index] - expected_u) <= 1e-9 and abs(mapped[index + 1] - expected_v) <= 1e-9,
                            "uv_affine_mismatch")
                    require(0 <= mapped[index] <= 1 and 0 <= mapped[index + 1] <= 1, "atlas_uv_out_of_bounds")
                face = integer(r.get("faceId")); material = integer(r.get("materialId")); chart = integer(r.get("chartId"))
                try:
                    ledger.execute("INSERT INTO faces VALUES(?)", (face,))
                except sqlite3.IntegrityError:
                    raise ProofError("duplicate_face_identity") from None
                description = json.dumps([source_sha, atlas_name, sw, sh, x, y, cw, ch, ax, ay, edge, sx, sy, tu, tv], separators=(",", ":"))
                prior = ledger.execute("SELECT description FROM charts WHERE material=? AND chart=?", (material, chart)).fetchone()
                if prior:
                    require(prior[0] == description, "contradictory_chart_identity")
                else:
                    ledger.execute("INSERT INTO charts VALUES(?,?,?)", (material, chart, description))
                    charts += 1
                    if lod0:
                        src, dst = backend.open(image_path), backend.open(atlas_path)
                        try:
                            for row in range(ch):
                                source_row = src.row_rgba(x, y + row, cw)
                                atlas_row = dst.row_rgba(ax, ay + row, cw)
                                require(len(source_row) == len(atlas_row) == cw * 4, "raster_read_failed")
                                require(source_row == atlas_row, "atlas_pixel_mismatch")
                        finally:
                            src.close(); dst.close()
                count += 1
                mapped_atlases.add(atlas_name)
            require(count > 0 and charts > 0, "mapping_faces_missing")
            require(set(atlases) == atlas_records == mapped_atlases, "atlas_closure_mismatch")
        finally:
            ledger.close()
    for path, before in stable.items():
        require(identity(path) == before, "file_changed")
    return {"schemaVersion": 1, "scope": "declared-diffuse-to-raw-atlas-uv-only", "mappingVerified": True,
            "pixelEqualityVerified": bool(lod0), "lod0": bool(lod0), "faceRecords": count,
            "charts": charts, "atlases": len(atlases), "manifestSha256": manifest_sha,
            "originalGeometryCoverageVerified": False, "finalKtxEquivalenceVerified": False}


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--source-obj", required=True)
    p.add_argument("--mapping-manifest", required=True)
    mode = p.add_mutually_exclusive_group(required=True)
    mode.add_argument("--lod0", action="store_true")
    mode.add_argument("--coarse", action="store_true")
    args = p.parse_args()
    try:
        print(json.dumps(verify_tile(args.source_obj, args.mapping_manifest, lod0=args.lod0), sort_keys=True))
    except Exception as error:
        code = str(error) if isinstance(error, ProofError) else type(error).__name__
        print(json.dumps({"mappingVerified": False, "error": code}))
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
