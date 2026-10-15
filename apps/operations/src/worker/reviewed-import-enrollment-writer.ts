const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SOURCE=/^project-alpha:[a-z0-9][a-z0-9_-]{0,63}$/;

export type ReviewedImportDestination=Readonly<{sourceId:string;sourceInstanceUUID:string;applicationUUID:string;
  historyEpoch:string;origin:string;externalCanonicalId:string}>;
export type ReviewedImportEnrollmentActor=Readonly<{staffId:string;accessSubject:string;admissionVersion:number;
  loginEmail:string;profileVersion:number;selectedProfileGrantId:string;selectedEnrollmentGrantId:string;verifiedUntil:string}>;
export type ReviewedImportEnrollmentWrite=Readonly<{mutationId:string;recordId:string;kind:"organization"|"client";
  expectedRecordVersion:number;expectedEnrollmentVersion:number;destinations:readonly ReviewedImportDestination[];
  actor:ReviewedImportEnrollmentActor}>;
export type ReviewedImportEnrollmentOutcome=
  |Readonly<{status:"written";replayed:boolean;recordId:string;enrollmentVersion:number;destinations:readonly ReviewedImportDestination[]}>
  |Readonly<{status:"conflict";reason:"idempotency_body_conflict"|"stale_record"|"stale_enrollment"}>
  |Readonly<{status:"blocked";reason:"authority_or_evidence"}>
  |Readonly<{status:"rejected";reason:"invalid_write"}>;

function plain(value:unknown):value is Record<string,unknown>{
  try{return !!value&&typeof value==="object"&&!Array.isArray(value)&&[Object.prototype,null].includes(Object.getPrototypeOf(value));}
  catch{return false;}
}
function destination(value:unknown):value is ReviewedImportDestination{
  if(!plain(value)||Object.keys(value).length!==6||typeof value.sourceId!=="string"||!SOURCE.test(value.sourceId)
    ||typeof value.sourceInstanceUUID!=="string"||!UUID.test(value.sourceInstanceUUID)
    ||typeof value.applicationUUID!=="string"||!UUID.test(value.applicationUUID)
    ||typeof value.historyEpoch!=="string"||!UUID.test(value.historyEpoch)
    ||typeof value.externalCanonicalId!=="string"||value.externalCanonicalId.length<1||value.externalCanonicalId.length>764
    ||typeof value.origin!=="string")return false;
  try{const url=new URL(value.origin);return url.protocol==="https:"&&url.origin===value.origin;}catch{return false;}
}
function normalize(values:readonly ReviewedImportDestination[]):readonly ReviewedImportDestination[]|null{
  if(!Array.isArray(values)||values.length<1||values.length>16||!values.every(destination))return null;
  const sorted=values.map(value=>({sourceId:value.sourceId,sourceInstanceUUID:value.sourceInstanceUUID,
    applicationUUID:value.applicationUUID,historyEpoch:value.historyEpoch,origin:value.origin,
    externalCanonicalId:value.externalCanonicalId})).sort((a,b)=>a.sourceId.localeCompare(b.sourceId));
  return new Set(sorted.map(value=>JSON.stringify(value))).size===sorted.length&&new Set(sorted.map(value=>value.sourceId)).size===sorted.length?sorted:null;
}
function valid(input:ReviewedImportEnrollmentWrite,now:number):boolean{
  if(!plain(input)||!UUID.test(input.mutationId)||typeof input.recordId!=="string"||input.recordId.length<1||input.recordId.length>191
    ||!['organization','client'].includes(input.kind)||!Number.isSafeInteger(input.expectedRecordVersion)||input.expectedRecordVersion<1
    ||!Number.isSafeInteger(input.expectedEnrollmentVersion)||input.expectedEnrollmentVersion<0||!plain(input.actor))return false;
  const actor=input.actor,expiry=typeof actor.verifiedUntil==='string'?Date.parse(actor.verifiedUntil):NaN;
  return typeof actor.staffId==='string'&&typeof actor.accessSubject==='string'&&typeof actor.loginEmail==='string'
    &&Number.isSafeInteger(actor.admissionVersion)&&actor.admissionVersion>0&&Number.isSafeInteger(actor.profileVersion)&&actor.profileVersion>0
    &&typeof actor.selectedProfileGrantId==='string'&&typeof actor.selectedEnrollmentGrantId==='string'
    &&Number.isSafeInteger(expiry)&&new Date(expiry).toISOString()===actor.verifiedUntil&&expiry>now;
}
async function id(seed:string):Promise<string>{
  const bytes=new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(seed))).slice(0,16);
  bytes[6]=(bytes[6]!&15)|64;bytes[8]=(bytes[8]!&63)|128;const hex=[...bytes].map(v=>v.toString(16).padStart(2,'0')).join('');
  return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
}

export async function writeReviewedImportEnrollment(db:D1Database,input:ReviewedImportEnrollmentWrite,now=Date.now()):Promise<ReviewedImportEnrollmentOutcome>{
  if(!plain(input)||!Number.isSafeInteger(now)||now<0||!valid(input,now))return{status:'rejected',reason:'invalid_write'};
  const destinations=normalize(input.destinations);
  if(!destinations)return{status:'rejected',reason:'invalid_write'};
  const encoded=JSON.stringify(destinations),actor=input.actor;
  const prior=await db.prepare(`SELECT admission.record_id,admission.record_kind,admission.expected_record_version,
    admission.expected_enrollment_version,admission.destinations_json,admission.actor_staff_id,admission.actor_access_subject,
    admission.actor_admission_version,admission.actor_email,admission.actor_profile_version,
    admission.selected_profile_grant_id,admission.selected_enrollment_grant_id,admission.actor_verified_until,
    receipt.enrollment_version FROM reviewed_import_enrollment_admissions admission
    JOIN reviewed_import_enrollment_receipts receipt ON receipt.admission_id=admission.admission_id WHERE admission.mutation_id=?`)
    .bind(input.mutationId).first<Record<string,unknown>>();
  if(prior){
    const same=prior.record_id===input.recordId&&prior.record_kind===input.kind&&prior.expected_record_version===input.expectedRecordVersion
      &&prior.expected_enrollment_version===input.expectedEnrollmentVersion&&prior.destinations_json===encoded
      &&prior.actor_staff_id===actor.staffId&&prior.actor_access_subject===actor.accessSubject&&prior.actor_admission_version===actor.admissionVersion
      &&prior.actor_email===actor.loginEmail&&prior.actor_profile_version===actor.profileVersion
      &&prior.selected_profile_grant_id===actor.selectedProfileGrantId&&prior.selected_enrollment_grant_id===actor.selectedEnrollmentGrantId;
    return same?{status:'written',replayed:true,recordId:input.recordId,enrollmentVersion:Number(prior.enrollment_version),destinations}
      :{status:'conflict',reason:'idempotency_body_conflict'};
  }
  const record=await db.prepare('SELECT record_kind,current_version FROM operations_directory_records WHERE record_id=?').bind(input.recordId)
    .first<{record_kind:string;current_version:number}>();
  if(!record||record.record_kind!==input.kind||record.current_version!==input.expectedRecordVersion)return{status:'conflict',reason:'stale_record'};
  const current=await db.prepare('SELECT coalesce(max(enrollment_version),0) version FROM reviewed_import_enrollment_receipts WHERE record_id=?')
    .bind(input.recordId).first<number>('version');
  if(current!==input.expectedEnrollmentVersion)return{status:'conflict',reason:'stale_enrollment'};
  const admissionId=await id(`${input.mutationId}:admission`),receiptId=await id(`${input.mutationId}:receipt`);
  const timestamp=new Date(now).toISOString(),authorizationDeadline=new Date(Math.min(Date.parse(actor.verifiedUntil),now+15*60_000)).toISOString();
  const version=input.expectedEnrollmentVersion+1;
  try{
    await db.batch([
      db.prepare(`INSERT INTO reviewed_import_enrollment_admissions(admission_id,mutation_id,record_id,record_kind,enrollment_version,
        expected_record_version,expected_enrollment_version,destinations_json,actor_staff_id,actor_access_subject,
        actor_admission_version,actor_email,actor_profile_version,selected_profile_grant_id,selected_enrollment_grant_id,
        actor_verified_until,reviewed_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .bind(admissionId,input.mutationId,input.recordId,input.kind,version,input.expectedRecordVersion,input.expectedEnrollmentVersion,
          encoded,actor.staffId,actor.accessSubject,actor.admissionVersion,actor.loginEmail,actor.profileVersion,
          actor.selectedProfileGrantId,actor.selectedEnrollmentGrantId,authorizationDeadline,timestamp),
      db.prepare(`INSERT INTO reviewed_import_enrollment_receipts(receipt_id,admission_id,mutation_id,record_id,enrollment_version,
        destinations_json,admitted_by_staff_id,admitted_at) VALUES(?,?,?,?,?,?,?,?)`)
        .bind(receiptId,admissionId,input.mutationId,input.recordId,version,encoded,actor.staffId,timestamp),
    ]);
  }catch{return{status:'blocked',reason:'authority_or_evidence'};}
  return{status:'written',replayed:false,recordId:input.recordId,enrollmentVersion:version,destinations};
}

