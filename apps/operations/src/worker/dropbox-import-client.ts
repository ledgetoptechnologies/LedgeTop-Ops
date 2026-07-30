// Dropbox API client for the operations import flow.
// Mirrors the delivery-side DropboxClient but adds folder listing
// and file download for importing files from Dropbox into R2.

const API = "https://api.dropboxapi.com/2";
const CONTENT = "https://content.dropboxapi.com/2";

export interface DropboxImportClientOptions {
  accessToken: string;
  fetch?: typeof fetch;
}

export interface DropboxMetadata {
  id?: string;
  name: string;
  pathDisplay?: string;
  pathLower?: string;
  ".tag": "file" | "folder" | "deleted";
  size?: number;
  contentHash?: string;
  rev?: string;
}

export interface DropboxListResult {
  entries: DropboxMetadata[];
  cursor?: string;
  hasMore: boolean;
}

export class DropboxImportClient {
  private readonly accessToken: string;
  private readonly fetcher: typeof fetch;

  constructor(options: DropboxImportClientOptions) {
    this.accessToken = options.accessToken;
    this.fetcher = options.fetch ?? fetch;
  }

  private async rpc<T>(route: string, body: unknown, operation: string): Promise<T> {
    const response = await this.fetcher(`${API}/${route}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new DropboxImportError(operation, response.status, text);
    }
    return response.json() as Promise<T>;
  }

  async listFolder(path: string, recursive = false, limit = 2000): Promise<DropboxListResult> {
    const result = await this.rpc<Record<string, unknown>>(
      "files/list_folder",
      { path: path === "" ? "" : path, recursive, limit },
      "dropbox-list-folder",
    );
    return this.normalizeListResult(result);
  }

  async listFolderContinue(cursor: string): Promise<DropboxListResult> {
    const result = await this.rpc<Record<string, unknown>>(
      "files/list_folder/continue",
      { cursor },
      "dropbox-list-folder-continue",
    );
    return this.normalizeListResult(result);
  }

  private normalizeListResult(result: Record<string, unknown>): DropboxListResult {
    const entries = (result.entries as DropboxMetadata[]) || [];
    return {
      entries: entries.filter(entry => entry[".tag"] === "file" || entry[".tag"] === "folder"),
      cursor: typeof result.cursor === "string" ? result.cursor : undefined,
      hasMore: Boolean(result.has_more),
    };
  }

  async downloadFile(path: string, range?: { offset: number; length: number }): Promise<Response> {
    const args: Record<string, unknown> = { path };
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.accessToken}`,
      "Dropbox-API-Arg": JSON.stringify(args),
    };
    if (range) {
      headers["Range"] = `bytes=${range.offset}-${range.offset + range.length - 1}`;
    }
    const response = await this.fetcher(`${CONTENT}/files/download`, {
      method: "POST",
      headers,
    });
    if (range) {
      const expectedEnd = range.offset + range.length - 1;
      const contentRange = response.headers.get("Content-Range");
      const contentLength = response.headers.get("Content-Length");
      const match = contentRange?.match(/^bytes (\d+)-(\d+)\/(\d+)$/);
      const validRange = response.status === 206
        && match?.[1] === String(range.offset)
        && match?.[2] === String(expectedEnd)
        && Number(match?.[3]) > expectedEnd
        && contentLength === String(range.length);
      if (!validRange) {
        await response.body?.cancel().catch(() => undefined);
        throw new DropboxImportError("dropbox-download-range", response.status, "invalid range response");
      }
    } else if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new DropboxImportError("dropbox-download", response.status, text);
    }
    return response;
  }

  async getMetadata(path: string): Promise<DropboxMetadata | null> {
    try {
      const result = await this.rpc<DropboxMetadata>(
        "files/get_metadata",
        { path, include_media_info: false },
        "dropbox-get-metadata",
      );
      return result;
    } catch (error) {
      if (error instanceof DropboxImportError && error.status === 409) return null;
      throw error;
    }
  }

  async revoke(): Promise<void> {
    const response = await this.fetcher(`${API}/auth/token/revoke`, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.accessToken}` },
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new DropboxImportError("dropbox-token-revoke", response.status, "");
    }
  }
}

export async function refreshDropboxToken(clientId: string, clientSecret: string, refreshToken: string): Promise<{ accessToken: string; refreshToken?: string; expiresAt?: string }> {
  const response = await fetch("https://api.dropboxapi.com/oauth2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: clientId,
      client_secret: clientSecret,
    }),
  });
  if (!response.ok) throw new Error("authorization-expired");
  const token = await response.json() as { access_token: string; refresh_token?: string; expires_in?: number };
  const expiresAt = token.expires_in ? new Date(Date.now() + token.expires_in * 1000).toISOString() : undefined;
  return { accessToken: token.access_token, refreshToken: token.refresh_token || refreshToken, expiresAt };
}

export class DropboxImportError extends Error {
  readonly status: number;
  readonly retryable: boolean;

  constructor(operation: string, status: number, body: string) {
    super(`${operation} failed (${status})`);
    this.name = "DropboxImportError";
    this.status = status;
    this.retryable = status === 429 || status >= 500;
  }
}