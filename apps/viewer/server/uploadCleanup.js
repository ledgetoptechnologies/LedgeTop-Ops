'use strict';

function cleanupExpiredUpload(processing,storage,id){
  if(processing.uploadContainsCsv(id)||!processing.expireUpload(id))return false;
  try{storage.cleanupUpload(id);}catch(error){processing.deferUploadCleanup(id);throw error;}
  processing.markUploadCleanupComplete(id);
  return true;
}

module.exports={cleanupExpiredUpload};
