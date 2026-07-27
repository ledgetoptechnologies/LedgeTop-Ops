import type {
  CloudProvider,
  CloudProviderAdapter,
  CloudTransferEnv,
  CloudTransferItem,
} from "../types";
import { DropboxClient } from "./dropbox";
import { GoogleDriveClient } from "./google-drive";

const CHUNK_SIZE = 8 * 1024 * 1024;

function accessToken(credential: { accessToken: string }): string {
  if (!credential.accessToken) throw new Error("authorization-expired");
  return credential.accessToken;
}

async function sourceChunk(
  env: CloudTransferEnv,
  item: CloudTransferItem,
  offset: number,
  length: number,
): Promise<Uint8Array<ArrayBuffer>> {
  const object = await env.DATA_BUCKET.get(item.source_key, {
    range: { offset, length },
    onlyIf: { etagMatches: item.source_etag },
  });
  if (!object || !("body" in object)) throw new Error("source-changed");
  const bytes = await object.arrayBuffer();
  return new Uint8Array(bytes);
}

function dropboxPath(item: CloudTransferItem, destination: unknown): string {
  const root = typeof destination === "object" && destination
    ? (destination as Record<string, unknown>).path
    : undefined;
  const prefix = typeof root === "string" ? root.replace(/\/+$/g, "") : "";
  const relative = item.destination_path.replace(/^\/+/g, "");
  return `${prefix}/${relative}`.replace(/\/+/g, "/");
}

function googleParent(destination: unknown): string {
  const id = typeof destination === "object" && destination
    ? (destination as Record<string, unknown>).folderId
    : undefined;
  if (typeof id !== "string" || !id) throw new Error("destination-unavailable");
  return id;
}

function basename(path: string): string {
  return path.replace(/\\/g, "/").split("/").filter(Boolean).at(-1) || "LTDS file";
}

function dropboxAdapter(env: CloudTransferEnv): CloudProviderAdapter {
  return {
    async transfer(input) {
      const client = new DropboxClient({ accessToken: accessToken(input.credential) });
      const sessionId = await client.uploadSessionStart();
      let offset = 0;
      await input.saveUploadState({ provider: "dropbox", sessionId }, offset);
      while (offset < input.item.source_size) {
        if (await input.signalCancelled()) throw new Error("cancelled");
        const length = Math.min(CHUNK_SIZE, input.item.source_size - offset);
        const chunk = await sourceChunk(env, input.item, offset, length);
        await client.uploadSessionAppend(sessionId, offset, chunk);
        offset += chunk.byteLength;
        await input.saveUploadState({ provider: "dropbox", sessionId }, offset);
      }
      const result = await client.uploadSessionFinish(
        sessionId,
        offset,
        dropboxPath(input.item, input.destination),
        new Uint8Array(),
        input.conflictMode === "autorename",
      );
      return { status: "completed", providerFileId: result.id, uploadedBytes: offset };
    },
    async revoke(credential) {
      await new DropboxClient({ accessToken: accessToken(credential) }).revoke();
    },
  };
}

function googleAdapter(env: CloudTransferEnv): CloudProviderAdapter {
  return {
    async transfer(input) {
      const client = new GoogleDriveClient({ accessToken: accessToken(input.credential) });
      const existing = await client.findByTransferId(googleParent(input.destination), input.item.id);
      if (existing) {
        return { status: "completed", providerFileId: existing.id, uploadedBytes: input.item.source_size };
      }
      const sessionUrl = await client.startResumableUpload({
        name: basename(input.item.destination_path),
        parentId: googleParent(input.destination),
        mimeType: "application/octet-stream",
        size: input.item.source_size,
        transferId: input.item.id,
      });
      let offset = 0;
      await input.saveUploadState({ provider: "google", sessionUrl }, offset);
      while (offset < input.item.source_size) {
        if (await input.signalCancelled()) throw new Error("cancelled");
        const length = Math.min(CHUNK_SIZE, input.item.source_size - offset);
        const chunk = await sourceChunk(env, input.item, offset, length);
        const status = await client.uploadChunk(sessionUrl, offset, input.item.source_size, chunk);
        offset = status.committedBytes;
        await input.saveUploadState({ provider: "google", sessionUrl }, offset);
        if (status.complete) {
          return { status: "completed", providerFileId: status.fileId, uploadedBytes: offset };
        }
      }
      const status = await client.queryUploadStatus(sessionUrl, input.item.source_size);
      if (!status.complete) throw new Error("provider-unavailable");
      return { status: "completed", providerFileId: status.fileId, uploadedBytes: status.committedBytes };
    },
  };
}

export function createCloudProviderAdapter(
  provider: CloudProvider,
  env: CloudTransferEnv,
): CloudProviderAdapter {
  return provider === "dropbox" ? dropboxAdapter(env) : googleAdapter(env);
}

export * from "./provider";
export * from "./dropbox";
export * from "./google-drive";
