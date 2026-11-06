'use strict';
const crypto=require('node:crypto'),path=require('node:path');
// The preflight and wire encoder share these exact headers, UTF-8 filenames,
// CRLFs and a fixed-length random boundary. Blob keeps file bytes lazy; the
// provider remains authoritative if an advertised limit changes afterward.
const PREFIX='----ltds-',BOUNDARY_LENGTH=PREFIX.length+32;
function boundary(){return PREFIX+crypto.randomBytes(16).toString('hex');}
function filename(file){const name=path.basename(file.relativePath||file.absolutePath);if(!name||/[\r\n"\\]/.test(name))throw Object.assign(new Error('a submitted filename cannot be represented without changing its name'),{code:'provider_filename_unsupported'});return name;}
function partHeader(file,b){const name=filename(file);return `--${b}\r\nContent-Disposition: form-data; name="images"; filename="${name}"\r\nContent-Type: ${file.buffer==null?'application/octet-stream':'text/plain'}\r\n\r\n`;}
function footer(b){return `--${b}--\r\n`;}
function add(a,b){if(!Number.isSafeInteger(a)||!Number.isSafeInteger(b)||b<0||!Number.isSafeInteger(a+b))throw Object.assign(new Error('submitted input size cannot be represented safely'),{code:'provider_capacity_invalid'});return a+b;}
function partSize(file){if(!Number.isSafeInteger(file.byteSize)||file.byteSize<0)throw Object.assign(new Error('submitted input size cannot be represented safely'),{code:'provider_capacity_invalid'});return add(add(Buffer.byteLength(partHeader(file,'x'.repeat(BOUNDARY_LENGTH))),file.byteSize),2);}
function wireBytes(files){return files.reduce((sum,file)=>add(sum,partSize(file)),Buffer.byteLength(footer('x'.repeat(BOUNDARY_LENGTH))));}
function batchEnd(files,start,limit){let size=Buffer.byteLength(footer('x'.repeat(BOUNDARY_LENGTH))),end=start;while(end<files.length&&end-start<20){const next=add(size,partSize(files[end]));if(limit!==undefined&&next>limit)break;size=next;end++;}if(end===start)throw Object.assign(new Error('a file cannot fit within the provider request limit'),{code:'provider_upload_request_limit_exceeded'});return end;}
module.exports={boundary,filename,partHeader,footer,batchEnd,wireBytes};
