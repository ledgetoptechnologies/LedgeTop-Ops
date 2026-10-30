'use strict';

const crypto = require('node:crypto');
const { TextDecoder } = require('node:util');
const { MAX_SOURCE_BYTES, parseGcpInterchange, confirmationToken } = require('./gcpImport');

// Decode a bounded, canonical transport representation without normalizing the
// file. The result is deliberately not persisted or used by an API route yet.
function decodeRawGcpSource(encoded) {
  const invalid = () => Object.assign(new Error('GCP source must be canonical base64 containing valid UTF-8'), { code: 'invalid_gcp_input' });
  if (typeof encoded !== 'string' || !encoded || encoded.length > Math.ceil(MAX_SOURCE_BYTES / 3) * 4 ||
      encoded.length % 4 !== 0 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) throw invalid();
  const bytes = Buffer.from(encoded, 'base64');
  if (!bytes.length || bytes.length > MAX_SOURCE_BYTES || bytes.toString('base64') !== encoded) throw invalid();
  let content;
  try { content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); }
  catch { throw invalid(); }
  if (!Buffer.from(content, 'utf8').equals(bytes)) throw invalid();
  return { bytes, content, byteSize: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex') };
}

// Preview and eventual import must share this exact byte-derived input. This
// entry point is kept unexposed until the retained-source journal is available.
function parseRawGcpSource({ encoded, format, declarations }) {
  const raw = decodeRawGcpSource(encoded);
  const parsed = parseGcpInterchange({ format, content: raw.content, declarations });
  if (parsed.sourceSha256 !== raw.sha256) throw Object.assign(new Error('GCP source checksum mismatch'), { code: 'invalid_gcp_input' });
  return { ...raw, parsed, confirmationToken: confirmationToken(parsed) };
}

module.exports = { decodeRawGcpSource, parseRawGcpSource };
