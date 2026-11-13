#!/usr/bin/env python3
"""Associate declared LOD0 UVs with original diffuse OBJ faces, independently.

No global geometry coverage, emitted B3DM attribute, KTX or Viewer acceptance
claim. Canonical triangulated, positive-index, [0,1]-UV OBJ input only. SQLite
Rtree and bounded caches keep the original-face index reusable across tiles.
"""
from __future__ import annotations

import argparse
from functools import lru_cache
import hashlib
import importlib.util
import json
import math
from pathlib import Path
import sqlite3
import struct
import tempfile

_SPEC = importlib.util.spec_from_file_location("atlas_proof_helpers", Path(__file__).with_name("verify_atlas_proof.py"))
atlas = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(atlas)
ProofError, require = atlas.ProofError, atlas.require
TRIANGLE = struct.Struct("<15d")


def sub(a, b):
    return tuple(x - y for x, y in zip(a, b))


def cross(a, b):
    return (a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0])


def dot(a, b):
    return sum(x * y for x, y in zip(a, b))


def barycentric(point, xyz, position_tolerance, barycentric_tolerance):
    a, b, c = xyz[:3], xyz[3:6], xyz[6:9]
    normal = cross(sub(b, a), sub(c, a))
    length = math.hypot(*normal)
    if length == 0:
        return None
    if abs(dot(sub(point, a), normal)) / length > position_tolerance:
        return None
    # Dominant-axis projection avoids the cancellation-prone Gram determinant.
    drop = max(range(3), key=lambda k: abs(normal[k]))
    i, j = [k for k in range(3) if k != drop]
    determinant = (b[i] - a[i]) * (c[j] - a[j]) - (b[j] - a[j]) * (c[i] - a[i])
    if determinant == 0 or not math.isfinite(determinant):
        return None
    wb = ((point[i] - a[i]) * (c[j] - a[j]) - (point[j] - a[j]) * (c[i] - a[i])) / determinant
    wc = ((b[i] - a[i]) * (point[j] - a[j]) - (b[j] - a[j]) * (point[i] - a[i])) / determinant
    wa = 1 - wb - wc
    if any(not math.isfinite(w) or w < -barycentric_tolerance or w > 1 + barycentric_tolerance for w in (wa, wb, wc)):
        return None
    return wa, wb, wc


class SourceUvIndex:
    def __init__(self, source_obj, *, backend=None, position_tolerance=1e-7,
                 barycentric_tolerance=1e-8, texel_tolerance=1e-4,
                 max_source_faces=5_000_000, max_candidates=4096, max_total_candidates=50_000_000,
                 max_tiles=4096, max_declared_faces=10_000_000):
        self.source_obj = Path(source_obj).absolute()
        self.backend = backend
        self.position_tolerance = atlas.number(position_tolerance)
        self.barycentric_tolerance = atlas.number(barycentric_tolerance)
        self.texel_tolerance = atlas.number(texel_tolerance)
        require(0 < self.position_tolerance <= 1e-4 and 0 < self.barycentric_tolerance <= 1e-6
                and 0 < self.texel_tolerance <= 1e-2, "source_uv_tolerance_out_of_profile")
        self.max_source_faces = atlas.integer(max_source_faces, 1, 5_000_000)
        self.max_candidates = atlas.integer(max_candidates, 1, 4096)
        self.max_total_candidates = atlas.integer(max_total_candidates, 1, 50_000_000)
        self.max_tiles = atlas.integer(max_tiles, 1, 4096)
        self.max_declared_faces = atlas.integer(max_declared_faces, 1, 10_000_000)
        self.candidate_checks = self.declared_faces = self.tile_count = self.source_faces = 0
        self.degenerate_source_faces = self.degenerate_declared_faces = 0
        self.scratch = self.db = None
        self.stable = {}
        self.retained_inputs = {}
        self.retained_inputs_final_checked = False
        self.failed = False
        self.mapping_inputs_hash = hashlib.sha256(b"ltds-source-uv-mapping-inputs-v1\0")

    def __enter__(self):
        try:
            self._open()
            return self
        except BaseException:
            self.close()
            raise

    def __exit__(self, exception_type, *_):
        try:
            if exception_type is None and not self.failed:
                self.check_inputs()
                for path, before in self.retained_inputs.items():
                    require(atlas.identity(path) == before, "source_uv_input_changed")
                self.retained_inputs_final_checked = True
        except BaseException:
            self.failed = True
            raise
        finally:
            self.close()

    def close(self):
        if self.db is not None:
            self.db.close()
            self.db = None
        if self.scratch is not None:
            self.scratch.cleanup()
            self.scratch = None

    def check_inputs(self):
        # Only original immutable closure here. Prior tile proof paths are
        # checked once at context exit, avoiding quadratic retained-path scans.
        for path, before in self.stable.items():
            require(atlas.identity(path) == before, "source_uv_input_changed")

    def _open(self):
        self.source_obj = atlas.regular(self.source_obj.parent, self.source_obj.name)
        owned_backend = self.backend is None
        backend = self.backend or atlas.GdalBackend()
        try:
            self.obj_sha, self.textures, self.stable = atlas.source_closure(self.source_obj, backend)
        finally:
            if owned_backend:
                backend.close()
        materials = self._materials()
        self.source_closure_sha = hashlib.sha256(json.dumps({
            "objSha256": self.obj_sha, "materialLibraries": self.material_library_hashes,
            "materials": materials,
            "textureDimensions": {sha: [item[1], item[2]] for sha, item in self.textures.items()},
        }, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
        self.scratch = tempfile.TemporaryDirectory(prefix="ltds-source-uv-")
        self.db = sqlite3.connect(str(Path(self.scratch.name) / "faces.sqlite"))
        self.db.executescript("PRAGMA cache_size=-8192; PRAGMA journal_mode=OFF; PRAGMA synchronous=OFF; "
                             "PRAGMA temp_store=FILE; "
                             "CREATE TABLE vertices(id INTEGER PRIMARY KEY,x REAL,y REAL,z REAL); "
                             "CREATE TABLE uvs(id INTEGER PRIMARY KEY,u REAL,v REAL); "
                             "CREATE TABLE materials(id INTEGER PRIMARY KEY,sha TEXT); "
                             "CREATE TABLE faces(id INTEGER PRIMARY KEY,material INTEGER,data BLOB,degenerate INTEGER); "
                             "CREATE VIRTUAL TABLE bounds USING rtree(id,minx,maxx,miny,maxy,minz,maxz); "
                             "CREATE TABLE seen_tiles(id TEXT PRIMARY KEY); "
                             "CREATE TABLE declared(tile TEXT,face INTEGER,PRIMARY KEY(tile,face));")
        material_ids = {}
        for name, sha in materials.items():
            material_ids[name] = len(material_ids)
            self.db.execute("INSERT INTO materials VALUES(?,?)", (material_ids[name], sha))

        @lru_cache(maxsize=32768)
        def vertex(index):
            row = self.db.execute("SELECT x,y,z FROM vertices WHERE id=?", (index,)).fetchone()
            require(row is not None, "source_vertex_missing")
            return row

        @lru_cache(maxsize=32768)
        def uv(index):
            row = self.db.execute("SELECT u,v FROM uvs WHERE id=?", (index,)).fetchone()
            require(row is not None, "source_uv_missing")
            return row

        vcount = uvcount = 0
        current = None
        try:
            for line in atlas.text_lines(self.source_obj):
                if not line:
                    continue
                parts = line.split()
                kind = parts[0]
                if kind == "v":
                    require(len(parts) in (4, 7), "source_vertex_layout_unsupported")
                    numbers = [atlas.number(float(x)) for x in parts[1:]]
                    require(all(abs(x) <= 1e30 for x in numbers[:3]), "source_coordinate_outside_rtree_profile")
                    vcount += 1
                    require(vcount <= 10_000_000, "source_vertex_budget_exceeded")
                    self.db.execute("INSERT INTO vertices VALUES(?,?,?,?)", (vcount, *numbers[:3]))
                elif kind == "vt":
                    require(len(parts) == 3, "source_uv_layout_unsupported")
                    values = [atlas.number(float(x)) for x in parts[1:]]
                    require(all(0 <= x <= 1 for x in values), "wrapped_source_uv_unsupported")
                    uvcount += 1
                    require(uvcount <= 10_000_000, "source_uv_budget_exceeded")
                    self.db.execute("INSERT INTO uvs VALUES(?,?,?)", (uvcount, *values))
                elif kind == "vn":
                    require(len(parts) == 4, "source_normal_layout_unsupported")
                    for x in parts[1:]:
                        atlas.number(float(x))
                elif kind == "usemtl":
                    require(len(parts) == 2 and parts[1] in material_ids, "source_material_missing")
                    current = material_ids[parts[1]]
                elif kind == "f":
                    require(len(parts) == 4, "nontriangulated_source_unsupported")
                    require(current is not None, "source_face_material_missing")
                    positions, texcoords = [], []
                    for item in parts[1:]:
                        indices = item.split("/")
                        require(len(indices) in (2, 3) and indices[0].isdigit() and indices[1].isdigit()
                                and (len(indices) == 2 or not indices[2] or indices[2].isdigit()),
                                "source_face_index_layout_unsupported")
                        vi, ti = int(indices[0]), int(indices[1])
                        require(vi > 0 and ti > 0, "nonpositive_source_index_unsupported")
                        positions.extend(vertex(vi)); texcoords.extend(uv(ti))
                    self.source_faces += 1
                    require(self.source_faces <= self.max_source_faces, "source_face_budget_exceeded")
                    n = cross(sub(positions[3:6], positions[:3]), sub(positions[6:9], positions[:3]))
                    degenerate = math.hypot(*n) == 0
                    self.degenerate_source_faces += int(degenerate)
                    self.db.execute("INSERT INTO faces VALUES(?,?,?,?)",
                                    (self.source_faces, current, TRIANGLE.pack(*positions, *texcoords), int(degenerate)))
                    lo = [min(positions[k::3]) for k in range(3)]
                    hi = [max(positions[k::3]) for k in range(3)]
                    self.db.execute("INSERT INTO bounds VALUES(?,?,?,?,?,?,?)",
                                    (self.source_faces, lo[0], hi[0], lo[1], hi[1], lo[2], hi[2]))
                elif kind not in {"mtllib", "o", "g", "s"}:
                    raise ProofError("source_obj_directive_unsupported")
            require(self.source_faces > 0, "source_faces_missing")
            self.db.commit()
            self.check_inputs()
        finally:
            vertex.cache_clear(); uv.cache_clear()

    def _materials(self):
        result = {}
        self.material_library_hashes = {}
        for line in atlas.text_lines(self.source_obj):
            parts = line.split(None, 1)
            if not parts or parts[0] != "mtllib":
                continue
            require(len(parts) == 2, "source_material_library_missing")
            mtl = atlas.relative_from(self.source_obj.parent, self.source_obj.parent, parts[1])
            mtl_sha, mtl_id = atlas.hash_file(mtl)
            require(mtl in self.stable and self.stable[mtl] == mtl_id, "source_diffuse_closure_changed")
            self.material_library_hashes[mtl.relative_to(self.source_obj.parent).as_posix()] = mtl_sha
            current = None
            for mline in atlas.text_lines(mtl):
                tokens = mline.split(None, 1)
                if not tokens:
                    continue
                if tokens[0].lower() == "newmtl":
                    require(len(tokens) == 2 and tokens[1] not in result, "duplicate_source_material")
                    require(len(result) < atlas.MAX_MATERIALS, "source_material_budget_exceeded")
                    current = tokens[1]
                    result[current] = None
                elif tokens[0].lower() == "map_kd":
                    require(current is not None and len(tokens) == 2 and result[current] is None,
                            "source_diffuse_material_ambiguous")
                    image = atlas.relative_from(self.source_obj.parent, mtl.parent, tokens[1])
                    sha, before = atlas.hash_file(image)
                    require(image in self.stable and self.stable[image] == before and sha in self.textures,
                            "source_diffuse_closure_changed")
                    result[current] = sha
        require(result and all(result.values()), "source_material_diffuse_missing")
        return result

    def _associate(self, triangle, declared_uv, source_sha):
        require(len(triangle) == 9 and len(declared_uv) == 6, "declared_face_layout_invalid")
        for value in triangle + declared_uv:
            atlas.number(value)
        require(source_sha in self.textures, "source_uv_texture_not_in_closure")
        _, width, height = self.textures[source_sha]
        tol = self.position_tolerance
        low = [min(triangle[k::3]) for k in range(3)]
        high = [max(triangle[k::3]) for k in range(3)]
        rows = self.db.execute(
            "SELECT f.data,f.degenerate,m.sha FROM bounds b JOIN faces f ON f.id=b.id "
            "JOIN materials m ON m.id=f.material WHERE b.minx<=? AND b.maxx>=? "
            "AND b.miny<=? AND b.maxy>=? AND b.minz<=? AND b.maxz>=? LIMIT ?",
            (low[0] + tol, high[0] - tol, low[1] + tol, high[1] - tol,
             low[2] + tol, high[2] - tol, self.max_candidates + 1)).fetchall()
        require(len(rows) <= self.max_candidates, "source_uv_candidate_budget_exceeded")
        self.candidate_checks += len(rows)
        require(self.candidate_checks <= self.max_total_candidates, "source_uv_total_candidate_budget_exceeded")
        declared_normal = cross(sub(triangle[3:6], triangle[:3]), sub(triangle[6:9], triangle[:3]))
        declared_degenerate = math.hypot(*declared_normal) == 0
        if declared_degenerate:
            self.degenerate_declared_faces += 1
        reference = None
        for packed, degenerate, candidate_sha in rows:
            if degenerate or candidate_sha != source_sha:
                continue  # counted explicitly; cannot supply a unique barycentric basis
            values = TRIANGLE.unpack(packed)
            xyz, uvs = values[:9], values[9:]
            normal = cross(sub(xyz[3:6], xyz[:3]), sub(xyz[6:9], xyz[:3]))
            if not declared_degenerate and dot(normal, declared_normal) <= 0:
                continue
            expected = []
            for offset in (0, 3, 6):
                weights = barycentric(triangle[offset:offset + 3], xyz, tol, self.barycentric_tolerance)
                if weights is None:
                    break
                expected.extend([sum(weights[k] * uvs[k * 2 + dim] for k in range(3)) for dim in (0, 1)])
            if len(expected) != 6:
                continue
            if reference is not None:
                require(all(abs(expected[i] - reference[i]) * (width if i % 2 == 0 else height)
                            <= self.texel_tolerance for i in range(6)), "source_uv_ambiguous_face_mapping")
            reference = expected
        require(reference is not None, "source_uv_material_or_geometry_mismatch")
        require(all(abs(declared_uv[i] - reference[i]) * (width if i % 2 == 0 else height)
                    <= self.texel_tolerance for i in range(6)), "source_uv_interpolation_mismatch")

    def verify_manifest(self, manifest_path):
        require(not self.failed, "source_uv_index_failed")
        try:
            return self._verify_manifest(manifest_path)
        except BaseException:
            self.failed = True
            raise

    def _verify_manifest(self, manifest_path):
        require(self.db is not None, "source_uv_index_not_open")
        require(self.tile_count < self.max_tiles, "source_uv_tile_budget_exceeded")
        require(self.declared_faces < self.max_declared_faces, "source_uv_declared_face_budget_exceeded")
        self.check_inputs()
        path = Path(manifest_path).absolute()
        path = atlas.regular(path.parent, path.name)
        require(atlas.identity(path)[2] <= atlas.LINE_LIMIT, "source_uv_manifest_too_large")
        manifest_sha, manifest_id = atlas.hash_file(path)
        receipt = atlas.json_object(path.read_bytes())
        require(type(receipt.get("schemaVersion")) is int and receipt["schemaVersion"] == 1
                and receipt.get("policy") == atlas.POLICY, "source_uv_receipt_unsupported")
        mapping = atlas.regular(path.parent, atlas.basename(receipt.get("mappingIdentity")))
        require(path not in self.retained_inputs and mapping not in self.retained_inputs,
                "source_uv_reused_proof_path")
        sha, mapping_id = atlas.hash_file(mapping)
        require(sha == atlas.digest(receipt.get("mappingSha256")), "source_uv_mapping_digest_mismatch")
        count, tile = 0, None
        for position, record in enumerate(atlas.records(mapping)):
            require(type(record.get("schemaVersion")) is int and record["schemaVersion"] == 1,
                    "source_uv_record_unsupported")
            kind = record.get("recordType")
            if position == 0:
                require(kind == "source" and record.get("sourceBound") is True
                        and record.get("sourceObjSha256") == self.obj_sha and record.get("policy") == atlas.POLICY,
                        "source_uv_original_obj_binding_mismatch")
                continue
            if kind == "atlas":
                continue  # independent raw-atlas verifier validates those records and pixel closure
            require(kind == "face", "source_uv_record_unsupported")
            incoming = record.get("lodTileIdentity")
            require(isinstance(incoming, str) and incoming.startswith("LOD-0-") and "/" not in incoming
                    and "\\" not in incoming, "source_uv_lod0_only")
            if tile is None:
                tile = incoming
                try:
                    self.db.execute("INSERT INTO seen_tiles VALUES(?)", (tile,))
                except sqlite3.IntegrityError:
                    raise ProofError("source_uv_duplicate_tile") from None
            require(incoming == tile, "source_uv_mixed_tile")
            require(self.declared_faces + count < self.max_declared_faces, "source_uv_declared_face_budget_exceeded")
            face_id = atlas.integer(record.get("faceId"))
            try:
                self.db.execute("INSERT INTO declared VALUES(?,?)", (tile, face_id))
            except sqlite3.IntegrityError:
                raise ProofError("source_uv_duplicate_declared_face") from None
            require(record.get("normalSha256") is None, "source_uv_diffuse_only")
            triangle, uv = record.get("triangle"), record.get("originalUv")
            require(isinstance(triangle, list) and isinstance(uv, list), "declared_face_layout_invalid")
            self._associate(triangle, uv, atlas.digest(record.get("sourceSha256")))
            count += 1
        require(count > 0, "source_uv_declared_faces_missing")
        require(atlas.identity(path) == manifest_id and atlas.identity(mapping) == mapping_id, "source_uv_input_changed")
        self.retained_inputs.update({path: manifest_id, mapping: mapping_id})
        self.check_inputs()
        self.declared_faces += count
        self.tile_count += 1
        self.mapping_inputs_hash.update(json.dumps({"manifestSha256": manifest_sha, "mappingSha256": sha},
                                                  sort_keys=True, separators=(",", ":")).encode() + b"\n")
        return self.receipt()

    def receipt(self):
        require(not self.failed, "source_uv_index_failed")
        self.check_inputs()
        require(self.tile_count > 0, "source_uv_no_verified_tiles")
        return {"schemaVersion": 1, "scope": "original-diffuse-face-to-declared-lod0-uv-only",
                "sourceUvAssociationVerified": True, "sourceObjSha256": self.obj_sha,
                "retainedProofInputsFinalCheckCompleted": self.retained_inputs_final_checked,
                "sourceClosureSha256": self.source_closure_sha,
                "orderedMappingInputsSha256": self.mapping_inputs_hash.hexdigest(),
                "sourceFaces": self.source_faces, "declaredFaces": self.declared_faces, "tiles": self.tile_count,
                "degenerateSourceFacesNotUsedAsBasis": self.degenerate_source_faces,
                "degenerateDeclaredFaces": self.degenerate_declared_faces,
                "candidateChecks": self.candidate_checks,
                "limits": {"sourceFaces": self.max_source_faces, "candidatesPerTriangle": self.max_candidates,
                           "totalCandidateChecks": self.max_total_candidates,
                           "tiles": self.max_tiles, "declaredFaces": self.max_declared_faces},
                "tolerances": {"positionSourceUnits": self.position_tolerance,
                               "barycentric": self.barycentric_tolerance, "uvSourceTexels": self.texel_tolerance},
                "originalGeometryCoverageVerified": False, "finalB3dmUvAssociationVerified": False,
                "finalKtxEquivalenceVerified": False}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source-obj", required=True)
    parser.add_argument("--mapping-manifest", action="append", required=True)
    args = parser.parse_args()
    try:
        with SourceUvIndex(args.source_obj) as index:
            for manifest in args.mapping_manifest:
                index.verify_manifest(manifest)
        # Publish a success receipt only after the once-final retained-input
        # identity check and index cleanup have completed without error.
        print(json.dumps(index.receipt(), sort_keys=True))
    except Exception as error:
        code = str(error) if isinstance(error, ProofError) else type(error).__name__
        print(json.dumps({"sourceUvAssociationVerified": False, "error": code}))
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
