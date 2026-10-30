'use strict';
// Synthetic-only subprocess: this is not a production authority or worker.
const fs=require('node:fs');
const path=require('node:path');
const assert=require('node:assert/strict');
const {ReferenceProvider}=require('../../server/referenceProvider');
const {ReferenceResultJournal}=require('../../server/referenceResultJournal');
const {ReferenceAcceptanceLedger}=require('../../server/referenceAcceptance');
const {handleReferenceResult}=require('../../server/referenceResultBridge');
const {verifyProcessingArchive}=require('../../server/processingArchiveEvidence');

async function main(){
  const parent=process.argv[2],root=path.join(parent,'retained');
  const plan=JSON.parse(fs.readFileSync(path.join(parent,'fixture-replay-plan.json'),'utf8'));
  const rootFd=fs.openSync(root,fs.constants.O_RDONLY|fs.constants.O_DIRECTORY);
  let journal,ledger,ackCount=0;
  try {
    const stat=fs.fstatSync(rootFd,{bigint:true});
    const authority={rootFd,device:stat.dev,inode:stat.ino,assertCurrent:()=>true};
    journal=new ReferenceResultJournal({authority,maxBytes:1024*1024});
    ledger=new ReferenceAcceptanceLedger({databasePath:path.join(parent,'acceptance.sqlite'),managedRoot:root});
    // Include the scheduled retry window without changing its persisted time.
    if(ledger.pendingOutbox(Date.now()+300000).length!==1)throw Error('expected one pending synthetic receipt');
    const provider=new ReferenceProvider({endpoint:'https://example.test',token:'synthetic-token-only',environment:'staging',enabled:true,maxObjectBytes:1024*1024,fetchImpl:async(url,init)=>{
      if(url.endsWith('/results'))return new Response(JSON.stringify(plan.manifest),{status:200,headers:{'content-type':'application/json'}});
      if(url.endsWith('/acceptance')){
        ackCount++;
        const statePath=path.join(parent,'fixture-server-receipt.json');
        const state=JSON.parse(fs.readFileSync(statePath,'utf8'));
        assert.equal(init.method,'POST');assert.equal(init.body,state.body);
        assert.deepEqual(JSON.parse(init.body),plan.acceptance);assert.equal(state.deliveries,1);
        state.deliveries++;
        const stateFd=fs.openSync(statePath,'w',0o600);
        try{fs.writeFileSync(stateFd,JSON.stringify(state));fs.fsyncSync(stateFd)}finally{fs.closeSync(stateFd)}
        const dirFd=fs.openSync(parent,fs.constants.O_RDONLY|fs.constants.O_DIRECTORY);
        try{fs.fsyncSync(dirFd)}finally{fs.closeSync(dirFd)}
        return new Response(JSON.stringify({job:plan.completedJob,created:false,fullyAccepted:true,acceptedObjectIds:['archive-1']}),{status:200,headers:{'content-type':'application/json'}})
      }
      throw Error(`unexpected synthetic request ${init?.method||'GET'}`);
    }});
    await handleReferenceResult({provider,expected:plan.expected,acceptance:plan.acceptance,journal,ledger,assertAuthority:()=>true,
      ingestRetained:async()=>{throw Error('replay unexpectedly ingested again')},
      verifyIngest:async()=>verifyProcessingArchive(path.join(parent,'extracted'),JSON.parse(fs.readFileSync(path.join(parent,'fixture-ingest-receipt.json'),'utf8')),plan.options)});
    if(ackCount!==1||ledger.pendingOutbox().length!==0)throw Error('synthetic acknowledgement not recorded');
    process.stdout.write('synthetic-replay-acked\n');
  } finally {
    try{journal?.close()}finally{try{ledger?.close()}finally{fs.closeSync(rootFd)}}
  }
}
main().catch(error=>{process.stderr.write(`${error.stack||error}\n`);process.exitCode=1});
