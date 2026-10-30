'use strict';

// The coordinator's optional limit is cumulative over all uploaded inputs.
// Invalid or absent advertisements are unknown, not an unlimited guarantee.
function exceedsProviderInputLimit(files, advertisedLimit) {
  if (!Number.isSafeInteger(advertisedLimit) || advertisedLimit <= 0) return false;
  let remaining = advertisedLimit;
  for (const file of files) {
    if (!Number.isSafeInteger(file.byteSize) || file.byteSize < 0)
      throw Object.assign(new Error('Invalid processing input size'), { code: 'dataset_source_changed' });
    if (file.byteSize > remaining) return true;
    remaining -= file.byteSize;
  }
  return false;
}

// Reserve a generous framing allowance per file, including escaped UTF-8
// filenames and form headers. The transport limit applies to the whole body.
function uploadBatchEnd(files, start, advertisedLimit) {
  const end = Math.min(start + 20, files.length);
  if (!Number.isSafeInteger(advertisedLimit) || advertisedLimit <= 0) return end;
  let remaining = advertisedLimit - 65536;
  for (let i = start; i < end; i++) {
    const file = files[i];
    if (!Number.isSafeInteger(file.byteSize) || file.byteSize < 0)
      throw Object.assign(new Error('Invalid processing input size'), {code:'dataset_source_changed'});
    const framing = 4096 + 3 * Buffer.byteLength(file.relativePath || '', 'utf8');
    if (remaining < framing || file.byteSize > remaining - framing) {
      if (i === start) throw Object.assign(new Error('A processing input is too large for a provider upload request'), {code:'provider_upload_file_too_large'});
      return i;
    }
    remaining -= framing + file.byteSize;
  }
  return end;
}

module.exports = { exceedsProviderInputLimit, uploadBatchEnd };
