'use strict';
// Opt-in container-local synthetic test. The receiver is a local SQLite fake,
// not Processing, network delivery, an independent fence, or custody proof.
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),{Readable}=require('node:stream'),{DatabaseSync}=require('node:sqlite');
const p=require('../server/referenceProtocol'),{ReferenceProvider}=require('../server/referenceProvider'),{ReferenceResultJournal,validateResultBinding}=require('../server/referenceResultJournal'),{ReferenceAcceptanceLedger}=require('../server/referenceAcceptance'),{handleReferenceResult}=require('../server/referenceResultBridge'),{captureProcessingArchive,verifyProcessingArchive}=require('../server/processingArchiveEvidence'),{makeZip}=require('./helpers/zipFixture');
const golden=require('./fixtures/reference-v1-acceptance-sender.golden.json');
const fixtureRoot=process.env.GOLDEN_BRIDGE_FIXTURE_ROOT;
test('actual bridge holds shared UUID golden and replays a derived valid ZIP receipt after a synthetic receiver commit',{skip:!fixtureRoot||process.platform!=='linux',timeout:30000},async()=>{
  assert.match(fixtureRoot,/^\/tmp\/viewer-golden-bridge-[a-f0-9-]+$/);fs.mkdirSync(fixtureRoot,{mode:0o700});
  const root=path.join(fixtureRoot,'retained'),destination=path.join(fixtureRoot,'extracted');fs.mkdirSync(root);
  const remotePath=path.join(fixtureRoot,'synthetic-receiver.sqlite');let fd,remote,journal,ledger;
  try{
    fd=fs.openSync(root,fs.constants.O_RDONLY|fs.constants.O_DIRECTORY);const stat=fs.fstatSync(fd,{bigint:true}),authority={rootFd:fd,device:stat.dev,inode:stat.ino,assertCurrent:()=>true};
    remote=new DatabaseSync(remotePath);remote.exec('CREATE TABLE synthetic_receiver(receipt_id TEXT PRIMARY KEY,body TEXT NOT NULL)');
    const zip=makeZip([{path:'odm_orthophoto/odm_orthophoto.tif',data:'synthetic'}]);
    const manifest={...golden.resultManifest,objects:[{id:'archive-1',role:'odm_archive',byteSize:zip.length,sha256:p.sha256(zip)}]};manifest.resultManifestSha256=p.resultManifestSha256(manifest);
    const expected={...golden.expected,resultManifestSha256:manifest.resultManifestSha256};
    const acceptance={...golden.acceptance,receiptId:golden.bridgeKeyCandidate.receiptId,resultManifestSha256:manifest.resultManifestSha256,
      storageReceiptId:p.sha256(p.canonicalBytes(validateResultBinding(expected,manifest,'archive-1')))};
    const completed={jobId:expected.jobId,generation:1,environment:'staging',phase:'completed',manifestSha256:expected.inputManifestSha256,pipelineDigest:expected.pipelineDigest,status:'succeeded',nodeId:null,transferRequest:null,transferGrantAcknowledgement:null,error:null,resultManifestSha256:expected.resultManifestSha256};
    let remoteLost=true,downloads=0,ingests=0,archiveReceipt;const bodies=[];
    const provider=new ReferenceProvider({endpoint:'https://example.test',token:'synthetic-token-only',environment:'staging',enabled:true,maxObjectBytes:1024*1024,fetchImpl:async(url,init)=>{
      if(url.endsWith('/results'))return new Response(JSON.stringify(manifest),{headers:{'content-type':'application/json'}});
      if(url.endsWith('/results/archive-1')){downloads++;return new Response(zip,{headers:{'content-type':'application/zip','content-length':String(zip.length),'x-result-sha256':manifest.objects[0].sha256,'x-result-manifest-sha256':manifest.resultManifestSha256}})}
      if(url.endsWith('/acceptance')){bodies.push(init.body);const old=remote.prepare('SELECT body FROM synthetic_receiver WHERE receipt_id=?').get(acceptance.receiptId);
        if(old)assert.equal(old.body,init.body);else remote.prepare('INSERT INTO synthetic_receiver VALUES (?,?)').run(acceptance.receiptId,init.body);
        if(remoteLost){remoteLost=false;throw Error('synthetic response lost after local commit')}
        return new Response(JSON.stringify({job:completed,created:false,fullyAccepted:true,acceptedObjectIds:['archive-1']}),{headers:{'content-type':'application/json'}})}
      throw Error('unexpected synthetic route');
    }});
    const options={maxBytes:1024*1024,maxArchiveBytes:1024*1024,maxDiskBytes:2*1024*1024,maxEntries:100};
    const open=()=>{journal=new ReferenceResultJournal({authority,maxBytes:1024*1024});ledger=new ReferenceAcceptanceLedger({databasePath:path.join(fixtureRoot,'viewer-acceptance.sqlite'),managedRoot:root})};
    const args={provider,expected,acceptance,assertAuthority:()=>true,ingestRetained:async({retained})=>{ingests++;archiveReceipt=await captureProcessingArchive(Readable.from(fs.createReadStream(path.join(root,retained.receipt.relativePath))),destination,options)},verifyIngest:async()=>verifyProcessingArchive(destination,archiveReceipt,options)};
    open();
    // Exercise the unchanged golden against its own expected manifest. The
    // storage UUID is not the bridge's digest-derived storage key.
    const goldenProvider=new ReferenceProvider({endpoint:'https://example.test',token:'synthetic-token-only',environment:'staging',enabled:true,fetchImpl:async url=>{
      if(url.endsWith('/results'))return new Response(JSON.stringify(golden.resultManifest),{headers:{'content-type':'application/json'}});
      throw Error('golden must be rejected before download');
    }});
    await assert.rejects(handleReferenceResult({...args,journal,ledger,provider:goldenProvider,expected:golden.expected,acceptance:golden.acceptance}),{code:'REFERENCE_RESULT_BINDING'});
    await assert.rejects(handleReferenceResult({...args,journal,ledger,acceptance:{...acceptance,storageReceiptId:golden.acceptance.storageReceiptId}}),{code:'REFERENCE_RESULT_BINDING'});
    assert.equal(downloads,0);assert.equal(ingests,0);
    await assert.rejects(handleReferenceResult({...args,journal,ledger}),{code:'UNCERTAIN'});
    const pending=ledger.pendingOutbox(Date.now()+300000);assert.equal(pending.length,1);assert.equal(pending[0].attempts,1);
    assert.equal(ledger.pendingOutbox(pending[0].nextAt-1).length,0);assert.equal(ledger.pendingOutbox(pending[0].nextAt).length,1);
    assert.equal(remote.prepare('SELECT count(*) AS n FROM synthetic_receiver').get().n,1);
    journal.close();journal=null;ledger.close();ledger=null;remote.close();remote=new DatabaseSync(remotePath);
    open();const replay=await handleReferenceResult({...args,journal,ledger});
    assert.equal(replay.fullyAccepted,true);assert.equal(downloads,1);assert.equal(ingests,1);assert.equal(ledger.pendingOutbox().length,0);
    assert.equal(remote.prepare('SELECT count(*) AS n FROM synthetic_receiver').get().n,1);assert.equal(bodies.length,2);assert.equal(bodies[0],bodies[1]);
    assert.equal(fs.readFileSync(path.join(destination,'odm_orthophoto','odm_orthophoto.tif'),'utf8'),'synthetic');
  }finally{journal?.close();ledger?.close();remote?.close();if(fd!==undefined)fs.closeSync(fd)}
});
