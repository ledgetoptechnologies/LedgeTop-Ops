import importlib.util
import json
import os
import unittest

spec = importlib.util.spec_from_file_location("receipts", os.path.join(os.path.dirname(__file__), "incoming-zip-receipts.py"))
receipts = importlib.util.module_from_spec(spec)
spec.loader.exec_module(receipts)

PROOF = {"claimToken": "11111111-1111-4111-8111-111111111111", "sha256": "a" * 64,
         "objectEtag": "abcd", "objectBytes": 4}


class ReceiptTests(unittest.TestCase):
    def test_bounded_pages_preserve_all_entries_and_stable_identity(self):
        entries = [{"path": f"folder/{index}-é.txt", "name": f"{index}-é.txt", "kind": "file", "size": 0} for index in range(1800)]
        document = {"status": "ready", "entries": entries}
        result = receipts.pages(document, PROOF)
        self.assertGreater(len(result), 1)
        self.assertEqual(result, receipts.pages(document, PROOF))
        self.assertEqual([entry for _, page in result for entry in page["entries"]], entries)
        for index, (action, page) in enumerate(result):
            self.assertEqual(action, "archive-inventory")
            self.assertEqual(page["page"], index)
            self.assertEqual(page["complete"], index == len(result) - 1)
            self.assertLessEqual(len(page["entries"]), 250)
            self.assertLessEqual(len(json.dumps(page, separators=(",", ":")).encode()), receipts.PAGE_BYTES)

    def test_empty_inventory_is_finalized(self):
        result = receipts.pages({"status": "ready", "entries": []}, PROOF)
        self.assertEqual(len(result), 1)
        self.assertTrue(result[0][1]["complete"])

    def test_parser_failure_is_separate_from_scan_proof(self):
        result = receipts.pages({"status": "failed", "category": "not_zip"}, PROOF)
        self.assertEqual(result[0][0], "archive-inventory-unavailable")
        self.assertEqual(result[0][1]["reason"], "not_zip")
        self.assertIn("inventoryId", result[0][1])
        self.assertEqual(result, receipts.pages({"status": "failed", "category": "not_zip"}, PROOF))

    def test_oversize_single_entry_is_not_published(self):
        with self.assertRaises(ValueError):
            receipts.pages({"status": "ready", "entries": [{"path": "x" * receipts.PAGE_BYTES}]}, PROOF)


if __name__ == "__main__":
    unittest.main()
