import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { streamToExactFile } from "../src/files.mjs";

function stream(...chunks) {
  return new ReadableStream({ start(controller) { for (const chunk of chunks) controller.enqueue(Buffer.from(chunk)); controller.close(); } });
}

test("streams an exact source to disk", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "ltds-renderer-test-"));
  try {
    const destination = path.join(directory, "source.bin");
    assert.equal(await streamToExactFile(stream("abc", "def"), destination, 6, 10), 6);
    assert.equal(await readFile(destination, "utf8"), "abcdef");
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("cancels before writing beyond the leased byte count", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "ltds-renderer-test-"));
  const destination = path.join(directory, "source.bin");
  try {
    await assert.rejects(streamToExactFile(stream("abcd", "efgh"), destination, 6, 10), { code: "source_size_mismatch" });
    await assert.rejects(readFile(destination));
  } finally { await rm(directory, { recursive: true, force: true }); }
});
