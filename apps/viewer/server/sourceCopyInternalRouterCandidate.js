'use strict';
// Unmounted; caller must supply the dedicated credential and a trusted TLS boundary.
const express=require('express'),crypto=require('node:crypto');
function createSourceCopyInternalRouter({enabled=false,credential,service}={}){
 const router=express.Router();
 if(enabled!==true){router.use((_req,res)=>res.status(404).json({error:'not_found'}));return router;}
 if(typeof credential!=='string'||credential.length<32||credential.length>512||!service||typeof service.claim!=='function'||typeof service.complete!=='function')throw new Error('source copy router configuration invalid');
 const expected=crypto.createHash('sha256').update(credential).digest();
 router.use((req,res,next)=>{const value=req.get('authorization')||'',provided=value.startsWith('Bearer ')?value.slice(7):'',actual=crypto.createHash('sha256').update(provided).digest();if(!crypto.timingSafeEqual(expected,actual))return res.status(401).json({error:'unauthorized'});next();});
 router.use(express.json({limit:'4mb',strict:true}));
 const respond=(res,error)=>{const sqliteBase=Number.isInteger(error?.errcode)?error.errcode&255:null;if(error?.code==='SOURCE_COPY_WRITER_FENCE_UNAVAILABLE'||error?.code==='SOURCE_COPY_VERIFICATION_UNAVAILABLE'||error?.code==='SQLITE_BUSY'||sqliteBase===5||sqliteBase===6){res.set('Retry-After','1');return res.status(503).json({error:'source_copy_unavailable'});}return res.status(409).json({error:'source_copy_conflict'});};
 router.post('/internal/v1/source-copies/claim',(req,res)=>{try{if(!req.body||Array.isArray(req.body)||Object.keys(req.body).length!==1||typeof req.body.operationId!=='string')return res.status(400).json({error:'invalid_request'});return res.json(service.claim(req.body.operationId));}catch(error){return respond(res,error);}});
 router.post('/internal/v1/source-copies/:operationId/complete',(req,res)=>{try{return res.json(service.complete(req.params.operationId,req.body));}catch(error){return respond(res,error);}});
 return router;
}
module.exports={createSourceCopyInternalRouter};
