'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {validateCandidateConfig,startCandidate}=require('../server/sourceSpoolCopyWorkerCandidate');
test('static service skeleton validates fixed roots and HTTPS origin then remains unavailable',()=>{
 const valid={sourceRoot:'/app/source',spoolRoot:'/app/storage/processing-spool',apiOrigin:'https://internal.example'};
 assert.equal(validateCandidateConfig(valid),true);
 for(const value of [{...valid,sourceRoot:'/other'},{...valid,spoolRoot:'/other'},{...valid,apiOrigin:'http://internal.example'},{...valid,apiOrigin:'https://user:pass@internal.example'},{...valid,apiOrigin:'https://internal.example/path'}])assert.equal(validateCandidateConfig(value),false);
 assert.throws(()=>startCandidate(),{code:'SPOOL_HANDOFF_UNAVAILABLE'});
});
