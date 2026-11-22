import { describe, expect, it } from "vitest";
import { isDirectWorkspaceFolderHandle, loadDirectWorkspaceFile, loadDirectWorkspaceFolderFiles, loadDirectWorkspaceFolders, loadOperationsDirectFolderCapability, OPERATIONS_DIRECT_FOLDER_API, OPERATIONS_DIRECT_FOLDER_CAPABILITY_API } from "../src/client/direct-folder-api";
import type { PortalRequest } from "../src/client/portal-api";

const folder = "df1_folder_handle";
const file = "df1_file_handle";
const baseFile = { id: file, name: "map.pdf", size: 10, uploadedAt: "2026-11-15T00:00:00.000Z", contentType: "application/pdf",
  kind: "pdf", previewPath: `${OPERATIONS_DIRECT_FOLDER_API}/preview?file=${file}`, thumbnailPath: null,
  downloadPath: `${OPERATIONS_DIRECT_FOLDER_API}/download?file=${file}` };
const page = { files: [baseFile], folders: [{ id: folder, name: "Plans" }], breadcrumbs: [{ id: folder, name: "Shared plans" }],
  folderId: folder, prefix: "", cursor: null };
function returning(value: unknown, calls: Array<{ url: string; init?: unknown }>): PortalRequest {
  return (async (url: string, init?: unknown) => { calls.push({ url, init }); return value; }) as PortalRequest;
}

describe("direct workspace folder client API", () => {
  it("probes only the fixed Operations capability endpoint without ambient workspace scope", async () => {
    const calls: Array<{ url: string; init?: unknown }> = [], signal = new AbortController().signal;
    await expect(loadOperationsDirectFolderCapability(signal, returning({protocolVersion: 1, enabled: true}, calls))).resolves.toBe(true);
    expect(calls).toEqual([{url: OPERATIONS_DIRECT_FOLDER_CAPABILITY_API, init: {omitWorkspace: true, signal}}]);
    await expect(loadOperationsDirectFolderCapability(undefined, returning({protocolVersion: 1, enabled: false}, []))).resolves.toBe(false);
    await expect(loadOperationsDirectFolderCapability(undefined, returning({protocolVersion: 2, enabled: true}, []))).rejects.toMatchObject({status: 409});
  });

  it("treats only a missing capability route as unsupported and preserves other failures", async () => {
    const notFound = Object.assign(new Error("not found"), {status: 404});
    await expect(loadOperationsDirectFolderCapability(undefined, (async () => { throw notFound; }) as PortalRequest)).resolves.toBe(false);
    const unavailable = Object.assign(new Error("unavailable"), {status: 503});
    await expect(loadOperationsDirectFolderCapability(undefined, (async () => { throw unavailable; }) as PortalRequest)).rejects.toBe(unavailable);
  });

  it("requests one workspace's Operations list explicitly and validates its mode and opaque handles", async () => {
    const calls: Array<{ url: string; init?: unknown }> = [];
    const result = { resourceMode: "direct_workspace_folders", items: [{ id: folder, name: "Shared plans", expiresAt: null }] };
    await expect(loadDirectWorkspaceFolders("workspace-one", undefined, returning(result, calls))).resolves.toEqual(result);
    expect(calls).toEqual([{ url: OPERATIONS_DIRECT_FOLDER_API, init: { workspaceId: "workspace-one" } }]);
    expect(isDirectWorkspaceFolderHandle(folder)).toBe(true);
    expect(isDirectWorkspaceFolderHandle("np1_legacy_handle")).toBe(false);
  });

  it.each([
    { resourceMode: "legacy", items: [] },
    { resourceMode: "direct_workspace_folders", items: [{ id: "bad", name: "Folder", expiresAt: null }] },
    { resourceMode: "direct_workspace_folders", items: [{ id: folder, name: "Folder", expiresAt: "invalid" }] },
  ])("rejects an unverified direct folder list", async value => {
    await expect(loadDirectWorkspaceFolders("workspace-one", undefined, returning(value, []))).rejects.toMatchObject({ status: 409 });
  });

  it("loads pages and exact files with explicit workspace scope and validates direct media paths", async () => {
    const calls: Array<{ url: string; init?: unknown }> = [], signal = new AbortController().signal;
    await expect(loadDirectWorkspaceFolderFiles("workspace-one", folder, null, signal, returning(page, calls))).resolves.toEqual(page);
    await expect(loadDirectWorkspaceFile("workspace-one", file, signal, returning({ resourceMode: "direct_workspace_folders", file: baseFile }, calls))).resolves.toEqual(baseFile);
    expect(calls).toEqual([
      { url: `${OPERATIONS_DIRECT_FOLDER_API}/${folder}/files`, init: { workspaceId: "workspace-one", signal } },
      { url: `${OPERATIONS_DIRECT_FOLDER_API}/files/${file}`, init: { workspaceId: "workspace-one", signal } },
    ]);
    await expect(loadDirectWorkspaceFolderFiles("workspace-one", folder, null, signal,
      returning({ ...page, files: [{ ...baseFile, downloadPath: "/api/client/files/private" }] }, []))).rejects.toMatchObject({ status: 409 });
  });

  it("uses only the Operations endpoint and rejects PA-v2 media URLs", async () => {
    const calls: Array<{ url: string; init?: unknown }> = [], signal = new AbortController().signal;
    await expect(loadDirectWorkspaceFile("workspace-one", file, signal,
      returning({resourceMode: "direct_workspace_folders", file: baseFile}, calls))).resolves.toEqual(baseFile);
    expect(calls.map(call => call.url)).toEqual([`${OPERATIONS_DIRECT_FOLDER_API}/files/${file}`]);
    const paFile = {...baseFile,
      previewPath: `/api/client/direct-workspace-folders/preview?file=${file}`,
      downloadPath: `/api/client/direct-workspace-folders/download?file=${file}`};
    await expect(loadDirectWorkspaceFolderFiles("workspace-one", folder, null, signal,
      returning({...page, files: [paFile]}, []))).rejects.toMatchObject({status: 409});
  });

  it("does not reinterpret backend failures as an empty list", async () => {
    const unavailable = Object.assign(new Error("unavailable"), { status: 503 });
    const failed = (async () => { throw unavailable; }) as PortalRequest;
    await expect(loadDirectWorkspaceFolders("workspace-one", undefined, failed)).rejects.toBe(unavailable);
  });
});
