import { byteBody, providerFetch, responseJson, type Fetcher } from "./provider";

const DRIVE = "https://www.googleapis.com/drive/v3";
const UPLOAD = "https://www.googleapis.com/upload/drive/v3";

export interface GoogleDriveClientOptions {
  accessToken: string;
  fetch?: Fetcher;
}

export interface GoogleUploadStatus {
  complete: boolean;
  committedBytes: number;
  fileId?: string;
}

function committedBytes(response: Response): number {
  const range = response.headers.get("Range");
  const match = range?.match(/bytes=0-(\d+)/);
  return match ? Number(match[1]) + 1 : 0;
}

export class GoogleDriveClient {
  private readonly accessToken: string;
  private readonly fetcher: Fetcher;

  constructor(options: GoogleDriveClientOptions) {
    this.accessToken = options.accessToken;
    this.fetcher = options.fetch ?? fetch;
  }

  private headers(extra?: HeadersInit): Headers {
    const headers = new Headers(extra);
    headers.set("Authorization", `Bearer ${this.accessToken}`);
    return headers;
  }

  async createFolder(name: string, parentId: string, transferId: string): Promise<{ id: string }> {
    const response = await providerFetch(this.fetcher, `${DRIVE}/files?fields=id`, {
      method: "POST",
      headers: this.headers({ "Content-Type": "application/json" }),
      body: JSON.stringify({
        name,
        mimeType: "application/vnd.google-apps.folder",
        parents: [parentId],
        appProperties: { ltdsTransferId: transferId },
      }),
    }, { operation: "google-create-folder" });
    return responseJson<{ id: string }>(response, "google-create-folder");
  }

  async findByTransferId(parentId: string, transferId: string): Promise<{ id: string; name?: string } | undefined> {
    const escapedParent = parentId.replace(/'/g, "\\'");
    const escapedTransfer = transferId.replace(/'/g, "\\'");
    const query = `'${escapedParent}' in parents and appProperties has { key='ltdsTransferId' and value='${escapedTransfer}' } and trashed=false`;
    const url = new URL(`${DRIVE}/files`);
    url.search = new URLSearchParams({ q: query, fields: "files(id,name)", pageSize: "2" }).toString();
    const response = await providerFetch(this.fetcher, url, {
      headers: this.headers(),
    }, { operation: "google-find-transfer-file" });
    const result = await responseJson<{ files?: Array<{ id: string; name?: string }> }>(response, "google-find-transfer-file");
    return result.files?.[0];
  }

  async startResumableUpload(input: {
    name: string;
    parentId: string;
    mimeType: string;
    size: number;
    transferId: string;
  }): Promise<string> {
    const response = await providerFetch(this.fetcher, `${UPLOAD}/files?uploadType=resumable&fields=id`, {
      method: "POST",
      headers: this.headers({
        "Content-Type": "application/json; charset=UTF-8",
        "X-Upload-Content-Type": input.mimeType || "application/octet-stream",
        "X-Upload-Content-Length": String(input.size),
      }),
      body: JSON.stringify({
        name: input.name,
        parents: [input.parentId],
        appProperties: { ltdsTransferId: input.transferId },
      }),
    }, { operation: "google-upload-start" });
    const location = response.headers.get("Location");
    if (!location) throw new Error("google-upload-session-missing");
    return location;
  }

  async uploadChunk(
    sessionUrl: string,
    offset: number,
    total: number,
    chunk: Uint8Array,
  ): Promise<GoogleUploadStatus> {
    const end = offset + chunk.byteLength - 1;
    const response = await providerFetch(this.fetcher, sessionUrl, {
      method: "PUT",
      headers: this.headers({
        "Content-Length": String(chunk.byteLength),
        "Content-Range": `bytes ${offset}-${end}/${total}`,
      }),
      body: byteBody(chunk),
    }, { operation: "google-upload-chunk", accepted: [200, 201, 308] });
    if (response.status === 308) return { complete: false, committedBytes: committedBytes(response) };
    const result = await responseJson<{ id?: string }>(response, "google-upload-complete");
    return { complete: true, committedBytes: total, fileId: result.id };
  }

  async queryUploadStatus(sessionUrl: string, total: number): Promise<GoogleUploadStatus> {
    const response = await providerFetch(this.fetcher, sessionUrl, {
      method: "PUT",
      headers: this.headers({ "Content-Length": "0", "Content-Range": `bytes */${total}` }),
    }, { operation: "google-upload-status", accepted: [200, 201, 308] });
    if (response.status === 308) return { complete: false, committedBytes: committedBytes(response) };
    const result = await responseJson<{ id?: string }>(response, "google-upload-status");
    return { complete: true, committedBytes: total, fileId: result.id };
  }
}
