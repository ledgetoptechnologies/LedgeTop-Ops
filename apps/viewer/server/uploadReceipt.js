'use strict';

// Upload bearer tokens are returned once but never retained in new receipts.
// Use the matched Express route, not the user-supplied spelling of the URL.
function isUploadCreate(method,route){return method==='POST'&&route==='/api/v1/datasets/:id/uploads';}
function uploadReceiptBody(body){
  if(!body||typeof body!=='object'||Array.isArray(body))return null;
  const {uploadToken: _token,...redacted}=body;
  return redacted;
}
module.exports={isUploadCreate,uploadReceiptBody};
