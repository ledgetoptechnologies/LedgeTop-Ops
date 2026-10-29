// Draft only: not imported by the workspace. Read the File once and reuse the
// exact bytes for preview and preparation. A pending journal is not an import.
const MAX_BYTES = 2 * 1024 * 1024;

export async function readRawGcpFile(file) {
  if (!file || typeof file.name !== 'string' || !Number.isSafeInteger(file.size) || file.size < 1 || file.size > MAX_BYTES || typeof file.arrayBuffer !== 'function') {
    throw new Error('Choose a GCP file up to 2 MiB.');
  }
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (bytes.length !== file.size) throw new Error('The GCP file changed while it was being read.');
  let binary = '';
  // Avoid spreading an entire large buffer into a single function call.
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return Object.freeze({ fileName: file.name, encoded: btoa(binary), byteSize: bytes.length });
}

export async function previewRawGcp({ request, datasetId, source, format, declarations }) {
  if (typeof request !== 'function' || typeof datasetId !== 'string' || !datasetId || !source?.encoded) throw new Error('GCP preview is unavailable.');
  const base = `/api/v1/datasets/${encodeURIComponent(datasetId)}/gcp-sets/raw`;
  const body = {encoded:source.encoded, format, ...(declarations == null ? {} : {declarations:structuredClone(declarations)})};
  const fileName = source.fileName;
  const preview = await request(`${base}/preview`, {method:'POST', body});
  if (!preview || typeof preview.confirmationToken !== 'string' || !/^[a-f0-9]{64}$/.test(preview.sourceSha256) || preview.byteSize !== source.byteSize) throw new Error('GCP preview could not be verified.');
  // Keep the precise source/declarations in the returned closure. Callers must
  // present the preview and invoke prepare only after explicit confirmation.
  const confirmationToken = preview.confirmationToken;
  return { preview, async prepare({displayName, requestKey}) {
    if (typeof requestKey !== 'string' || !/^[A-Za-z0-9._:-]{8,128}$/.test(requestKey)) throw new Error('GCP request identity is invalid.');
    const result = await request(`${base}/prepare`, {method:'POST', headers:{'Idempotency-Key':requestKey}, body:{...body, fileName, displayName, requestKey, confirmationToken}});
    if (!result || result.status !== 'pending' || typeof result.journalId !== 'string') throw new Error('GCP source preparation could not be verified.');
    return result;
  }};
}
