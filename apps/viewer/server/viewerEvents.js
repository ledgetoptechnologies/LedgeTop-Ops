'use strict';
const crypto=require('node:crypto');
function canonicalViewerEvent({method='POST',path='/api/viewer/events',timestamp,nonce,bodySha256}){return['ltds-viewer-event-v1',method.toUpperCase(),path,String(timestamp),nonce,bodySha256].join('\n');}
function signViewerEvent({secret,keyId='viewer-v1',method='POST',path='/api/viewer/events',body,timestamp=Math.floor(Date.now()/1000),nonce=crypto.randomBytes(24).toString('base64url')}){const bytes=Buffer.isBuffer(body)?body:Buffer.from(String(body));const bodySha256=crypto.createHash('sha256').update(bytes).digest('hex');const signature=crypto.createHmac('sha256',secret).update(canonicalViewerEvent({method,path,timestamp,nonce,bodySha256})).digest('base64url');return{'X-LTDS-Viewer-Key-Id':keyId,'X-LTDS-Viewer-Timestamp':String(timestamp),'X-LTDS-Viewer-Nonce':nonce,'X-LTDS-Viewer-Content-SHA256':bodySha256,'X-LTDS-Viewer-Signature':signature};}
module.exports={canonicalViewerEvent,signViewerEvent};
