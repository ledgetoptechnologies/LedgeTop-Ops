import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const script = path.join(root, "scripts", "client-portal-joined-acceptance.mjs");

test("joined portal runner lists the implemented acceptance partitions", () => {
  const result = spawnSync(process.execPath, [script, "--list"], { cwd: root, encoding: "utf8", windowsHide: true });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^j1\toperations\ttwo-source identity and Client Hub isolation$/m);
  assert.match(result.stdout, /^j2\tclient\tProject Alpha metadata remains non-authorizing$/m);
  assert.match(result.stdout, /^j3\toperations\toperational memory copy-forward remains selective$/m);
  assert.match(result.stdout, /^j4\tclient\tmembership and delegated access remain independently revocable$/m);
  assert.match(result.stdout, /^j5\toperations\tnative delivery and notifications fail closed$/m);
  assert.match(result.stdout, /^j6\tclient\tfeedback and service requests remain independently authorized$/m);
});

test("joined portal runner rejects unknown or duplicate groups before starting Vitest", () => {
  for (const args of [["unknown"], ["j1", "j1"]]) {
    const result = spawnSync(process.execPath, [script, ...args], { cwd: root, encoding: "utf8", windowsHide: true });
    assert.equal(result.status, 2);
    assert.match(result.stderr, /Unknown or duplicate group/);
  }
});
