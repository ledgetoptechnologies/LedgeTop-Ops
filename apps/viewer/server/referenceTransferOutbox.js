'use strict';

// Dormant grant-delivery ledger. It persists only immutable grant identity and
// digests; the transfer bearer must be reconstructed by the source broker.
const crypto=require('node:crypto');
const p=require('./referenceProtocol');
const {isVerifiedTransferGrantAck}=require('./referenceProvider');
const fail=code=>{throw Object.assign(new Error(code),{code})};
const HASH=/^[a-f0-9]{64}$/;
const id=x=>typeof x==='string'&&/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(x);
const digest=x=>crypto.createHash('sha256').update(x).digest('hex');
const OUTBOX_COLUMNS=['outbox_id','attempt_id','job_id','generation','environment','reservation_id','reservation_generation','reservation_nonce_sha256','reservation_expires_at','reservation_byte_budget','manifest_sha256','grant_id','grant_identity_sha256','grant_sha256','state','send_attempts','sender_generation','acknowledgement_sha256','created_at','updated_at'];

class ReferenceTransferOutbox {
  #sendProviders=new Map();
  constructor(db,{now=Date.now,journal}={}){if(!db||typeof db.prepare!=='function'||!journal||journal.db!==db||typeof journal.read!=='function')fail('reference_transfer_outbox_unavailable');this.db=db;this.now=now;this.journal=journal;}
  tx(fn){this.db.exec('BEGIN IMMEDIATE');try{const value=fn();this.db.exec('COMMIT');return value}catch(error){try{this.db.exec('ROLLBACK')}catch{}throw error}}
  row(outboxId){if(!id(outboxId))fail('reference_transfer_outbox_invalid');const row=this.db.prepare('SELECT * FROM viewer_reference_transfer_outbox WHERE outbox_id=?').get(outboxId);if(!row)fail('reference_transfer_outbox_missing');return row}
  find(attemptId,reservationId,reservationGeneration){if(!id(attemptId)||!id(reservationId)||!Number.isSafeInteger(reservationGeneration)||reservationGeneration<1)fail('reference_transfer_outbox_invalid');return this.db.prepare('SELECT * FROM viewer_reference_transfer_outbox WHERE attempt_id=? AND reservation_id=? AND reservation_generation=?').get(attemptId,reservationId,reservationGeneration)||null;}
  #claim(claim,purpose='dispatch'){
    if(!claim||!id(claim.attemptId)||!id(claim.owner)||!Number.isSafeInteger(claim.generation)||claim.generation<1)fail('reference_transfer_outbox_invalid');
    if(claim.kind!==purpose)fail('reference_transfer_outbox_claim_purpose');
    const state=this.journal.read(claim);return{attempt_id:claim.attemptId,job_id:state.job?.jobId,state};
  }
  prepare(claim,{job,reservation,manifestSha256,grantId,grantIdentitySha256,grant}={}){
    const now=this.now();
    if(!job||!id(job.jobId)||!Number.isSafeInteger(job.generation)||job.generation<1||!['staging','production'].includes(job.environment)||!HASH.test(manifestSha256||'')||job.manifestSha256!==manifestSha256||!reservation||!job.transferRequest||!id(reservation.reservationId)||reservation.generation!==job.generation||reservation.manifestSha256!==manifestSha256||typeof reservation.nonce!=='string'||!reservation.nonce||!Number.isSafeInteger(reservation.byteBudget)||reservation.byteBudget<1||typeof reservation.expiresAt!=='string'||!Number.isFinite(Date.parse(reservation.expiresAt))||!id(grantId)||!HASH.test(grantIdentitySha256||'')||!grant||typeof grant!=='object'||Array.isArray(grant)||!Number.isSafeInteger(now)||now<0)fail('reference_transfer_outbox_invalid');
    for(const key of ['reservationId','generation','nonce','manifestSha256','byteBudget','expiresAt'])if(job.transferRequest[key]!==reservation[key])fail('reference_transfer_outbox_binding');
    return this.tx(()=>{
      const owner=this.#claim(claim);if(owner.job_id!==job.jobId||owner.state.job?.generation!==job.generation||owner.state.job?.environment!==job.environment||owner.state.job?.manifestSha256!==manifestSha256||owner.state.request.manifest.sha256!==manifestSha256)fail('reference_transfer_outbox_binding');
      const objectIds=owner.state.request.manifest.objects.map(object=>object.id);
      if(!objectIds.length||objectIds.some(value=>!id(value))||new Set(objectIds).size!==objectIds.length)fail('reference_transfer_outbox_binding');
      const grantBinding={jobId:job.jobId,generation:job.generation,reservationId:reservation.reservationId,manifestSha256,environment:job.environment,objectIds,nonce:reservation.nonce,byteBudget:reservation.byteBudget,expiresAt:reservation.expiresAt};
      try{p.validateTransferGrant(grant,grantBinding)}catch{fail('reference_transfer_outbox_binding')}
      const grantSha256=digest(Buffer.from(JSON.stringify(grant))),canonicalGrantSha256=p.sha256(p.canonicalBytes(grant));
      const journal=this.db.prepare('SELECT environment,input_manifest_sha256,job_json FROM viewer_reference_attempt_journal WHERE attempt_id=?').get(claim.attemptId);
      if(!journal||journal.environment!==job.environment||journal.input_manifest_sha256!==manifestSha256||!journal.job_json)fail('reference_transfer_outbox_binding');
      let bound;try{bound=JSON.parse(journal.job_json)}catch{fail('reference_transfer_outbox_binding')}
      if(bound.jobId!==job.jobId||bound.generation!==job.generation||bound.environment!==job.environment||bound.manifestSha256!==manifestSha256)fail('reference_transfer_outbox_binding');
      const values={attempt_id:claim.attemptId,job_id:job.jobId,generation:job.generation,environment:job.environment,reservation_id:reservation.reservationId,reservation_generation:reservation.generation,reservation_nonce_sha256:digest(Buffer.from(reservation.nonce)),reservation_expires_at:reservation.expiresAt,reservation_byte_budget:reservation.byteBudget,manifest_sha256:manifestSha256,grant_id:grantId,grant_identity_sha256:grantIdentitySha256,grant_sha256:grantSha256};
      const old=this.db.prepare('SELECT * FROM viewer_reference_transfer_outbox WHERE attempt_id=? AND reservation_id=? AND reservation_generation=?').get(values.attempt_id,values.reservation_id,values.reservation_generation);
      if(old){for(const [key,value] of Object.entries(values))if(old[key]!==value)fail('reference_transfer_outbox_conflict');const binding=this.db.prepare('SELECT canonical_grant_sha256 FROM viewer_reference_transfer_grant_bindings WHERE outbox_id=?').get(old.outbox_id);if(!binding||binding.canonical_grant_sha256!==canonicalGrantSha256)fail('reference_transfer_outbox_grant_binding_missing');return old;}
      const outboxId=crypto.randomUUID(),stamp=new Date(now).toISOString();
      this.db.prepare(`INSERT INTO viewer_reference_transfer_outbox(outbox_id,attempt_id,job_id,generation,environment,reservation_id,reservation_generation,reservation_nonce_sha256,reservation_expires_at,reservation_byte_budget,manifest_sha256,grant_id,grant_identity_sha256,grant_sha256,state,send_attempts,sender_generation,acknowledgement_sha256,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,'prepared',0,0,NULL,?,?)`).run(outboxId,...Object.values(values),stamp,stamp);
      this.db.prepare('INSERT INTO viewer_reference_transfer_grant_bindings(outbox_id,canonical_grant_sha256,created_at) VALUES(?,?,?)').run(outboxId,canonicalGrantSha256,stamp);
      return this.row(outboxId);
    });
  }
  beginSend(claim,outboxId,{grantId,grantIdentitySha256,grant,provider}={}){if(!provider||typeof provider.postTransferGrant!=='function')fail('reference_transfer_outbox_invalid');const updated=this.tx(()=>{
    this.#claim(claim);const row=this.row(outboxId);if(row.attempt_id!==claim.attemptId)fail('reference_transfer_outbox_binding');
    const grantBinding=this.db.prepare('SELECT canonical_grant_sha256 FROM viewer_reference_transfer_grant_bindings WHERE outbox_id=?').get(outboxId);
    if(!grant||!id(grantId)||!HASH.test(grantIdentitySha256||'')||grantId!==row.grant_id||grantIdentitySha256!==row.grant_identity_sha256||digest(Buffer.from(JSON.stringify(grant)))!==row.grant_sha256||!grantBinding||p.sha256(p.canonicalBytes(grant))!==grantBinding.canonical_grant_sha256)fail('reference_transfer_outbox_binding');
    if(row.state==='acknowledged')return row;
    if(row.state!=='prepared'||claim.generation<=row.sender_generation)fail('reference_transfer_outbox_sender_unfenced');
    const now=this.now(),updated=new Date(now).toISOString();
    const result=this.db.prepare("UPDATE viewer_reference_transfer_outbox SET state='sending',send_attempts=send_attempts+1,sender_generation=?,updated_at=? WHERE outbox_id=? AND state='prepared' AND sender_generation<?").run(claim.generation,updated,outboxId,claim.generation);
    if(result.changes!==1)fail('reference_transfer_outbox_sender_unfenced');return this.row(outboxId);
  });if(updated.state==='sending')this.#sendProviders.set(outboxId,provider);return updated;}
  markUncertain(claim,outboxId){return this.#transition(claim,outboxId,row=>{
    if(row.state!=='sending'||row.sender_generation!==claim.generation)fail('reference_transfer_outbox_sender_unfenced');
    this.db.prepare("UPDATE viewer_reference_transfer_outbox SET state='uncertain',updated_at=? WHERE outbox_id=? AND state='sending' AND sender_generation=?").run(new Date(this.now()).toISOString(),outboxId,claim.generation);
  })}
  markHeld(claim,outboxId){return this.#transition(claim,outboxId,row=>{
    if(!['sending','uncertain'].includes(row.state)||row.sender_generation!==claim.generation)fail('reference_transfer_outbox_sender_unfenced');
    this.db.prepare("UPDATE viewer_reference_transfer_outbox SET state='held',updated_at=? WHERE outbox_id=? AND state IN ('sending','uncertain') AND sender_generation=?").run(new Date(this.now()).toISOString(),outboxId,claim.generation);
  })}
  acknowledge(claim,outboxId,ack){return this.#transition(claim,outboxId,row=>{
    const provider=this.#sendProviders.get(outboxId);
    const grantBinding=this.db.prepare('SELECT canonical_grant_sha256 FROM viewer_reference_transfer_grant_bindings WHERE outbox_id=?').get(outboxId);
    if(!grantBinding||!isVerifiedTransferGrantAck(ack,{provider,jobId:row.job_id,environment:row.environment,grantSha256:grantBinding.canonical_grant_sha256})||!ack||typeof ack!=='object'||Array.isArray(ack)||Object.keys(ack).sort().join(',')!=='accepted,generation,grantSha256,manifestSha256,nonce,reservationId'||ack.accepted!==true||ack.reservationId!==row.reservation_id||ack.generation!==row.reservation_generation||ack.manifestSha256!==row.manifest_sha256||ack.grantSha256!==grantBinding.canonical_grant_sha256||typeof ack.nonce!=='string'||digest(Buffer.from(ack.nonce))!==row.reservation_nonce_sha256)fail('reference_transfer_outbox_ack_binding');
    const canonical=JSON.stringify({reservationId:ack.reservationId,generation:ack.generation,manifestSha256:ack.manifestSha256,nonce:ack.nonce,grantSha256:ack.grantSha256,accepted:true}),ackHash=digest(Buffer.from(canonical));
    if(row.state==='acknowledged'){if(row.acknowledgement_sha256!==ackHash)fail('reference_transfer_outbox_ack_conflict');return;}
    if(row.state!=='sending'||row.sender_generation!==claim.generation)fail('reference_transfer_outbox_sender_unfenced');
    this.db.prepare("UPDATE viewer_reference_transfer_outbox SET state='acknowledged',acknowledgement_sha256=?,updated_at=? WHERE outbox_id=? AND state='sending' AND sender_generation=?").run(ackHash,new Date(this.now()).toISOString(),outboxId,claim.generation);
  })}
  reconcileAcknowledged(claim,outboxId,ack,{provider}={}){if(!provider)fail('reference_transfer_outbox_ack_binding');return this.tx(()=>{
    this.#claim(claim,'transfer-reconciliation');if(claim.outboxId!==outboxId)fail('reference_transfer_outbox_claim_purpose');const row=this.row(outboxId);if(row.attempt_id!==claim.attemptId)fail('reference_transfer_outbox_binding');
    const grantBinding=this.db.prepare('SELECT canonical_grant_sha256 FROM viewer_reference_transfer_grant_bindings WHERE outbox_id=?').get(outboxId);
    if(!grantBinding||!isVerifiedTransferGrantAck(ack,{provider,jobId:row.job_id,environment:row.environment,grantSha256:grantBinding.canonical_grant_sha256})||!ack||typeof ack!=='object'||Array.isArray(ack)||Object.keys(ack).sort().join(',')!=='accepted,generation,grantSha256,manifestSha256,nonce,reservationId'||ack.accepted!==true||ack.reservationId!==row.reservation_id||ack.generation!==row.reservation_generation||ack.manifestSha256!==row.manifest_sha256||ack.grantSha256!==grantBinding.canonical_grant_sha256||typeof ack.nonce!=='string'||digest(Buffer.from(ack.nonce))!==row.reservation_nonce_sha256)fail('reference_transfer_outbox_ack_binding');
    const canonical=JSON.stringify({reservationId:ack.reservationId,generation:ack.generation,manifestSha256:ack.manifestSha256,nonce:ack.nonce,grantSha256:ack.grantSha256,accepted:true}),ackHash=digest(Buffer.from(canonical));
    if(row.state==='acknowledged'){if(row.acknowledgement_sha256!==ackHash)fail('reference_transfer_outbox_ack_conflict');return this.row(outboxId);}
    if(!['sending','uncertain'].includes(row.state)||claim.generation<=row.sender_generation)fail('reference_transfer_outbox_sender_unfenced');
    const existing=this.db.prepare('SELECT * FROM viewer_reference_transfer_outbox_reconciliations WHERE outbox_id=?').get(outboxId);
    if(existing){if(existing.recovery_generation!==claim.generation||existing.canonical_grant_sha256!==grantBinding.canonical_grant_sha256||existing.acknowledgement_sha256!==ackHash)fail('reference_transfer_outbox_ack_conflict');}
    else this.db.prepare('INSERT INTO viewer_reference_transfer_outbox_reconciliations(outbox_id,recovery_generation,canonical_grant_sha256,acknowledgement_sha256,created_at) VALUES(?,?,?,?,?)').run(outboxId,claim.generation,grantBinding.canonical_grant_sha256,ackHash,new Date(this.now()).toISOString());
    this.db.prepare("UPDATE viewer_reference_transfer_outbox SET state='acknowledged',acknowledgement_sha256=?,updated_at=? WHERE outbox_id=? AND state IN ('sending','uncertain') AND sender_generation=?").run(ackHash,new Date(this.now()).toISOString(),outboxId,row.sender_generation);
    return this.row(outboxId);
  })}
  #transition(claim,outboxId,fn){return this.tx(()=>{this.#claim(claim);const row=this.row(outboxId);if(row.attempt_id!==claim.attemptId)fail('reference_transfer_outbox_binding');fn(row);return this.row(outboxId)})}
}
module.exports={ReferenceTransferOutbox,OUTBOX_COLUMNS};
