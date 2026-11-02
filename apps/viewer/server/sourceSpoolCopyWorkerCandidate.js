'use strict';
// Disabled design skeleton: no network, database, source reads or writes.
function validateCandidateConfig(config){
 if(!config||config.sourceRoot!=='/app/source'||config.spoolRoot!=='/app/storage/processing-spool'||typeof config.apiOrigin!=='string')return false;
 try{const u=new URL(config.apiOrigin);return u.protocol==='https:'&&!u.username&&!u.password&&u.origin===config.apiOrigin;}catch{return false;}
}
function startCandidate(){throw Object.assign(new Error('authenticated spool handoff is not implemented'),{code:'SPOOL_HANDOFF_UNAVAILABLE'});}
if(require.main===module){try{if(!validateCandidateConfig({sourceRoot:process.env.SPOOL_SOURCE_ROOT,spoolRoot:process.env.SPOOL_ROOT,apiOrigin:process.env.SPOOL_API_ORIGIN}))throw new Error('candidate configuration invalid');startCandidate();}catch(error){process.stderr.write(`${error.code||'SPOOL_CONFIG_INVALID'}\n`);process.exitCode=78;}}
module.exports={validateCandidateConfig,startCandidate};
