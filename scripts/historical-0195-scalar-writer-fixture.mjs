import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { gunzipSync } from "node:zlib";

const root = path.resolve(import.meta.dirname, "..");
const pins = Object.freeze([
  ["apps/operations/src/worker/native-directory-profile-writer.ts", "a2569ef120bacbc3cb9dcd2770c89a89289fc2ee", "20f2382e0019df9705dc8df6c9a7858a94f88c8af8dbd5636c42f821dfcb8cba"],
  ["apps/operations/src/worker/project-alpha-directory-materialization-read-source.ts", "527db7b590ea16b1269a56f755a3f055ad204c13", "cefd84e4f7b2d7687771838dd3ae9ea3c57b7b2652cc668839fc04347f0ef34d"],
]);
export function validateHistorical0195WriterFixture(bundle) {
  assert.equal(bundle.fixtureVersion, 1);
  assert.equal(bundle.sourceCommit, "217c27b5d095f6bb74b32ee6e574b4d7655e9fa1");
  assert.equal(bundle.sourceTree, "1f03ff95814b31430f402a7568cfe47161cb15c4");
  assert.equal(bundle.migrationCount, 195);
  assert.equal(bundle.finalMigration, "0195_client_hub_native_project_current_owner_observation.sql");
  assert.deepEqual(bundle.files.map(file => [file.path, file.gitBlob, file.sha256]), pins);
  return new Map(bundle.files.map(file => {
    const bytes = gunzipSync(Buffer.from(file.gzipBase64, "base64"), { maxOutputLength: 1_048_576 });
    assert.equal(crypto.createHash("sha256").update(bytes).digest("hex"), file.sha256);
    assert.equal(crypto.createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex"), file.gitBlob);
    return [file.path, bytes.toString("utf8")];
  }));
}

// Historical compatibility only. No Git, network, source rewriting, or runtime
// fallback: the complete two-file import closure comes from pinned test bytes.
export async function loadHistorical0195ScalarWriter() {
  const sources = validateHistorical0195WriterFixture(JSON.parse(fs.readFileSync(
    path.join(root, "apps/operations/test/fixtures/historical-0195-scalar-writer.json"), "utf8")));
  const { build } = createRequire(path.join(root, "apps/operations/package.json"))("esbuild");
  const built = await build({ entryPoints: [pins[0][0]], bundle: true, write: false, format: "esm", platform: "neutral",
    plugins: [{ name: "exact-historical-source", setup(plugin) {
      plugin.onResolve({ filter: /.*/ }, args => {
        const resolved = args.importer ? path.posix.join(path.posix.dirname(args.importer), args.path) + ".ts" : path.posix.normalize(args.path);
        assert(sources.has(resolved), `unreviewed historical writer dependency: ${resolved}`);
        return { path: resolved, namespace: "historical-0195" };
      });
      plugin.onLoad({ filter: /.*/, namespace: "historical-0195" }, args => ({ contents: sources.get(args.path), loader: "ts" }));
    } }], logLevel: "silent" });
  assert.equal(built.outputFiles.length, 1);
  return import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].contents).toString("base64")}`);
}
