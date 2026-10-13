import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { loadHistorical0195ScalarWriter, validateHistorical0195WriterFixture } from "./historical-0195-scalar-writer-fixture.mjs";
const bundle = JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname,
  "../apps/operations/test/fixtures/historical-0195-scalar-writer.json"), "utf8"));
test("historical writer validates exact source provenance, inventory and both content hashes", () => {
  assert.equal(validateHistorical0195WriterFixture(bundle).size, 2);
  for (const mutate of [
    value => { value.sourceCommit = "0".repeat(40); },
    value => { value.sourceTree = "0".repeat(40); },
    value => { value.migrationCount = 203; },
    value => { value.files.pop(); },
    value => { value.files[0].gitBlob = "0".repeat(40); },
    value => { value.files[0].sha256 = "0".repeat(64); },
    value => { value.files[0].gzipBase64 = value.files[1].gzipBase64; },
  ]) {
    const changed = structuredClone(bundle); mutate(changed);
    assert.throws(() => validateHistorical0195WriterFixture(changed));
  }
});
test("pinned historical writer loads offline without rewriting current source", async () => {
  const loaded = await loadHistorical0195ScalarWriter();
  assert.equal(typeof loaded.writeNativeDirectoryProfile, "function");
});
