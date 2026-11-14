'use strict';
const crypto=require('node:crypto');
const fs=require('node:fs');
const path=require('node:path');
let hash;
// One immutable software cohort per server process, shared by status and POST.
// This hashes script bytes only; it does not execute Python or qualify runtime.
function orthophotoJpegConverterSha256(){
  hash ||= crypto.createHash('sha256').update(fs.readFileSync(path.join(__dirname,'../scripts/orthophoto-jpeg.py'))).digest('hex');
  return hash;
}
module.exports={orthophotoJpegConverterSha256};
