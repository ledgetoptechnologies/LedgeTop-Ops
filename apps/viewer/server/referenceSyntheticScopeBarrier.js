'use strict';
// Synthetic-only cooperative model. No runtime caller, filesystem identity,
// custody authority, or process/FD fencing is established by this module.
const TEST_SCHEMA=`
CREATE TABLE synthetic_scope_entries(id TEXT PRIMARY KEY NOT NULL,kind TEXT NOT NULL CHECK(kind IN ('pin','effect')),domain TEXT NOT NULL,revision TEXT NOT NULL,paths TEXT NOT NULL,owner TEXT NOT NULL);
CREATE TABLE synthetic_scope_completions(id TEXT PRIMARY KEY NOT NULL REFERENCES synthetic_scope_entries(id),receipt TEXT NOT NULL);
CREATE TRIGGER synthetic_scope_no_replace BEFORE INSERT ON synthetic_scope_entries WHEN EXISTS(SELECT 1 FROM synthetic_scope_entries WHERE id=NEW.id) BEGIN SELECT RAISE(ABORT,'scope replacement'); END;
CREATE TRIGGER synthetic_scope_no_update BEFORE UPDATE ON synthetic_scope_entries BEGIN SELECT RAISE(ABORT,'scope immutable'); END;
CREATE TRIGGER synthetic_scope_no_delete BEFORE DELETE ON synthetic_scope_entries BEGIN SELECT RAISE(ABORT,'scope immutable'); END;
CREATE TRIGGER synthetic_scope_completion_no_replace BEFORE INSERT ON synthetic_scope_completions WHEN EXISTS(SELECT 1 FROM synthetic_scope_completions WHERE id=NEW.id) BEGIN SELECT RAISE(ABORT,'scope completion replacement'); END;
CREATE TRIGGER synthetic_scope_completion_no_update BEFORE UPDATE ON synthetic_scope_completions BEGIN SELECT RAISE(ABORT,'scope completion immutable'); END;
CREATE TRIGGER synthetic_scope_completion_no_delete BEFORE DELETE ON synthetic_scope_completions BEGIN SELECT RAISE(ABORT,'scope completion immutable'); END;`;
const bad=code=>Object.assign(new Error(code),{code});
const id=x=>typeof x==='string'&&/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(x);
function validateScope(s){
 if(!s||!id(s.domain)||!id(s.revision)||!Array.isArray(s.paths)||s.paths.length<1||s.paths.length>8)throw bad('scope_unattested');
 for(const p of s.paths){if(typeof p!=='string'||p.length>512||p.split('/').length>32||!p.split('/').every(c=>/^[a-z0-9][a-z0-9._-]{0,63}$/.test(c)&&c!=='.'&&c!=='..'))throw bad('scope_unattested');}
 if(new Set(s.paths).size!==s.paths.length)throw bad('scope_unattested');return {domain:s.domain,revision:s.revision,paths:[...s.paths].sort()};
}
const overlap=(a,b)=>a===b||a.startsWith(b+'/')||b.startsWith(a+'/');
class SyntheticScopeBarrier{
 constructor(db,{attest,verifyClosure}){if(typeof attest!=='function'||typeof verifyClosure!=='function')throw bad('scope_unattested');this.db=db;this.attest=attest;this.verifyClosure=verifyClosure;}
 tx(fn){this.db.exec('BEGIN IMMEDIATE');try{const v=fn();this.db.exec('COMMIT');return v}catch(e){try{this.db.exec('ROLLBACK')}catch{}throw e}}
 admit({id:entryId,kind,owner,scope}){
  if(!id(entryId)||!id(owner)||!['pin','effect'].includes(kind))throw bad('scope_invalid');const verified=validateScope(this.attest(scope));
  return this.tx(()=>{const rows=this.db.prepare('SELECT e.* FROM synthetic_scope_entries e LEFT JOIN synthetic_scope_completions c ON c.id=e.id WHERE c.id IS NULL LIMIT 1000').all();if(rows.length>=1000)throw bad('scope_capacity_exceeded');
   for(const r of rows){if(r.domain===verified.domain&&r.revision!==verified.revision)throw bad('scope_revision_unknown');if(r.domain===verified.domain&&(r.kind==='effect'||kind==='effect')&&JSON.parse(r.paths).some(a=>verified.paths.some(b=>overlap(a,b))))throw bad('scope_conflict');}
   this.db.prepare('INSERT INTO synthetic_scope_entries VALUES(?,?,?,?,?,?)').run(entryId,kind,verified.domain,verified.revision,JSON.stringify(verified.paths),owner);return entryId;});
 }
 completeEffect({id:entryId,owner,receipt}){if(!id(entryId)||!id(owner)||typeof receipt!=='string'||receipt.length>256)throw bad('scope_closure_unverified');return this.tx(()=>{const row=this.db.prepare('SELECT * FROM synthetic_scope_entries WHERE id=?').get(entryId);if(!row||row.kind!=='effect'||row.owner!==owner)throw bad('scope_owner_mismatch');const scope={domain:row.domain,revision:row.revision,paths:JSON.parse(row.paths)};if(this.verifyClosure({id:entryId,owner,kind:row.kind,scope,receipt})!==true)throw bad('scope_closure_unverified');this.db.prepare('INSERT INTO synthetic_scope_completions VALUES(?,?)').run(entryId,receipt);return true;});}
 async runEffect(input,effect){this.admit({...input,kind:'effect'});const receipt=await effect();return this.completeEffect({id:input.id,owner:input.owner,receipt});}
}
module.exports={TEST_SCHEMA,SyntheticScopeBarrier};
