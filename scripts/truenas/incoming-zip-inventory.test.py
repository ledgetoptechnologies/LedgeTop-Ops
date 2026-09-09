#!/usr/bin/env python3
"""Regression coverage for the metadata-only Incoming ZIP inventory parser."""
from __future__ import annotations

import importlib.util
import io
import os
import struct
import sys
import tempfile
import unittest
import zipfile


SCRIPT = os.path.join(os.path.dirname(__file__), "incoming-zip-inventory.py")
SPEC = importlib.util.spec_from_file_location("incoming_zip_inventory", SCRIPT)
assert SPEC and SPEC.loader
inventory = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = inventory
SPEC.loader.exec_module(inventory)


def raw_zip(names: list[bytes], *, zip64: bool = False) -> bytes:
    directory = b""
    for name in names:
        directory += struct.pack("<I6H3I5H2I", 0x02014B50, 20, 20, 0, 0, 0, 0, 0, 0, 0, len(name), 0, 0, 0, 0, 0, 0) + name
    if not zip64:
        return directory + struct.pack("<I4H2IH", 0x06054B50, 0, 0, len(names), len(names), len(directory), 0, 0)
    record_offset = len(directory)
    record = struct.pack("<IQHHIIQQQQ", 0x06064B50, 44, 45, 45, 0, 0, len(names), len(names), len(directory), 0)
    locator = struct.pack("<IIQI", 0x07064B50, 0, record_offset, 1)
    eocd = struct.pack("<I4H2IH", 0x06054B50, 0, 0, 0xFFFF, 0xFFFF, 0xFFFFFFFF, 0xFFFFFFFF, 0)
    return directory + record + locator + eocd


class IncomingZipInventoryTest(unittest.TestCase):
    def inspect(self, payload: bytes, limits=None):
        return inventory.inspect_archive(io.BytesIO(payload), limits or inventory.Limits())

    def category(self, payload: bytes, limits=None):
        with self.assertRaises(inventory.InventoryError) as caught:
            self.inspect(payload, limits)
        return caught.exception.category

    def test_inventory_is_metadata_only_and_creates_virtual_folders(self):
        output = io.BytesIO()
        with zipfile.ZipFile(output, "w") as archive:
            archive.writestr("reports/secret.txt", b"do not expose this payload")
            archive.writestr("root.txt", b"another payload")
        result = self.inspect(output.getvalue())
        self.assertEqual(result["status"], "ready")
        self.assertEqual(result["entries"], [
            {"path": "reports", "name": "reports", "kind": "folder"},
            {"path": "reports/secret.txt", "name": "secret.txt", "kind": "file", "size": 26},
            {"path": "root.txt", "name": "root.txt", "kind": "file", "size": 15},
        ])
        self.assertNotIn("do not expose", repr(result))

    def test_zip64_directory_is_supported(self):
        self.assertEqual(self.inspect(raw_zip([b"a.txt"], zip64=True))["entries"][0]["path"], "a.txt")

    def test_zip64_disk_field_is_four_bytes_and_rejects_other_disks(self):
        extra = struct.pack("<HHI", 1, 4, 0)
        self.assertEqual(inventory._zip64_values(extra, 12, 24, 0, 0xFFFF), (12, 24))
        with self.assertRaises(inventory.InventoryError) as caught:
            inventory._zip64_values(struct.pack("<HHI", 1, 4, 1), 12, 24, 0, 0xFFFF)
        self.assertEqual(caught.exception.category, "multi_disk")
        ordinary = bytearray(raw_zip([b"a.txt"]))
        struct.pack_into("<H", ordinary, 34, 1)
        self.assertEqual(self.category(bytes(ordinary)), "multi_disk")

    def test_zip64_directory_cannot_overlap_end_record(self):
        payload = bytearray(raw_zip([b"a.txt"], zip64=True))
        record_offset = payload.index(inventory.ZIP64_EOCD)
        struct.pack_into("<Q", payload, record_offset + 40, record_offset + 1)
        self.assertEqual(self.category(bytes(payload)), "malformed_central_directory")

    def test_encrypted_and_special_unix_entries_are_rejected_honestly(self):
        encrypted = bytearray(raw_zip([b"encrypted"]))
        # Central directory flags begin at byte 8 in this synthetic record.
        struct.pack_into("<H", encrypted, 8, 1)
        self.assertEqual(self.category(bytes(encrypted)), "encrypted_entries")
        output = io.BytesIO()
        with zipfile.ZipFile(output, "w") as archive:
            fifo = zipfile.ZipInfo("pipe")
            fifo.create_system = 3
            fifo.external_attr = 0o010644 << 16
            archive.writestr(fifo, b"")
        self.assertEqual(self.category(output.getvalue()), "unsafe_special_file")

    def test_traversal_absolute_backslash_and_nul_are_rejected(self):
        for name in (b"../escape", b"/absolute", b"C:/drive", b"folder\\file", b"nul\x00name"):
            with self.subTest(name=name):
                self.assertEqual(self.category(raw_zip([name])), "invalid_path")

    def test_symlink_duplicate_and_conflicting_paths_are_rejected(self):
        output = io.BytesIO()
        with zipfile.ZipFile(output, "w") as archive:
            link = zipfile.ZipInfo("link")
            link.create_system = 3
            link.external_attr = 0o120777 << 16
            archive.writestr(link, "target")
        self.assertEqual(self.category(output.getvalue()), "unsafe_symlink")
        self.assertEqual(self.category(raw_zip([b"same", b"same"])), "duplicate_path")
        self.assertEqual(self.category(raw_zip([b"node", b"node/child"])), "conflicting_path")
        self.assertEqual(self.category(raw_zip([b"node/child", b"node"])), "conflicting_path")

    def test_bounded_count_directory_bytes_metadata_and_depth(self):
        payload = raw_zip([b"one", b"two"])
        self.assertEqual(self.category(payload, inventory.Limits(max_entries=1, max_central_directory_bytes=1000, max_metadata_bytes=1000, max_depth=8)), "entry_limit")
        self.assertEqual(self.category(payload, inventory.Limits(max_entries=8, max_central_directory_bytes=46, max_metadata_bytes=1000, max_depth=8)), "central_directory_too_large")
        self.assertEqual(self.category(raw_zip([b"long-name"]), inventory.Limits(max_entries=8, max_central_directory_bytes=1000, max_metadata_bytes=1, max_depth=8)), "metadata_limit")
        self.assertEqual(self.category(raw_zip([b"a/b/c"]), inventory.Limits(max_entries=8, max_central_directory_bytes=1000, max_metadata_bytes=1000, max_depth=2)), "invalid_path")
        # These synthetic EOCDs intentionally have no directory bytes.  The
        # limit must be rejected from the bounded EOCD preflight before any
        # entry loop (and therefore before an unbounded directory allocation).
        count_preflight = struct.pack("<I4H2IH", 0x06054B50, 0, 0, 2, 2, 0, 0, 0)
        self.assertEqual(self.category(count_preflight, inventory.Limits(max_entries=1, max_central_directory_bytes=1000, max_metadata_bytes=1000, max_depth=8)), "entry_limit")
        bytes_preflight = struct.pack("<I4H2IH", 0x06054B50, 0, 0, 0, 0, 4097, 0, 0)
        self.assertEqual(self.category(bytes_preflight, inventory.Limits(max_entries=8, max_central_directory_bytes=4096, max_metadata_bytes=1000, max_depth=8)), "central_directory_too_large")
        # One member can create parent rows, but those rows remain capped too.
        self.assertEqual(self.category(raw_zip([b"a/b"]), inventory.Limits(max_entries=1, max_central_directory_bytes=1000, max_metadata_bytes=1000, max_depth=8)), "entry_limit")

    def test_malformed_and_non_zip_have_bounded_errors(self):
        self.assertEqual(self.category(b"not an archive"), "not_zip")
        malformed = raw_zip([b"ok"])[:-10]
        self.assertIn(self.category(malformed), {"not_zip", "malformed_central_directory"})

    def test_cli_does_not_echo_local_path_on_failure(self):
        with tempfile.TemporaryDirectory() as directory:
            archive = os.path.join(directory, "private-name.zip")
            with open(archive, "wb") as output:
                output.write(raw_zip([b"../bad"]))
            import subprocess
            completed = subprocess.run([sys.executable, SCRIPT, archive], capture_output=True, text=True, check=False)
            self.assertEqual(completed.returncode, 2)
            self.assertNotIn(directory, completed.stdout + completed.stderr)

    def test_cli_missing_archive_is_bounded_and_does_not_echo_path(self):
        missing = "/private/missing-incoming-archive.zip"
        import subprocess
        completed = subprocess.run([sys.executable, SCRIPT, missing], capture_output=True, text=True, check=False)
        self.assertEqual(completed.returncode, 2)
        self.assertEqual(completed.stdout.strip(), '{"status":"failed","category":"io_error"}')
        self.assertNotIn(missing, completed.stderr)


if __name__ == "__main__":
    unittest.main()
