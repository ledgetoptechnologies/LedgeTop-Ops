/// <reference lib="webworker" />
import { sha256Blob } from "./incremental-sha256";

type HashRequest = { id: string; blob: Blob };

self.onmessage = (event: MessageEvent<HashRequest>) => {
  const { id, blob } = event.data;
  void sha256Blob(blob, completed => self.postMessage({ id, type: "progress", completed }))
    .then(sha256 => self.postMessage({ id, type: "complete", sha256 }))
    .catch(error => self.postMessage({ id, type: "error", message: error instanceof Error ? error.message : "File hashing failed" }));
};

export {};
