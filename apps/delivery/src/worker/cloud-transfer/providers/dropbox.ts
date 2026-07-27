import { byteBody, providerFetch, responseJson, type Fetcher } from "./provider";

const API = "https://api.dropboxapi.com/2";
const CONTENT = "https://content.dropboxapi.com/2";

export interface DropboxClientOptions {
  accessToken: string;
  fetch?: Fetcher;
}

export type DropboxSaveUrlResult =
  | { kind: "async"; jobId: string }
  | { kind: "complete"; fileId?: string };

export type DropboxSaveUrlStatus =
  | { kind: "in-progress" }
  | { kind: "complete"; fileId?: string }
  | { kind: "failed"; reason: string };

export class DropboxClient {
  private readonly accessToken: string;
  private readonly fetcher: Fetcher;

  constructor(options: DropboxClientOptions) {
    this.accessToken = options.accessToken;
    this.fetcher = options.fetch ?? fetch;
  }

  private async rpc<T>(route: string, body: unknown, operation: string): Promise<T> {
    const response = await providerFetch(this.fetcher, `${API}/${route}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    }, { operation });
    return responseJson<T>(response, operation);
  }

  private async content<T>(
    route: string,
    argument: unknown,
    body: BodyInit | null,
    operation: string,
  ): Promise<T> {
    const response = await providerFetch(this.fetcher, `${CONTENT}/${route}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.accessToken}`,
        "Content-Type": "application/octet-stream",
        "Dropbox-API-Arg": JSON.stringify(argument),
      },
      body,
    }, { operation });
    return responseJson<T>(response, operation);
  }

  async createFolder(path: string): Promise<{ id?: string; pathDisplay?: string }> {
    const result = await this.rpc<{ metadata?: { id?: string; path_display?: string } }>(
      "files/create_folder_v2", { path, autorename: false }, "dropbox-create-folder",
    );
    return { id: result.metadata?.id, pathDisplay: result.metadata?.path_display };
  }

  async saveUrl(path: string, url: string): Promise<DropboxSaveUrlResult> {
    const result = await this.rpc<Record<string, unknown>>("files/save_url", { path, url }, "dropbox-save-url");
    if (typeof result.async_job_id === "string") return { kind: "async", jobId: result.async_job_id };
    const complete = result.complete as Record<string, unknown> | undefined;
    const metadata = complete?.metadata as Record<string, unknown> | undefined;
    return { kind: "complete", fileId: typeof metadata?.id === "string" ? metadata.id : undefined };
  }

  async saveUrlStatus(jobId: string): Promise<DropboxSaveUrlStatus> {
    const result = await this.rpc<Record<string, unknown>>(
      "files/save_url/check_job_status", { async_job_id: jobId }, "dropbox-save-url-status",
    );
    const tag = result[".tag"];
    if (tag === "in_progress") return { kind: "in-progress" };
    if (tag === "complete") {
      const metadata = result.metadata as Record<string, unknown> | undefined;
      return { kind: "complete", fileId: typeof metadata?.id === "string" ? metadata.id : undefined };
    }
    return { kind: "failed", reason: typeof tag === "string" ? tag : "save-url-failed" };
  }

  async uploadSessionStart(chunk?: Uint8Array): Promise<string> {
    const result = await this.content<{ session_id: string }>(
      "files/upload_session/start",
      { close: false },
      byteBody(chunk ?? new Uint8Array()),
      "dropbox-upload-start",
    );
    return result.session_id;
  }

  async uploadSessionAppend(sessionId: string, offset: number, chunk: Uint8Array, close = false): Promise<void> {
    const response = await providerFetch(this.fetcher, `${CONTENT}/files/upload_session/append_v2`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.accessToken}`,
        "Content-Type": "application/octet-stream",
        "Dropbox-API-Arg": JSON.stringify({ cursor: { session_id: sessionId, offset }, close }),
      },
      body: byteBody(chunk),
    }, { operation: "dropbox-upload-append" });
    await response.arrayBuffer();
  }

  async uploadSessionFinish(
    sessionId: string,
    offset: number,
    path: string,
    chunk: Uint8Array = new Uint8Array(),
    autorename = true,
  ): Promise<{ id?: string }> {
    return this.content<{ id?: string }>(
      "files/upload_session/finish",
      {
        cursor: { session_id: sessionId, offset },
        commit: { path, mode: "add", autorename, mute: false, strict_conflict: false },
      },
      byteBody(chunk),
      "dropbox-upload-finish",
    );
  }

  async revoke(): Promise<void> {
    const response = await providerFetch(this.fetcher, `${API}/auth/token/revoke`, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.accessToken}` },
    }, { operation: "dropbox-token-revoke" });
    await response.arrayBuffer();
  }
}
