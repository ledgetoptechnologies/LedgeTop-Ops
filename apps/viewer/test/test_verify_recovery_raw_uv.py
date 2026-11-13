"""Inventory/metadata guards only: no complete proof, decoder, GDAL or models."""
import copy
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest import mock


SCRIPTS = Path(__file__).parents[1] / 'scripts'


def load(name):
    spec = importlib.util.spec_from_file_location(name, SCRIPTS / (name + '.py'))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


runner = load('verify_recovery_raw_uv')
atlas = load('verify_atlas_proof')


class RecoveryInventoryTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix='recovery-inventory-unit-')
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.inventory = self.root / 'host-inventory.json'
        self.lod0 = self.root / 'LOD-0'
        self.lod0.mkdir()
        self.tiles = [self.tile('Mesh-1')]

    def tile(self, name):
        return {'b3dmRelativePath': 'LOD-0/' + name + '.b3dm',
                'manifestRelativePath': 'LOD-0/' + name + runner.MANIFEST_SUFFIX,
                'b3dmSha256': 'a' * 64}

    def document(self, tiles=None):
        return {'schemaVersion': 1, 'scope': runner.INVENTORY_SCOPE,
                'tiles': copy.deepcopy(self.tiles if tiles is None else tiles)}

    def read(self, document):
        self.inventory.write_text(json.dumps(document), encoding='utf-8')
        return runner.load_inventory(self.inventory, atlas)

    def rejects(self, document, code):
        with self.assertRaisesRegex(runner.RunnerError, '^' + code + '$'):
            self.read(document)

    def metadata_files(self):
        # Deliberately empty placeholders: never presented as verified models.
        for name in ('Mesh-1.b3dm', 'Mesh-1' + runner.MANIFEST_SUFFIX,
                     'Mesh-1' + runner.MAPPING_SUFFIX):
            (self.lod0 / name).touch()
        return runner.inventory_tree(self.lod0, atlas)[0]

    def test_inventory_binds_exact_bytes_and_canonical_ascii_order(self):
        document = self.document([self.tile('Mesh-10'), self.tile('Mesh-2')])
        tiles, digest, before = self.read(document)
        self.assertEqual(tiles, document['tiles'])
        self.assertEqual(digest, hashlib.sha256(self.inventory.read_bytes()).hexdigest())
        self.assertEqual(before, atlas.identity(self.inventory))
        self.rejects(self.document(list(reversed(tiles))), 'inventory_order_invalid')

    def test_inventory_root_and_tile_schemas_are_closed(self):
        for key, value in [('schemaVersion', True), ('schemaVersion', 1.0),
                           ('schemaVersion', 2), ('scope', 'other')]:
            with self.subTest(key=key, value=value):
                document = self.document(); document[key] = value
                self.rejects(document, 'inventory_schema_unsupported')
        document = self.document(); document['extra'] = True
        self.rejects(document, 'inventory_schema_unsupported')
        for mutate in ('missing', 'extra'):
            document = self.document()
            if mutate == 'missing':
                del document['tiles'][0]['b3dmSha256']
            else:
                document['tiles'][0]['verified'] = True
            self.rejects(document, 'inventory_tile_schema_unsupported')

    def test_duplicate_json_keys_fail_before_inventory_acceptance(self):
        self.inventory.write_text('{"schemaVersion":1,"schemaVersion":1}', encoding='utf-8')
        with self.assertRaisesRegex(atlas.ProofError, '^duplicate_json_key$'):
            runner.load_inventory(self.inventory, atlas)

    def test_duplicate_exact_and_casefolded_tile_pairs_are_rejected(self):
        for tiles in ([self.tile('Mesh-1'), self.tile('Mesh-1')],
                      [self.tile('Mesh-1'), self.tile('mesh-1')]):
            with self.subTest(names=[tile['b3dmRelativePath'] for tile in tiles]):
                self.rejects(self.document(tiles), 'duplicate_inventory_tile')

    def test_paths_require_canonical_relative_ascii_lod0_profile(self):
        invalid = [('LOD-0/../Mesh-1.b3dm', 'invalid_inventory_path'),
                   ('/LOD-0/Mesh-1.b3dm', 'invalid_inventory_path'),
                   ('LOD-0//Mesh-1.b3dm', 'invalid_inventory_path'),
                   ('LOD-0\\Mesh-1.b3dm', 'invalid_inventory_path'),
                   ('LOD-0/C:Mesh-1.b3dm', 'invalid_inventory_path'),
                   ('LOD-0/Mesh\x00-1.b3dm', 'invalid_inventory_path'),
                   ('LOD-1/Mesh-1.b3dm', 'inventory_lod0_layout_unsupported'),
                   ('LOD-0/nested/Mesh-1.b3dm', 'inventory_lod0_layout_unsupported'),
                   ('LOD-0/Mesh-1.B3DM', 'inventory_lod0_layout_unsupported'),
                   ('LOD-0/Mesh 1.b3dm', 'inventory_lod0_layout_unsupported'),
                   ('LOD-0/Mesh-\u00e9.b3dm', 'inventory_lod0_layout_unsupported')]
        for value, code in invalid:
            with self.subTest(value=value):
                document = self.document(); document['tiles'][0]['b3dmRelativePath'] = value
                self.rejects(document, code)

    def test_manifest_must_be_the_exact_paired_name_and_safe_path(self):
        document = self.document()
        document['tiles'][0]['manifestRelativePath'] = 'LOD-0/Other' + runner.MANIFEST_SUFFIX
        self.rejects(document, 'inventory_pair_mismatch')
        document['tiles'][0]['manifestRelativePath'] = 'LOD-0/../Other' + runner.MANIFEST_SUFFIX
        self.rejects(document, 'invalid_inventory_path')

    def test_digest_requires_exact_lowercase_sha256_string(self):
        for value in ('a' * 63, 'a' * 65, 'A' * 64, 'g' * 64, 1, True, None):
            with self.subTest(value=value):
                document = self.document(); document['tiles'][0]['b3dmSha256'] = value
                self.rejects(document, 'invalid_expected_digest')

    def test_empty_excess_and_wrong_type_tile_lists_are_rejected(self):
        for value in ([], {}, None, [self.tile('Mesh-1')] * (runner.MAX_TILES + 1)):
            with self.subTest(kind=type(value).__name__):
                document = self.document(); document['tiles'] = value
                self.rejects(document, 'inventory_tile_limit')

    def test_inventory_read_is_size_bounded_before_json_parsing(self):
        self.inventory.write_bytes(b' ' * 17)
        with mock.patch.object(runner, 'MAX_INVENTORY_BYTES', 16):
            with self.assertRaisesRegex(runner.RunnerError, '^inventory_size_limit$'):
                runner.load_inventory(self.inventory, atlas)

    def test_actual_tree_has_exact_b3dm_manifest_and_mapping_sets(self):
        files = self.metadata_files()
        runner.check_tree_sets(files, self.tiles)
        cases = [('LOD-0/Mesh-1.b3dm', 'LOD-0/Extra.b3dm', 'lod0_b3dm_inventory_mismatch'),
                 ('LOD-0/Mesh-1' + runner.MANIFEST_SUFFIX,
                  'LOD-0/Extra' + runner.MANIFEST_SUFFIX, 'lod0_manifest_inventory_mismatch'),
                 ('LOD-0/Mesh-1' + runner.MAPPING_SUFFIX,
                  'LOD-0/Extra' + runner.MAPPING_SUFFIX, 'lod0_mapping_inventory_mismatch')]
        for missing, extra, code in cases:
            for mutation in ('missing', 'extra', 'casevariant'):
                with self.subTest(code=code, mutation=mutation):
                    changed = dict(files)
                    if mutation == 'missing':
                        del changed[missing]
                    else:
                        changed[extra if mutation == 'extra' else extra.upper()] = ()
                    with self.assertRaisesRegex(runner.RunnerError, '^' + code + '$'):
                        runner.check_tree_sets(changed, self.tiles)

    def test_tree_snapshot_records_nested_files_and_changes_without_opening_payloads(self):
        self.metadata_files()
        nested = self.lod0 / 'texture-proof' / 'Mesh-1'
        nested.mkdir(parents=True)
        payload = nested / 'atlas.png'
        payload.write_bytes(b'not decoded')
        before_files, before_dirs = runner.inventory_tree(self.lod0, atlas)
        self.assertIn('LOD-0/texture-proof/Mesh-1/atlas.png', before_files)
        self.assertIn(nested, before_dirs)
        payload.write_bytes(b'changed, still not decoded')
        after_files, _ = runner.inventory_tree(self.lod0, atlas)
        self.assertNotEqual(before_files, after_files)

    def test_tree_entry_and_depth_budgets_fail_instead_of_truncating(self):
        self.metadata_files()
        with mock.patch.object(runner, 'MAX_ENTRIES', 2):
            with self.assertRaisesRegex(runner.RunnerError, '^lod0_entry_limit$'):
                runner.inventory_tree(self.lod0, atlas)
        (self.lod0 / 'nested').mkdir()
        with mock.patch.object(runner, 'MAX_DEPTH', 0):
            with self.assertRaisesRegex(runner.RunnerError, '^lod0_depth_limit$'):
                runner.inventory_tree(self.lod0, atlas)

    def symlink(self, target, link, directory=False):
        try:
            link.symlink_to(target, target_is_directory=directory)
        except (OSError, NotImplementedError) as error:
            if os.name == 'nt' or isinstance(error, NotImplementedError):
                self.skipTest('host cannot create test symlinks')
            raise

    def test_tree_refuses_file_symlink(self):
        outside = self.root / 'outside'; outside.touch()
        self.symlink(outside, self.lod0 / 'link')
        with self.assertRaisesRegex(runner.RunnerError, '^lod0_link_or_special_file$'):
            runner.inventory_tree(self.lod0, atlas)

    def test_tree_refuses_directory_symlink(self):
        outside = self.root / 'outside'; outside.mkdir()
        self.symlink(outside, self.lod0 / 'link', directory=True)
        with self.assertRaisesRegex(runner.RunnerError, '^lod0_link_or_special_file$'):
            runner.inventory_tree(self.lod0, atlas)

    @unittest.skipUnless(hasattr(os, 'mkfifo'), 'host has no FIFO creation API')
    def test_tree_refuses_fifo_without_opening_it(self):
        os.mkfifo(self.lod0 / 'pipe')
        with self.assertRaisesRegex(runner.RunnerError, '^lod0_link_or_special_file$'):
            runner.inventory_tree(self.lod0, atlas)


if __name__ == '__main__':
    unittest.main()
