'use strict';

// One contract for an upload's file ids. Ingestion accepts exactly these and
// original retention reads chunks for exactly these. An id made only of dots
// is refused because it is not a safe folder name.
const UPLOAD_FILE_ID = /^(?!\.+$)[A-Za-z0-9._-]{1,80}$/;
const isUploadFileId = (value) => typeof value === 'string' && UPLOAD_FILE_ID.test(value);

module.exports = { isUploadFileId };
