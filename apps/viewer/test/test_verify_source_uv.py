import copy
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest import mock

MODULE = Path(__file__).parents[1] / 'scripts' / 'verify_source_uv.py'
SPEC = importlib.util.spec_from_file_location('source_uv', MODULE)
source_uv = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(source_uv)
atlas = source_uv.atlas


class TinyHeaderBackend:
    def open(self, path):
        metadata = json.loads(Path(path).read_text())
        class Header:
            width, height = metadata['width'], metadata['height']
            def close(self):
                pass
        return Header()


class SourceUvTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix='source-uv-unit-')
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.obj = self.root / 'model.obj'
        self.obj_text = ('mtllib model.mtl\nv 0 0 0\nv 2 0 0\nv 0 2 0\n'
                         'vt 0 0\nvt 1 0\nvt 0 1\nusemtl roof\nf 1/1 2/2 3/3\n')
        self.obj.write_text(self.obj_text)
        self.mtl = self.root / 'model.mtl'
        self.mtl.write_text('newmtl roof\nmap_Kd roof.png\n')
        self.texture = self.root / 'roof.png'
        self.texture.write_text(json.dumps({'width': 8, 'height': 8}))
        self.face = {'schemaVersion': 1, 'recordType': 'face', 'lodTileIdentity': 'LOD-0-Mesh-1',
                     'faceId': 0, 'sourceSha256': atlas.hash_file(self.texture)[0], 'normalSha256': None,
                     'triangle': [0.25, 0.25, 0, 0.75, 0.25, 0, 0.25, 0.75, 0],
                     'originalUv': [0.125, 0.125, 0.375, 0.125, 0.125, 0.375]}
        self.manifest = self.write_tile('Mesh-1', [self.face])

    def write_tile(self, name, faces, source_sha=None):
        mapping = self.root / (name + '.texture-mapping.jsonl')
        header = {'schemaVersion': 1, 'recordType': 'source', 'policy': atlas.POLICY,
                  'sourceBound': True, 'sourceObjSha256': source_sha or atlas.hash_file(self.obj)[0]}
        mapping.write_text('\n'.join(json.dumps(r) for r in [header, *faces]) + '\n')
        manifest = self.root / (name + '.texture-mapping-manifest.json')
        manifest.write_text(json.dumps({'schemaVersion': 1, 'policy': atlas.POLICY,
                                       'mappingIdentity': mapping.name, 'mappingSha256': atlas.hash_file(mapping)[0]}))
        return manifest

    def index(self, **kwargs):
        return source_uv.SourceUvIndex(self.obj, backend=TinyHeaderBackend(), **kwargs)

    def fails(self, code):
        with self.index() as index:
            with self.assertRaisesRegex(atlas.ProofError, '^' + code + '$'):
                index.verify_manifest(self.manifest)
            with self.assertRaisesRegex(atlas.ProofError, '^source_uv_index_failed$'):
                index.receipt()

    def test_subtriangle_barycentric_uv_and_explicit_scope(self):
        with self.index() as index:
            scratch = index.scratch.name
            result = index.verify_manifest(self.manifest)
            self.assertTrue(result['sourceUvAssociationVerified'])
            self.assertFalse(result['originalGeometryCoverageVerified'])
            self.assertFalse(result['finalB3dmUvAssociationVerified'])
            self.assertFalse(result['finalKtxEquivalenceVerified'])
            self.assertEqual(result['sourceFaces'], 1)
            self.assertEqual(len(result['sourceClosureSha256']), 64)
            self.assertEqual(len(result['orderedMappingInputsSha256']), 64)
        self.assertFalse(Path(scratch).exists())

    def test_index_reused_across_tiles(self):
        second = copy.deepcopy(self.face)
        second['lodTileIdentity'] = 'LOD-0-Mesh-2'
        other = self.write_tile('Mesh-2', [second])
        with self.index() as index:
            original_db = index.db
            index.verify_manifest(self.manifest)
            result = index.verify_manifest(other)
            self.assertIs(index.db, original_db)
            self.assertEqual(result['tiles'], 2)
            self.assertEqual(result['sourceFaces'], 1)
            self.assertEqual(result['declaredFaces'], 2)

    def test_prepared_source_builds_once_across_tiles_and_multiple_indexes(self):
        second = copy.deepcopy(self.face)
        second['lodTileIdentity'] = 'LOD-0-Mesh-2'
        other = self.write_tile('Mesh-2', [second])
        with mock.patch.object(atlas, 'source_closure', wraps=atlas.source_closure) as build:
            prepared = atlas.PreparedSourceClosure(self.obj, backend=TinyHeaderBackend())
            for _ in range(2):
                with self.index(prepared_source=prepared) as index:
                    original_db = index.db
                    index.verify_manifest(self.manifest)
                    result = index.verify_manifest(other)
                    self.assertIs(index.db, original_db)
                    self.assertEqual(result['tiles'], 2)
                    self.assertEqual(result['declaredFaces'], 2)
                    self.assertFalse(result['retainedProofInputsFinalCheckCompleted'])
                self.assertTrue(index.receipt()['retainedProofInputsFinalCheckCompleted'])
            self.assertEqual(build.call_count, 1)

    def test_prepared_source_rejects_wrong_path_and_serialized_or_subclass_objects(self):
        class Derived(atlas.PreparedSourceClosure):
            pass
        prepared = atlas.PreparedSourceClosure(self.obj, backend=TinyHeaderBackend())
        derived = Derived(self.obj, backend=TinyHeaderBackend())
        for candidate in (True, {'sourceBound': True}, prepared.snapshot(self.obj), derived):
            with self.subTest(kind=type(candidate).__name__):
                with self.assertRaisesRegex(atlas.ProofError, '^prepared_source_type_invalid$'):
                    self.index(prepared_source=candidate)
        other = self.root / 'other.obj'
        other.write_bytes(self.obj.read_bytes())
        with self.assertRaisesRegex(atlas.ProofError, '^prepared_source_path_mismatch$'):
            with source_uv.SourceUvIndex(other, backend=TinyHeaderBackend(), prepared_source=prepared):
                pass

    def test_prepared_source_change_still_fails_final_exit_and_cleans_index(self):
        prepared = atlas.PreparedSourceClosure(self.obj, backend=TinyHeaderBackend())
        with self.assertRaisesRegex(atlas.ProofError, '^source_uv_input_changed$'):
            with self.index(prepared_source=prepared) as index:
                scratch = index.scratch.name
                index.verify_manifest(self.manifest)
                self.texture.write_text(self.texture.read_text() + ' ')
        self.assertFalse(Path(scratch).exists())
        with self.assertRaisesRegex(atlas.ProofError, '^source_uv_index_failed$'):
            index.receipt()
        with self.assertRaisesRegex(atlas.ProofError, '^prepared_source_changed$'):
            prepared.snapshot(self.obj)

    def test_prepared_source_keeps_prior_tile_final_check_once_and_rejects_tamper(self):
        second = copy.deepcopy(self.face)
        second['lodTileIdentity'] = 'LOD-0-Mesh-2'
        other = self.write_tile('Mesh-2', [second])
        prepared = atlas.PreparedSourceClosure(self.obj, backend=TinyHeaderBackend())
        calls = {}
        original_identity = atlas.identity
        def observed(path):
            path = Path(path)
            calls[path] = calls.get(path, 0) + 1
            return original_identity(path)
        with mock.patch.object(atlas, 'identity', side_effect=observed):
            with self.assertRaisesRegex(atlas.ProofError, '^source_uv_input_changed$'):
                with self.index(prepared_source=prepared) as index:
                    index.verify_manifest(self.manifest)
                    first_calls = calls[self.manifest]
                    index.verify_manifest(other)
                    index.receipt()
                    self.assertEqual(calls[self.manifest], first_calls)
                    self.manifest.write_text(self.manifest.read_text() + ' ')
            self.assertEqual(calls[self.manifest], first_calls + 1)
        with self.assertRaisesRegex(atlas.ProofError, '^source_uv_index_failed$'):
            index.receipt()

    def test_wrong_uv_rejected(self):
        self.face['originalUv'][0] += 0.1
        self.manifest = self.write_tile('Mesh-1', [self.face])
        self.fails('source_uv_interpolation_mismatch')

    def test_wrong_material_even_when_other_texture_is_in_closure(self):
        other = self.root / 'other.png'
        other.write_text(json.dumps({'width': 8, 'height': 8, 'different': True}))
        self.mtl.write_text(self.mtl.read_text() + 'newmtl other\nmap_Kd other.png\n')
        self.face['sourceSha256'] = atlas.hash_file(other)[0]
        self.manifest = self.write_tile('Mesh-1', [self.face])
        self.fails('source_uv_material_or_geometry_mismatch')

    def test_barycentric_outside_triangle_rejected(self):
        self.face['triangle'][3:6] = [1.5, 1.5, 0]
        self.manifest = self.write_tile('Mesh-1', [self.face])
        self.fails('source_uv_material_or_geometry_mismatch')

    def test_noncoplanar_rejected(self):
        self.face['triangle'][2] = 0.1
        self.manifest = self.write_tile('Mesh-1', [self.face])
        self.fails('source_uv_material_or_geometry_mismatch')

    def test_reversed_winding_rejected(self):
        t, u = self.face['triangle'], self.face['originalUv']
        self.face['triangle'] = t[:3] + t[6:9] + t[3:6]
        self.face['originalUv'] = u[:2] + u[4:6] + u[2:4]
        self.manifest = self.write_tile('Mesh-1', [self.face])
        self.fails('source_uv_material_or_geometry_mismatch')

    def test_coincident_faces_with_different_uvs_are_ambiguous(self):
        self.obj.write_text(self.obj_text.replace('usemtl roof', 'vt 0.25 0.25\nvt 0.75 0.25\nvt 0.25 0.75\nusemtl roof')
                            + 'f 1/4 2/5 3/6\n')
        self.manifest = self.write_tile('Mesh-1', [self.face])
        self.fails('source_uv_ambiguous_face_mapping')

    def test_equivalent_coincident_faces_not_arbitrarily_disallowed(self):
        self.obj.write_text(self.obj_text + 'f 1/1 2/2 3/3\n')
        self.manifest = self.write_tile('Mesh-1', [self.face])
        with self.index() as index:
            self.assertTrue(index.verify_manifest(self.manifest)['sourceUvAssociationVerified'])

    def test_wrong_original_obj_digest_rejected(self):
        self.manifest = self.write_tile('Mesh-1', [self.face], source_sha='a' * 64)
        self.fails('source_uv_original_obj_binding_mismatch')

    def test_input_change_after_index_rejected(self):
        with self.index() as index:
            self.obj.write_text(self.obj_text + '# changed\n')
            with self.assertRaisesRegex(atlas.ProofError, '^source_uv_input_changed$'):
                index.verify_manifest(self.manifest)

    def test_input_change_after_last_check_rejected_at_context_exit(self):
        scratch = None
        with self.assertRaisesRegex(atlas.ProofError, '^source_uv_input_changed$'):
            with self.index() as index:
                scratch = index.scratch.name
                index.verify_manifest(self.manifest)
                self.texture.write_text(self.texture.read_text() + ' ')
        self.assertFalse(Path(scratch).exists())

    def test_nonfinite_declared_coordinate_rejected(self):
        self.face['triangle'][0] = float('nan')
        self.manifest = self.write_tile('Mesh-1', [self.face])
        self.fails('nonfinite_json')

    def test_quad_source_explicitly_rejected(self):
        self.obj.write_text(self.obj_text.replace('f 1/1 2/2 3/3', 'f 1/1 2/2 3/3 1/1'))
        with self.assertRaisesRegex(atlas.ProofError, '^nontriangulated_source_unsupported$'):
            with self.index():
                pass

    def test_wrapped_uv_source_explicitly_rejected(self):
        self.obj.write_text(self.obj_text.replace('vt 1 0', 'vt 1.5 0'))
        with self.assertRaisesRegex(atlas.ProofError, '^wrapped_source_uv_unsupported$'):
            with self.index():
                pass

    def test_negative_indices_explicitly_rejected(self):
        self.obj.write_text(self.obj_text.replace('f 1/1', 'f -3/1'))
        with self.assertRaisesRegex(atlas.ProofError, '^source_face_index_layout_unsupported$'):
            with self.index():
                pass

    def test_candidate_budget_holds_instead_of_truncating(self):
        self.obj.write_text(self.obj_text + 'f 1/1 2/2 3/3\n')
        self.manifest = self.write_tile('Mesh-1', [self.face])
        with self.index(max_candidates=1) as index:
            with self.assertRaisesRegex(atlas.ProofError, '^source_uv_candidate_budget_exceeded$'):
                index.verify_manifest(self.manifest)

    def test_total_candidate_budget_holds(self):
        second = copy.deepcopy(self.face)
        second['lodTileIdentity'] = 'LOD-0-Mesh-2'
        other = self.write_tile('Mesh-2', [second])
        with self.index(max_total_candidates=1) as index:
            index.verify_manifest(self.manifest)
            with self.assertRaisesRegex(atlas.ProofError, '^source_uv_total_candidate_budget_exceeded$'):
                index.verify_manifest(other)

    def test_degenerate_source_faces_counted_not_used_as_basis(self):
        self.obj.write_text(self.obj_text + 'f 1/1 2/2 2/2\n')
        self.manifest = self.write_tile('Mesh-1', [self.face])
        with self.index() as index:
            result = index.verify_manifest(self.manifest)
            self.assertEqual(result['degenerateSourceFacesNotUsedAsBasis'], 1)
            self.assertTrue(result['sourceUvAssociationVerified'])

    def test_duplicate_declared_face_rejected(self):
        self.manifest = self.write_tile('Mesh-1', [self.face, self.face])
        self.fails('source_uv_duplicate_declared_face')

    def test_tile_budget_holds_before_new_tile_insertion(self):
        second = copy.deepcopy(self.face)
        second['lodTileIdentity'] = 'LOD-0-Mesh-2'
        other = self.write_tile('Mesh-2', [second])
        with self.index(max_tiles=1) as index:
            index.verify_manifest(self.manifest)
            with self.assertRaisesRegex(atlas.ProofError, '^source_uv_tile_budget_exceeded$'):
                index.verify_manifest(other)
            self.assertEqual(index.db.execute('SELECT count(*) FROM seen_tiles').fetchone()[0], 1)

    def test_declared_face_budget_holds_before_insertion_and_association(self):
        second = copy.deepcopy(self.face)
        second['faceId'] = 1
        self.manifest = self.write_tile('Mesh-1', [self.face, second])
        with self.index(max_declared_faces=1) as index:
            with self.assertRaisesRegex(atlas.ProofError, '^source_uv_declared_face_budget_exceeded$'):
                index.verify_manifest(self.manifest)
            self.assertEqual(index.db.execute('SELECT count(*) FROM declared').fetchone()[0], 1)
            self.assertEqual(index.candidate_checks, 1)

    def test_prior_tile_inputs_checked_once_at_final_exit(self):
        second = copy.deepcopy(self.face)
        second['lodTileIdentity'] = 'LOD-0-Mesh-2'
        other = self.write_tile('Mesh-2', [second])
        original_identity = atlas.identity
        calls = {}
        def observed(path):
            path = Path(path)
            calls[path] = calls.get(path, 0) + 1
            return original_identity(path)
        with mock.patch.object(atlas, 'identity', side_effect=observed):
            with self.index() as index:
                result = index.verify_manifest(self.manifest)
                first_calls = calls[self.manifest]
                self.assertFalse(result['retainedProofInputsFinalCheckCompleted'])
                index.verify_manifest(other)
                index.receipt()
                self.assertEqual(calls[self.manifest], first_calls)
            self.assertEqual(calls[self.manifest], first_calls + 1)
            self.assertTrue(index.receipt()['retainedProofInputsFinalCheckCompleted'])

    def test_prior_tile_change_is_detected_at_final_exit(self):
        second = copy.deepcopy(self.face)
        second['lodTileIdentity'] = 'LOD-0-Mesh-2'
        other = self.write_tile('Mesh-2', [second])
        with self.assertRaisesRegex(atlas.ProofError, '^source_uv_input_changed$'):
            with self.index() as index:
                index.verify_manifest(self.manifest)
                index.verify_manifest(other)
                self.manifest.write_text(self.manifest.read_text() + ' ')
        with self.assertRaisesRegex(atlas.ProofError, '^source_uv_index_failed$'):
            index.receipt()


if __name__ == '__main__':
    unittest.main()
