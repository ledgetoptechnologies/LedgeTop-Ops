"""Small injected raster fixtures; no GDAL, image decoder or converter run."""
import copy
import importlib.util
import json
from pathlib import Path
import tempfile
import types
import unittest
from unittest import mock

MODULE = Path(__file__).parents[1] / "scripts" / "verify_atlas_proof.py"
SPEC = importlib.util.spec_from_file_location("verify_atlas_proof", MODULE)
proof = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(proof)


class FakeBackend:
    def open(self, path):
        data = json.loads(Path(path).read_text())
        class Raster:
            width, height = data["width"], data["height"]
            def row_rgba(self, x, y, width):
                result = bytearray()
                for pixel in data["pixels"][y][x:x + width]:
                    result.extend(pixel + [255] if len(pixel) == 3 else pixel)
                return bytes(result)
            def close(self):
                pass
        return Raster()


class AtlasProofTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="atlas-proof-unit-")
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.source = self.root / "source"
        self.source.mkdir()
        self.out = self.root / "output" / "LOD-0"
        self.out.mkdir(parents=True)
        self.obj = self.source / "model.obj"
        self.obj.write_text("mtllib model.mtl\nv 0 0 0\n")
        self.mtl = self.source / "model.mtl"
        self.mtl.write_text("newmtl roof\nmap_Kd source.png\n")
        self.src = self.source / "source.png"
        pixels = [[[x * 13, y * 17, (x + y) * 7] for x in range(8)] for y in range(8)]
        self.src.write_text(json.dumps({"width": 8, "height": 8, "pixels": pixels}))
        atlas_pixels = [[[0, 0, 0, 0] for _ in range(16)] for _ in range(16)]
        for y in range(4):
            for x in range(3):
                atlas_pixels[y + 2][x + 2] = pixels[y + 1][x + 2] + [255]
        self.proof_dir = self.out / "texture-proof" / "Mesh-1"
        self.proof_dir.mkdir(parents=True)
        self.atlas = self.proof_dir / "atlas.png"
        self.atlas.write_text(json.dumps({"width": 16, "height": 16, "pixels": atlas_pixels}))
        self.mapping = self.out / "Mesh-1.texture-mapping.jsonl"
        self.b3dm = self.out / "Mesh-1.b3dm"
        self.b3dm.write_bytes(b"synthetic-not-parsed-as-geometry")
        self.proof_manifest = self.proof_dir / "atlas-manifest.jsonl"
        self.manifest = self.out / "Mesh-1.texture-mapping-manifest.json"
        self.face = {
            "schemaVersion": 1, "recordType": "face", "lodTileIdentity": "LOD-0-Mesh-1",
            "chartId": 0, "faceId": 0, "materialId": 0,
            "sourceSha256": proof.hash_file(self.src)[0], "normalSha256": None,
            "sourceWidth": 8, "sourceHeight": 8,
            "cropX": 2, "cropTopY": 1, "cropWidth": 3, "cropHeight": 4,
            "sourceTileU": 0, "sourceTileV": 0,
            "atlasInnerX": 2, "atlasInnerY": 2, "atlasEdge": 16,
            "scaleX": 1, "scaleY": 1, "atlasIdentity": "atlas.png",
            "originalUv": [2 / 8, 7 / 8, 5 / 8, 7 / 8, 2 / 8, 3 / 8],
            "triangle": [0, 0, 0, 1, 0, 0, 0, 1, 0],
        }
        self.face["atlasUv"] = self.mapped_uv(self.face)
        self.faces = [self.face]
        self.refresh()

    def mapped_uv(self, face):
        uv = []
        for index in (0, 2, 4):
            u = face["originalUv"][index] - face["sourceTileU"]
            v = face["originalUv"][index + 1] - face["sourceTileV"]
            uv.extend([
                (face["atlasInnerX"] + (u * face["sourceWidth"] - face["cropX"]) * face["scaleX"]) / face["atlasEdge"],
                1 - (face["atlasInnerY"] + ((1 - v) * face["sourceHeight"] - face["cropTopY"]) * face["scaleY"]) / face["atlasEdge"],
            ])
        return uv

    def refresh(self):
        self.atlas_record = {"schemaVersion": 1, "recordType": "atlas", "identity": "atlas.png",
                             "sha256": proof.hash_file(self.atlas)[0], "width": 16, "height": 16}
        proof_record = {key: value for key, value in self.atlas_record.items() if key != "recordType"}
        proof_record["byteSize"] = self.atlas.stat().st_size
        self.proof_manifest.write_text(json.dumps(proof_record) + "\n")
        header = {"schemaVersion": 1, "recordType": "source", "policy": proof.POLICY,
                  "sourceObjSha256": proof.hash_file(self.obj)[0], "sourceBound": True}
        self.mapping.write_text("\n".join(json.dumps(row) for row in [header, *self.faces, self.atlas_record]) + "\n")
        receipt = {"schemaVersion": 1, "policy": proof.POLICY,
                   "proofRelativePath": "texture-proof/Mesh-1/atlas-manifest.jsonl",
                   "proofManifestSha256": proof.hash_file(self.proof_manifest)[0],
                   "mappingIdentity": self.mapping.name, "mappingSha256": proof.hash_file(self.mapping)[0],
                   "b3dmIdentity": self.b3dm.name, "b3dmSha256": proof.hash_file(self.b3dm)[0]}
        self.manifest.write_text(json.dumps(receipt))

    def verify(self, **kwargs):
        return proof.verify_tile(self.obj, self.manifest, backend=FakeBackend(), **kwargs)

    def fails(self, code, **kwargs):
        with self.assertRaisesRegex(proof.ProofError, "^" + code + "$"):
            self.verify(**kwargs)

    def test_exact_opaque_rgb_to_rgba_with_explicit_scope(self):
        result = self.verify()
        self.assertTrue(result["mappingVerified"])
        self.assertTrue(result["pixelEqualityVerified"])
        self.assertFalse(result["originalGeometryCoverageVerified"])
        self.assertFalse(result["finalKtxEquivalenceVerified"])

    def test_lod0_half_scale_rejected(self):
        self.face["scaleX"] = self.face["scaleY"] = 0.5
        self.face["atlasUv"] = self.mapped_uv(self.face)
        self.refresh()
        self.fails("invalid_texel_scale")

    def test_coarse_mapping_does_not_claim_pixel_equality(self):
        self.face["lodTileIdentity"] = "LOD-1-Mesh-1"
        self.face["scaleX"] = self.face["scaleY"] = 0.5
        self.face["atlasUv"] = self.mapped_uv(self.face)
        self.refresh()
        result = self.verify(lod0=False)
        self.assertTrue(result["mappingVerified"])
        self.assertFalse(result["pixelEqualityVerified"])

    def test_pixel_corruption_with_consistent_hash_receipts_rejected(self):
        data = json.loads(self.atlas.read_text())
        data["pixels"][2][2][0] ^= 1
        self.atlas.write_text(json.dumps(data))
        self.refresh()
        self.fails("atlas_pixel_mismatch")

    def test_opaque_alpha_corruption_rejected(self):
        data = json.loads(self.atlas.read_text())
        data["pixels"][2][2][3] = 0
        self.atlas.write_text(json.dumps(data))
        self.refresh()
        self.fails("atlas_pixel_mismatch")

    def test_rgba_source_alpha_preserved(self):
        data = json.loads(self.src.read_text())
        for row in data["pixels"]:
            for pixel in row:
                pixel.append(255)
        data["pixels"][1][2][3] = 77
        self.src.write_text(json.dumps(data))
        atlas = json.loads(self.atlas.read_text())
        atlas["pixels"][2][2][3] = 77
        self.atlas.write_text(json.dumps(atlas))
        self.face["sourceSha256"] = proof.hash_file(self.src)[0]
        self.refresh()
        self.assertTrue(self.verify()["pixelEqualityVerified"])

    def test_mapping_tamper_rejected(self):
        self.mapping.write_bytes(self.mapping.read_bytes() + b" ")
        self.fails("mapping_digest_mismatch")

    def test_source_not_whitelisted_by_mtl_rejected(self):
        self.face["sourceSha256"] = "a" * 64
        self.refresh()
        self.fails("source_not_in_diffuse_closure")

    def test_source_obj_tamper_rejected(self):
        self.obj.write_text(self.obj.read_text() + "v 1 0 0\n")
        self.fails("source_binding_mismatch")

    def test_uv_affine_tamper_rejected(self):
        self.face["atlasUv"][0] += 0.01
        self.refresh()
        self.fails("uv_affine_mismatch")

    def test_out_of_bounds_crop_rejected(self):
        self.face["cropWidth"] = 20
        self.refresh()
        self.fails("crop_or_placement_out_of_bounds")

    def test_out_of_bounds_atlas_placement_rejected(self):
        self.face["atlasInnerX"] = 15
        self.refresh()
        self.fails("crop_or_placement_out_of_bounds")

    def test_duplicate_face_rejected(self):
        self.faces.append(copy.deepcopy(self.face))
        self.refresh()
        self.fails("duplicate_face_identity")

    def test_contradictory_chart_identity_rejected(self):
        second = copy.deepcopy(self.face)
        second["faceId"] = 1
        second["atlasInnerX"] = 3
        second["atlasUv"] = self.mapped_uv(second)
        self.faces.append(second)
        self.refresh()
        self.fails("contradictory_chart_identity")

    def test_missing_faces_rejected(self):
        self.faces.clear()
        self.refresh()
        self.fails("mapping_faces_missing")

    def test_normal_bump_roles_rejected_even_with_tab(self):
        self.mtl.write_text(self.mtl.read_text() + "map_Bump\tsource.png\n")
        self.fails("normal_or_bump_unsupported")

    def test_normal_mapping_record_rejected(self):
        self.face["normalSha256"] = "b" * 64
        self.refresh()
        self.fails("normal_or_bump_unsupported")

    def test_path_traversal_rejected(self):
        receipt = json.loads(self.manifest.read_text())
        receipt["mappingIdentity"] = "../outside"
        self.manifest.write_text(json.dumps(receipt))
        self.fails("invalid_basename")

    def test_duplicate_json_key_rejected(self):
        self.manifest.write_text('{"schemaVersion":1,"schemaVersion":1}')
        self.fails("duplicate_json_key")

    def test_nonfinite_record_rejected(self):
        self.face["atlasUv"][0] = float("nan")
        self.refresh()
        self.fails("nonfinite_json")

    def test_large_line_rejected_without_unbounded_read(self):
        self.obj.write_bytes(b"x" * (proof.LINE_LIMIT + 1))
        self.fails("source_line_too_large")

    def test_missing_raw_proof_rejected(self):
        self.atlas.unlink()
        with self.assertRaises(FileNotFoundError):
            self.verify()

    def test_gdal_driver_allowlist_is_applied_before_open(self):
        gdal = types.SimpleNamespace(
            OF_RASTER=2, OF_READONLY=0, GetCacheMax=lambda: 123,
            SetCacheMax=mock.Mock(), OpenEx=mock.Mock(return_value=None))
        with mock.patch.dict('sys.modules', {'osgeo': types.SimpleNamespace(gdal=gdal)}):
            backend = proof.GdalBackend()
            try:
                with self.assertRaisesRegex(proof.ProofError, '^unsupported_raster$'):
                    backend.open(self.src)
            finally:
                backend.close()
        gdal.OpenEx.assert_called_once_with(str(self.src), 2, allowed_drivers=['PNG'])
        self.assertEqual(gdal.SetCacheMax.call_args_list[-1], mock.call(123))


if __name__ == "__main__":
    unittest.main()
