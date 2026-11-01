'use strict';
// A health probe must not initialize, migrate, or create the Viewer database.
const {DatabaseSync}=require('node:sqlite');
function workerHeartbeatIsFresh(databasePath,nowMs=Date.now()){
  let db;
  try{db=new DatabaseSync(databasePath,{readOnly:true});const row=db.prepare("SELECT value FROM app_state WHERE key='processing_worker_heartbeat'").get(),value=JSON.parse(row?.value||'null'),at=Date.parse(value?.at||'');return Number.isFinite(at)&&at>nowMs-30000&&at<=nowMs+5000;}
  catch{return false;}
  finally{if(db)db.close();}
}
if(require.main===module){const {config}=require('./config');if(!workerHeartbeatIsFresh(config.databasePath))process.exitCode=1;}
module.exports={workerHeartbeatIsFresh};
