'use strict';
const {openDatabase}=require('../../server/database'),{ProcessingRepository}=require('../../server/processingRepository');
const db=openDatabase(process.argv[2]),p=new ProcessingRepository(db);
process.on('message',message=>{try{const {id,op,receipt,operationId}=message;let result;
 if(op==='reserve')result=p.reserveSubjectOperationReceipt(receipt);
 else if(op==='create')result=p.createImportPreviewOperation({request:{rootKey:'dataset_import',relativePath:'synthetic'},subject:receipt.subject,receipt});
 else if(op==='late-error')result=p.completeSubjectOperationReceipt(receipt.subject,receipt.key,400,{code:'synthetic'});
 else if(op==='finish')result=p.completeSubjectOperationReceipt(receipt.subject,receipt.key,202,{operation:{id:operationId}});
 else if(op==='crash')return process.exit(0);
 else if(op==='stop'){db.close();process.send({id,result:'stopped'},()=>process.disconnect());return;}
 else throw Error('unsupported');process.send({id,result});
}catch(error){process.send({id,error:String(error.code||error.message)});}});
process.send({ready:true});
