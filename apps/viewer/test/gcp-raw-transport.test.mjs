import test from 'node:test';
import assert from 'node:assert/strict';
import {readRawGcpFile,previewRawGcp} from '../gcp-raw-transport.mjs';

test('raw file bytes are read once and reused after explicit preview confirmation',async()=>{
  const bytes=Uint8Array.from([0xef,0xbb,0xbf,65,13,10]);let reads=0;
  const source=await readRawGcpFile({name:'survey.csv',size:bytes.length,async arrayBuffer(){reads++;return bytes.buffer.slice(0)}});
  assert.deepEqual(Buffer.from(source.encoded,'base64'),Buffer.from(bytes));assert.equal(reads,1);
  const calls=[],declarations={linearUnit:'ftUS'};
  const request=async(path,options)=>{calls.push({path,options});return path.endsWith('/preview')?{confirmationToken:'token',sourceSha256:'a'.repeat(64),byteSize:bytes.length}:{status:'pending',journalId:'synthetic'};};
  const planned=await previewRawGcp({request,datasetId:'data/id',source,format:'emlid-all-columns-v1',declarations});
  assert.equal(calls.length,1);declarations.linearUnit='m';planned.preview.confirmationToken='changed';
  const result=await planned.prepare({displayName:'Control',requestKey:'request-123'});assert.equal(result.status,'pending');
  assert.equal(calls[1].options.body.encoded,calls[0].options.body.encoded);assert.equal(calls[1].options.body.declarations.linearUnit,'ftUS');
  assert.equal(calls[1].options.body.confirmationToken,'token');assert.equal(calls[1].options.headers['Idempotency-Key'],'request-123');assert.match(calls[0].path,/data%2Fid/);
});
test('invalid files or a response implying completion cannot be mistaken for a retained import',async()=>{
  await assert.rejects(readRawGcpFile({name:'x',size:2097153,arrayBuffer(){throw new Error('must not read')}}));
  const source=await readRawGcpFile({name:'x',size:1,async arrayBuffer(){return Uint8Array.of(1).buffer}});
  const planned=await previewRawGcp({request:async(path)=>path.endsWith('/preview')?{confirmationToken:'token',sourceSha256:'a'.repeat(64),byteSize:1}:{status:'ready',journalId:'x'},datasetId:'id',source,format:'generic-csv-v1'});
  await assert.rejects(planned.prepare({displayName:'x',requestKey:'request-123'}),/could not be verified/);
});
