import { createHash } from "node:crypto";
import { copyFileSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

// Vitest-only frozen204 source. No node:test hooks or production compiler changes.
export function createReviewed204TestRoot(repositoryRoot: string): string {
  const source = join(repositoryRoot, "apps/operations/migrations");
  const names = readdirSync(source).filter(name => /^\d{4}_.+\.sql$/.test(name)
    && Number(name.slice(0, 4)) <= 204).sort();
  const sha = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
  if (names.length !== 204 || names.at(-1) !== "0204_native_project_archive_restore.sql"
    || sha(names.join("\n")) !== "53b90b4be27e6cf723dbe45bfdf55208803a9fa18b9ad01ee709f84f31fd6b36") throw Error("Exact reviewed204 source names required");
  const contents = names.map(name => {
    const file = join(source, name), stat = lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink()) throw Error("Regular reviewed204 migration required");
    return `${name}\0${sha(readFileSync(file))}`;
  });
  if (sha(contents.join("\n")) !== "85a531f7ee5c8ee03fc1b6d7cfb8ce466f2d283c564d974a8d3d7bc9f57e4afe") throw Error("Exact reviewed204 source bytes required");
  const root = mkdtempSync(join(tmpdir(), "ltds-vitest-reviewed204-"));
  const destination = join(root, "apps/operations/migrations");
  mkdirSync(destination, { recursive: true });
  for (const name of names) copyFileSync(join(source, name), join(destination, name));
  // Every returned cleanup target is an absolute, owned immediate temp child.
  const stat = lstatSync(root);
  if (resolve(root) !== root || dirname(root) !== resolve(tmpdir())
    || !/^ltds-vitest-reviewed204-/.test(basename(root))
    || !stat.isDirectory() || stat.isSymbolicLink()) throw Error("Unsafe reviewed204 test cleanup root");
  return root;
}
