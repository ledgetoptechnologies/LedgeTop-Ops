const test=require('node:test'),assert=require('node:assert/strict');
const {DatabaseSync}=require('node:sqlite');
const {applyMigrations}=require('../server/database');
const {MeasurementSourceUnitEvidence,matchedSourceUnitEvidence,sourceUnitDisplayEvidence}=require('../server/measurementSourceUnitEvidence');
const request={modelId:'m',modelVersionId:'v',coordinateReference:{crs:'EPSG:32616'},source:{id:'a',kind:'ept',sha256:'a'.repeat(64),manifestSha256:'b'.repeat(64),byteSize:123},sourceVerticalUnit:'m'};
test('staff source review persists across measurement polygons, not changed source evidence',()=>{
  const db=new DatabaseSync(':memory:');try{applyMigrations(db);const store=new MeasurementSourceUnitEvidence(db);assert.equal(store.get(request),null);
    const evidence=store.recordStaffReview(request,'staff');assert.equal(evidence.basis,'administrator-reviewed-source');assert.equal(evidence.verticalDatum,'unknown');
    const display=sourceUnitDisplayEvidence({...evidence,unexpectedSecret:'never-export'});assert.equal(display.reviewedBy,undefined);assert.equal(display.reviewedAt,undefined);assert.equal(display.unexpectedSecret,undefined);assert.equal(display.sha256,request.source.sha256);
    const summary=store.summary(request.modelId,request.modelVersionId,request.source);assert.equal(summary.verticalUnit,'m');assert.equal(summary.reviewedBy,undefined);assert.equal(summary.reviewedAt,undefined);
    assert.equal(store.summary(request.modelId,'different',request.source),null);
    assert.deepEqual(store.get({...request,vertices:[[1,2,3]]}),evidence);assert.equal(store.recordStaffReview(request,'another').id,evidence.id);
    for(const mutation of [{modelId:'other'},{modelVersionId:'new'},{coordinateReference:{crs:'EPSG:32617'}},...['id','kind','sha256','manifestSha256','byteSize'].map(key=>({source:{...request.source,[key]:key==='byteSize'?124:'different'}}))])assert.equal(store.get({...request,...mutation}),null);
  }finally{db.close();}
});
test('unbound or non-metric claims are not accepted as reviewed evidence',()=>{
  assert.equal(matchedSourceUnitEvidence(request,{verticalUnit:'m'}),null);
  const db=new DatabaseSync(':memory:');try{applyMigrations(db);const store=new MeasurementSourceUnitEvidence(db);assert.throws(()=>store.recordStaffReview({...request,sourceVerticalUnit:'ft'},'staff'));assert.throws(()=>store.recordStaffReview(request,''));assert.throws(()=>store.recordStaffReview({...request,source:{...request.source,manifestSha256:''}},'staff'));}finally{db.close();}
});
test('explicit metadata retains original units, exact binding, first evidence and safe display',()=>{
  for(const [verticalUnit,verticalFactor] of [['m',1],['ft',.3048],['us-ft',1200/3937]]){
    const db=new DatabaseSync(':memory:');try{
      applyMigrations(db);const store=new MeasurementSourceUnitEvidence(db);
      const inspection={crs:request.coordinateReference.crs,...request.source,originalUnit:verticalUnit,verticalFactor};
      assert.equal(store.recordExplicitMetadata(request,inspection),null,'unregistered source rejected');
      db.exec(`INSERT INTO models(id,provider,provider_model_id,display_name,status,created_at,updated_at) VALUES('m','test','m','Test','ready','now','now');
        INSERT INTO model_versions(id,model_id,provider_version_id,source_locator_json,status,created_at,updated_at) VALUES('v','m','v','{}','ready','now','now');`);
      db.prepare("INSERT INTO model_assets(id,version_id,kind,root_key,relative_path,byte_size,sha256,manifest_sha256,created_at) VALUES('a','v','ept','test','ept.json',?,?,?,'now')").run(request.source.byteSize,request.source.sha256,request.source.manifestSha256);
      for(const mutation of [{sha256:'c'.repeat(64)},{byteSize:124},{manifestSha256:'c'.repeat(64)},{crs:'EPSG:32617'},{verticalFactor:42},{originalUnit:'yard'}])assert.equal(store.recordExplicitMetadata(request,{...inspection,...mutation}),null);
      const evidence=store.recordExplicitMetadata(request,inspection);
      assert.equal(evidence.verticalUnit,verticalUnit);assert.equal(evidence.verticalFactor,verticalFactor);
      assert.equal(store.recordExplicitMetadata(request,inspection).id,evidence.id);
      assert.equal(store.recordStaffReview(request,'staff').id,evidence.id,'staff cannot silently overwrite encoded units');
      const display=sourceUnitDisplayEvidence({...evidence,secret:'hidden'}),summary=store.summary('m','v',request.source);
      assert.equal(display.verticalFactor,verticalFactor);assert.equal(summary.verticalUnit,verticalUnit);assert.equal(display.secret,undefined);assert.equal(display.recordedAt,undefined);
      assert.equal(matchedSourceUnitEvidence(request,{...evidence,verticalFactor:42}),null);
      db.prepare('DELETE FROM measurement_source_unit_evidence').run();
      const staff=store.recordStaffReview(request,'staff');
      assert.equal(store.recordExplicitMetadata(request,inspection).id,staff.id,'existing staff evidence preserved');
    }finally{db.close();}
  }
});

test('native point explicit evidence requires exact registration and does not enable reviewed or ODM evidence',()=>{
  const db=new DatabaseSync(':memory:');try{
    applyMigrations(db);const store=new MeasurementSourceUnitEvidence(db);
    const native={...request,source:{...request.source,kind:'pointCloud',manifestSha256:''}};
    const inspection={crs:native.coordinateReference.crs,...native.source,originalUnit:'us-ft',verticalFactor:1200/3937};
    assert.equal(store.recordExplicitMetadata(native,inspection),null);
    db.exec(`INSERT INTO models(id,provider,provider_model_id,display_name,status,created_at,updated_at) VALUES('m','test','m','Test','ready','now','now');
      INSERT INTO model_versions(id,model_id,provider_version_id,source_locator_json,status,created_at,updated_at) VALUES('v','m','v','{}','ready','now','now');`);
    db.prepare("INSERT INTO model_assets(id,version_id,kind,root_key,relative_path,byte_size,sha256,created_at) VALUES('a','v','pointCloud','test','cloud.las',?,?,'now')").run(native.source.byteSize,native.source.sha256);
    for(const mutation of [{originalUnit:null,verticalFactor:null},{originalUnit:'m',verticalFactor:null},{sha256:'c'.repeat(64)},{byteSize:124},{manifestSha256:'b'.repeat(64)},{crs:'EPSG:32617'},{verticalFactor:1}])assert.equal(store.recordExplicitMetadata(native,{...inspection,...mutation}),null);
    for(const mutation of [{modelId:'different'},{modelVersionId:'different'},{source:{...native.source,id:'different'}},{source:{...native.source,kind:'dsm'}}])assert.equal(store.recordExplicitMetadata({...native,...mutation},inspection),null);
    const evidence=store.recordExplicitMetadata(native,inspection);
    assert.equal(evidence.verticalUnit,'us-ft');assert.equal(evidence.verticalFactor,1200/3937);
    assert.equal(store.recordExplicitMetadata(native,inspection).id,evidence.id);
    assert.equal(store.summary('m','v',native.source).verticalFactor,1200/3937);
    assert.throws(()=>store.recordStaffReview(native,'staff'),/invalid source unit review/);
    assert.equal(store.recordVerifiedOdm(native,{}),null);
    for(const basis of ['administrator-reviewed-source','verified-odm-source'])assert.equal(matchedSourceUnitEvidence(native,{...evidence,basis,verticalUnit:'m'}),null);
    assert.equal(store.get({...native,source:{...native.source,sha256:'d'.repeat(64)}}),null);
    assert.equal(matchedSourceUnitEvidence({...native,source:{...native.source,id:'derived-ept',kind:'ept',manifestSha256:'b'.repeat(64)}},evidence),null,'native evidence never inherits to EPT');
  }finally{db.close();}
});
