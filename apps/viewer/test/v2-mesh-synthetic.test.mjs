import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { makeGlb, TRIANGLE_A, TRIANGLE_B } from './helpers/lod-fixture.mjs';
import worker from '../server/derivativeWorker.js';

const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAADklEQVR4nGP4DwYMEAoAU7oL9ZisIGcAAAAASUVORK5CYII=','base64');
test('v2 synthetic OBJ conversion keeps source outside generated output', {timeout:45000}, async t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'viewer-v2-mesh-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const task={id:crypto.randomUUID()}, attempt={id:crypto.randomUUID(),resultModelVersionId:crypto.randomUUID()}, job={id:crypto.randomUUID(),lease_token:'a'.repeat(32),deadline_at:new Date(Date.now()+40000).toISOString()};
 const managed=`${task.id}/${attempt.id}.v2`, source=`${managed}/source`, dir=path.join(root,...source.split('/'));fs.mkdirSync(dir,{recursive:true});
 fs.writeFileSync(path.join(dir,'model.glb'),makeGlb([TRIANGLE_A,TRIANGLE_B],png));
 fs.writeFileSync(path.join(dir,'model.obj'),'mtllib model.mtl\no synthetic\nv 0 0 0\nv 1 0 0\nv 0 1 0\nv 1 1 0\nvt 0 0\nvt 1 0\nvt 0 1\nvt 1 1\nvn 0 0 1\nusemtl material\nf 1/1/1 2/2/1 3/3/1\nf 2/2/1 4/4/1 3/3/1\n');
 fs.writeFileSync(path.join(dir,'model.mtl'),'newmtl material\nKd 1 1 1\nmap_Kd texture.png\n');fs.writeFileSync(path.join(dir,'texture.png'),png);
 const originals=Object.fromEntries(fs.readdirSync(dir).map(n=>[n,crypto.createHash('sha256').update(fs.readFileSync(path.join(dir,n))).digest('hex')]));
 let registered;const processing={getModelOutput:()=>({relativePath:managed}),getAttemptTransferProvenance:()=>({archive:{layoutVersion:2}}),derivativeStorageReservation:()=>null,activeDerivativeReservationBytes:()=>0,activeProcessingReservationBytes:()=>[],registerVerifiedLodAsset:(_id,_owner,asset,_proof,{promote})=>{promote();registered=asset;return true;}};
 const storage={roots:{models:root},resolve:(_key,p)=>path.join(root,...p.split('/')),requireDerivativeSpace:()=>({inodeCapacity:'measured',inodeReserve:10000}),space:()=>({files:1000000,ffree:900000,available:100*1024**3,reserve:0})};
 await worker.generateMeshTiles({processing,storage,config:{meshDerivativesEnabled:true,obj2TilesBin:'/opt/obj2tiles/Obj2Tiles'},attempt,job,owner:'test',task,obj:{root_key:'models',relative_path:`${source}/model.obj`},glb:{root_key:'models',relative_path:`${source}/model.glb`},inputSnapshot:{totalByteSize:1024},audit:'/app/scripts/audit-lod-equivalence.mjs',signal:new AbortController().signal});
 assert.equal(registered.relativePath,`${managed}/derived/tiles-ktx2-etc1s-${job.id}/tileset.json`);
 for(const [n,h] of Object.entries(originals))assert.equal(crypto.createHash('sha256').update(fs.readFileSync(path.join(dir,n))).digest('hex'),h);
});

