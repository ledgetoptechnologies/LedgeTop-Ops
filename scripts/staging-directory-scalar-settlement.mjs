// Pure, read-only validation of caller-supplied staging evidence. This module
// neither reads D1 nor grants/revokes authority; callers must supply exact rows.

const own = (v, k) => Object.prototype.hasOwnProperty.call(v, k);
const object = v => v !== null && typeof v === "object" && !Array.isArray(v);
const json = v => { try { return typeof v === "string" ? JSON.parse(v) : null; } catch { return null; } };
const stable = v => JSON.stringify(v, (_, x) => object(x)
  ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => a.localeCompare(b))) : x);
const equal = (a, b) => stable(a) === stable(b);
const exactKeys = (v, keys) => object(v) && equal(Object.keys(v).sort(), [...keys].sort());
const uint64 = (v, positive = false) => typeof v === "string" && /^(0|[1-9][0-9]{0,18})$/.test(v)
  && (!positive || v !== "0") && BigInt(v) <= 9223372036854775807n;
const revision = v => uint64(v, true);
const advances = (next, prior) => revision(next) && revision(prior)
  && (next.length > prior.length || (next.length === prior.length && next > prior));
const fail = message => { throw new Error(`directory scalar settlement: ${message}`); };
const need = (condition, message) => { if (!condition) fail(message); };
function safeJsonTree(value, depth = 0) {
  need(depth <= 32, "evidence nesting is too deep");
  if (value === null || typeof value === "boolean") return;
  if (typeof value === "string") { need(new TextEncoder().encode(value).byteLength <= 1_048_576, "evidence string is too large"); return; }
  if (typeof value === "number") { need(Number.isFinite(value), "evidence contains a non-finite number"); return; }
  need(typeof value === "object", "evidence is not JSON-safe");
  if (Array.isArray(value)) { need(value.length <= 100_000, "evidence array is too large"); for (const item of value) safeJsonTree(item, depth + 1); return; }
  need(Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null, "evidence object prototype is invalid");
  for (const [key, item] of Object.entries(value)) { need(item !== undefined && key.length <= 1024, "evidence contains undefined or oversized key"); safeJsonTree(item, depth + 1); }
}
const unique = (rows, key, label) => {
  need(Array.isArray(rows), `${label} must be an array`);
  need(new Set(rows.map(key)).size === rows.length, `${label} identities must be unique`);
};

const destinationKey = row => [row.source_id, row.source_instance_uuid, row.application_uuid,
  row.expected_history_epoch_id, row.destination_origin].join("\0");
const enrolledKey = row => [row.sourceId, row.sourceInstanceUUID, row.applicationUUID,
  row.historyEpoch, row.origin].join("\0");
const activationKeys=["activation_id","review_receipt_id","idempotency_key","acquired_receipt_id","native_owner_claim_id","record_id","source_id","source_instance_id","application_id","history_epoch_id","resource_type","external_id","project_alpha_public_id","project_alpha_revision","local_record_version","request_sha256","acquisition_evidence_sha256","profile_evidence_sha256","binding_status_evidence_sha256","activated_by_staff_id","directory_grant_generation","activated_at","expected_authorization_generation","result_authorization_generation"];
const refreshCommandKeys=["command_id","request_sha256","predecessor_kind","predecessor_acquired_receipt_id","predecessor_refresh_receipt_id","native_owner_claim_id","record_id","source_id","source_instance_id","application_id","history_epoch_id","resource_type","external_id","project_alpha_public_id","expected_prior_revision","expected_live_revision","expected_authorization_generation","expected_local_record_version","created_at"];
const refreshReceiptKeys=["receipt_id","request_sha256","command_id","native_owner_claim_id","record_id","source_id","source_instance_id","application_id","history_epoch_id","resource_type","external_id","project_alpha_public_id","prior_revision","live_revision","authorization_generation","local_record_version","pa_request_id","pa_replayed","response_sha256","received_at","created_at"];

function acquiredTuple(row,d,plan,localKey="local_record_version") { return row.record_id===plan.recordId&&row.source_id===d.sourceId
  &&row.source_instance_id===d.sourceInstanceUUID&&row.application_id===d.applicationUUID&&row.history_epoch_id===d.historyEpoch
  &&row.resource_type===plan.kind&&row.external_id===d.externalCanonicalId&&row.project_alpha_public_id===d.projectAlphaPublicId
  &&Number.isSafeInteger(row[localKey])&&row[localKey]>=1; }
function validateAcquiredEvidence(d,plan) {
  const evidence=d.acquisitionEvidence,mapping=evidence?.activeMapping,proof=evidence?.authoritativeHeadEvidence,activation=proof?.activationReceipt;
  need(exactKeys(evidence,["activeMapping","authoritativeHeadEvidence"])
    && exactKeys(mapping,["source_id","resource_type","record_id","external_id","project_alpha_public_id","source_instance_id","application_id","history_epoch_id","provenance_id","mapping_kind","created_at"])
    && exactKeys(proof,["schemaVersion","activationReceipt","refreshes","deliveries"])&&proof.schemaVersion===1
    && exactKeys(activation,activationKeys)&&mapping.mapping_kind==="acquired"&&mapping.provenance_id===activation.activation_id
    && mapping.record_id===plan.recordId&&mapping.source_id===d.sourceId&&mapping.source_instance_id===d.sourceInstanceUUID
    && mapping.application_id===d.applicationUUID&&mapping.history_epoch_id===d.historyEpoch&&mapping.resource_type===plan.kind
    && mapping.external_id===d.externalCanonicalId&&mapping.project_alpha_public_id===d.projectAlphaPublicId&&acquiredTuple(activation,d,plan)
    && activation.record_id===mapping.record_id&&activation.local_record_version<=plan.expectedLocalVersion
    && revision(activation.project_alpha_revision)&&uint64(activation.expected_authorization_generation)
    &&uint64(activation.result_authorization_generation),
    "changed external ID lacks exact active mapping and activation receipt provenance");
  need(Array.isArray(proof.refreshes)&&Array.isArray(proof.deliveries),"acquired authoritative evidence is not array-complete");
  const refreshes=proof.refreshes.map(entry=>{need(exactKeys(entry,["command","receipt"])&&exactKeys(entry.command,refreshCommandKeys)
      &&exactKeys(entry.receipt,refreshReceiptKeys),"refresh head evidence shape is not exact");
    const c=entry.command,r=entry.receipt;
    need(acquiredTuple(c,d,plan,"expected_local_record_version")&&c.expected_local_record_version===plan.expectedLocalVersion
      &&acquiredTuple(r,d,plan)&&r.local_record_version===plan.expectedLocalVersion&&c.command_id===r.command_id
      &&c.request_sha256===r.request_sha256&&c.native_owner_claim_id===r.native_owner_claim_id
      &&c.native_owner_claim_id===activation.native_owner_claim_id
      &&c.expected_prior_revision===r.prior_revision&&c.expected_live_revision===r.live_revision
      &&advances(r.live_revision,r.prior_revision)&&revision(c.expected_authorization_generation)
      &&uint64(r.authorization_generation)&&BigInt(r.authorization_generation)===BigInt(c.expected_authorization_generation)+1n,
      "refresh head evidence is not exact");return entry});
  need(!refreshes.length||activation.local_record_version===plan.expectedLocalVersion,"refresh activation local version is not exact");
  unique(refreshes,x=>x.receipt.receipt_id,"refresh receipts");unique(refreshes,x=>x.command.command_id,"refresh commands");
  for(const {command} of refreshes) need(command.predecessor_kind==="acquired_mapping"
    ? command.predecessor_acquired_receipt_id===activation.acquired_receipt_id&&command.predecessor_refresh_receipt_id===null
      &&command.expected_prior_revision===activation.project_alpha_revision
    : command.predecessor_kind==="revision_refresh"&&command.predecessor_acquired_receipt_id===null
      &&refreshes.some(x=>x.receipt.receipt_id===command.predecessor_refresh_receipt_id
        &&command.expected_prior_revision===x.receipt.live_revision),"refresh predecessor chain is not exact");
  const terminals=refreshes.filter(candidate=>!refreshes.some(x=>x.command.predecessor_refresh_receipt_id===candidate.receipt.receipt_id));
  let chainComplete=refreshes.length===0;
  if(terminals.length===1){const seen=new Set();let cursor=terminals[0];while(cursor&&!seen.has(cursor.receipt.receipt_id)){seen.add(cursor.receipt.receipt_id);
      cursor=cursor.command.predecessor_kind==="revision_refresh"
        ?refreshes.find(x=>x.receipt.receipt_id===cursor.command.predecessor_refresh_receipt_id):undefined}
    chainComplete=seen.size===refreshes.length&&[...seen].some(id=>refreshes.find(x=>x.receipt.receipt_id===id)?.command.predecessor_kind==="acquired_mapping");}
  need(chainComplete,"refresh chain has no unique terminal head");
  const candidates=[];
  if(!refreshes.length&&activation.local_record_version===plan.expectedLocalVersion)candidates.push({revision:activation.project_alpha_revision,generation:activation.result_authorization_generation});
  if(terminals.length)candidates.push({revision:terminals[0].receipt.live_revision,generation:terminals[0].receipt.authorization_generation});
  for(const entry of proof.deliveries){need(exactKeys(entry,["intent","materialization","outbox"]),"delivery head evidence shape is not exact");
    const i=entry.intent,m=entry.materialization,o=entry.outbox,wire=json(m.command_json),outcome=json(o.outcome_json),response=outcome?.response,resource=response?.result?.resource;
    need(i.record_id===plan.recordId&&i.record_version===plan.expectedLocalVersion&&i.state==="acknowledged"
      &&i.source_id===d.sourceId&&i.source_instance_uuid===d.sourceInstanceUUID&&i.application_uuid===d.applicationUUID
      &&i.expected_history_epoch_id===d.historyEpoch&&i.destination_origin===d.origin&&i.external_canonical_id===d.externalCanonicalId
      &&m.intent_id===i.intent_id&&m.history_epoch_id===i.expected_history_epoch_id&&o.command_id===m.command_id&&o.command_json===m.command_json
      &&o.state==="acknowledged"&&o.source_id===d.sourceId&&o.expected_source_instance_id===d.sourceInstanceUUID
      &&o.application_id===d.applicationUUID&&o.expected_history_epoch_id===d.historyEpoch&&o.destination_base_url===d.origin
      &&o.resource_type===plan.kind&&o.external_id===d.externalCanonicalId&&wire?.operation==="update"
      &&wire.expectedProjectAlphaPublicId===d.projectAlphaPublicId&&outcome?.status==="acknowledged"
      &&response?.sourceInstanceId===d.sourceInstanceUUID&&response?.applicationId===d.applicationUUID&&response?.historyEpoch===d.historyEpoch
      &&resource?.type===plan.kind&&resource?.publicId===d.projectAlphaPublicId&&revision(resource?.revision)
      &&uint64(response?.result?.authorizationGeneration),"delivery head evidence is not exact");
    candidates.push({revision:resource.revision,generation:response.result.authorizationGeneration});}
  need(candidates.length>0,"acquired authoritative head is absent");
  const maximum=candidates.reduce((a,b)=>a.revision.length>b.revision.length||(a.revision.length===b.revision.length&&a.revision>b.revision)?a:b).revision;
  const heads=new Map(candidates.filter(x=>x.revision===maximum).map(x=>[`${x.revision}\0${x.generation}`,x]));
  need(heads.size===1,"acquired authoritative head is ambiguous");const head=heads.values().next().value;
  need(head.revision===d.revision&&head.generation===d.authorizationGeneration&&head.generation===d.expectedAuthorizationGeneration,
    "acquired authoritative head differs from trusted destination");
}

function validatePlan(plan) {
  need(exactKeys(plan, ["recordId", "kind", "mutationId", "actor", "expectedLocalVersion", "field",
    "beforeProfile", "afterProfile", "destinations", "temporaryGrantIds"]), "plan shape is not exact");
  need(plan.kind === "client" || plan.kind === "organization", "kind is invalid");
  need(Number.isSafeInteger(plan.expectedLocalVersion) && plan.expectedLocalVersion >= 1, "version is invalid");
  need(typeof plan.field === "string" && own(plan.beforeProfile, plan.field) && own(plan.afterProfile, plan.field), "field is absent");
  need(exactKeys(plan.actor, ["staffId", "accessSubject", "loginEmail", "admissionVersion", "profileVersion",
    "selectedGrantId", "selectedIdentityGrantId"]), "actor shape is not exact");
  const grantKeys = plan.kind === "client" ? ["profileEdit", "identityLink"] : ["profileEdit"];
  need(exactKeys(plan.temporaryGrantIds, grantKeys), "temporary grant IDs are not exact");
  if (plan.kind === "client") need(plan.temporaryGrantIds.profileEdit !== plan.temporaryGrantIds.identityLink, "temporary grants must be distinct");
  need(Array.isArray(plan.destinations) && plan.destinations.length > 0, "trusted destination prestate is absent");
  unique(plan.destinations, x => [x.sourceId,x.sourceInstanceUUID,x.applicationUUID,x.historyEpoch,x.origin].join("\0"), "trusted destinations");
  for (const d of plan.destinations) {
    need(exactKeys(d,["sourceId","sourceInstanceUUID","applicationUUID","historyEpoch","origin","enrollmentExternalCanonicalId",
      "externalCanonicalId","projectAlphaPublicId","revision","authorizationGeneration","expectedAuthorizationGeneration","acquisitionEvidence"]), "trusted destination shape is not exact");
    need(revision(d.revision) && uint64(d.authorizationGeneration) && uint64(d.expectedAuthorizationGeneration), "trusted destination revisions are invalid");
    need(d.authorizationGeneration === d.expectedAuthorizationGeneration, "ordinary update authorization generation is inconsistent");
    if(d.externalCanonicalId===plan.recordId)need(d.acquisitionEvidence===null,"unchanged external ID must not claim acquisition provenance");
    else validateAcquiredEvidence(d,plan);
  }
  const keys = new Set([...Object.keys(plan.beforeProfile), ...Object.keys(plan.afterProfile)]);
  const changed = [...keys].filter(k => !equal(plan.beforeProfile[k], plan.afterProfile[k]));
  need(equal(changed, [plan.field]), "profile must have exactly one scalar difference");
  need(["string", "number", "boolean"].includes(typeof plan.beforeProfile[plan.field])
    && ["string", "number", "boolean"].includes(typeof plan.afterProfile[plan.field]), "planned values must be scalar");
  if (plan.kind === "client") need(!own(plan.afterProfile, "clientType"), "client update profile must omit clientType");
}

function protectedShape(value) {
  need(exactKeys(value,["records","resourceScopes","enrollments","relationships","relationshipHistory"]), "protected snapshots are not exact named table projections");
  for (const rows of Object.values(value)) need(Array.isArray(rows), "protected table projection must be an array");
}
function cleanupProtectedShape(value) {
  need(exactKeys(value,["otherGrants","actorAdmission","actorProfile","otherGrantGenerations"]),
    "cleanup protected snapshots are not exact named authority projections");
  for (const rows of Object.values(value)) need(Array.isArray(rows), "cleanup protected authority projection must be an array");
}

/** Phase 1: prove the full-profile scalar update reached durable PA acknowledgement. */
export function validateAcknowledgedScalarUpdate(input) {
  safeJsonTree(input);
  need(exactKeys(input, ["plan", "before", "settled"]), "phase-one input shape is not exact");
  validatePlan(input.plan);
  const { plan, before, settled } = input, v = plan.expectedLocalVersion, next = v + 1;
  const phaseKeys = ["record", "revisions", "audits", "intents", "materializations", "outbox", "relationshipDependencies", "relationshipDependencyEvidence", "relationship",
    "relationshipHistory", "resourceScopes", "enrollment", "protectedSnapshots"];
  need(exactKeys(before, phaseKeys) && exactKeys(settled, phaseKeys), "phase-one snapshots are incomplete or extra");
  protectedShape(before.protectedSnapshots); protectedShape(settled.protectedSnapshots);
  need(equal(before.protectedSnapshots, settled.protectedSnapshots), "unrelated protected snapshots changed");
  need(equal(before.relationship, settled.relationship), "relationship changed");
  need(equal(before.relationshipHistory, settled.relationshipHistory), "relationship history changed");
  need(equal(before.resourceScopes, settled.resourceScopes), "resource scopes changed");
  need(equal(before.enrollment, settled.enrollment), "enrollment changed");
  need(before.record.record_id === plan.recordId && before.record.record_kind === plan.kind
    && before.record.current_version === v, "before record is not the planned version");
  need(settled.record.record_id === plan.recordId && settled.record.record_kind === plan.kind
    && settled.record.current_version === next, "record did not advance exactly once");
  need(Array.isArray(before.revisions) && Array.isArray(settled.revisions)
    && settled.revisions.length === before.revisions.length + 1, "revision set delta is not one");
  need(before.revisions.every(r => settled.revisions.some(x => equal(x, r))), "prior revision evidence changed");
  unique(before.revisions, r => `${r.record_id}\0${r.version}`, "before revisions");
  unique(settled.revisions, r => `${r.record_id}\0${r.version}`, "settled revisions");
  const priorRevision = before.revisions.filter(r => r.record_id === plan.recordId && r.version === v);
  need(priorRevision.length === 1 && equal(json(priorRevision[0].profile_json), plan.beforeProfile), "trusted V revision/profile is absent or ambiguous");
  const addedRevision = settled.revisions.filter(r => !before.revisions.some(x => equal(x, r)));
  need(addedRevision.length === 1 && addedRevision[0].record_id === plan.recordId && addedRevision[0].version === next
    && addedRevision[0].mutation_id === plan.mutationId && equal(json(addedRevision[0].profile_json), plan.afterProfile), "new revision is not exact");
  need(settled.audits.length === before.audits.length + 1 && before.audits.every(r => settled.audits.some(x => equal(x, r))), "audit set is not append-only");
  unique(before.audits, a => a.audit_id, "before audits"); unique(settled.audits, a => a.audit_id, "settled audits");
  const audit = settled.audits.find(a => a.mutation_id === plan.mutationId);
  need(audit && audit.audit_id === `${plan.mutationId}:audit` && audit.record_id === plan.recordId
    && audit.record_version === next && audit.actor_type === "staff" && audit.actor_id === plan.actor.staffId
    && audit.original_verified_access_subject === plan.actor.accessSubject, "audit identity is not exact");
  const enrollment = json(settled.enrollment.destinations_json);
  need(Array.isArray(enrollment) && enrollment.length > 0, "enrolled destinations are invalid");
  unique(enrollment, enrolledKey, "enrollment destinations");
  for (const enrolled of enrollment) {
    const trusted=plan.destinations.find(d=>enrolledKey(d)===enrolledKey(enrolled));
    need(trusted && enrolled.externalCanonicalId===trusted.enrollmentExternalCanonicalId, "enrollment external ID is not bound to trusted prestate");
  }
  const command = json(audit.command_json), commandDestinations = plan.destinations.map(d => ({sourceId:d.sourceId,sourceInstanceUUID:d.sourceInstanceUUID,
    applicationUUID:d.applicationUUID,historyEpoch:d.historyEpoch,origin:d.origin,externalCanonicalId:d.externalCanonicalId,
    expectedAuthorizationGeneration:d.expectedAuthorizationGeneration}));
  const expectedRelationship = plan.kind === "client" ? {
    organizationRecordId: settled.relationship.organization_record_id,
    expectedRelationshipVersion: settled.relationship.relationship_version,
  } : null;
  need(equal(command, { operation: "update", mutationId: plan.mutationId, resourceType: plan.kind,
    recordId: plan.recordId, expectedLocalVersion: v, actor: plan.actor, fields: plan.afterProfile, scopes: null,
    destinations: commandDestinations, createAdmissionId: null, relationship: expectedRelationship }), "audit command is not exact");
  const intents = settled.intents.filter(x => x.mutation_id === plan.mutationId);
  unique(before.intents, x => x.intent_id, "before intents"); unique(settled.intents, x => x.intent_id, "settled intents");
  need(intents.length === enrollment.length, "intent cardinality differs from enrollment");
  need(settled.intents.length === before.intents.length + enrollment.length
    && before.intents.every(r => settled.intents.some(x => equal(x, r))), "intent set has incomplete or extra changes");
  unique(intents, destinationKey, "intents");
  need(equal(intents.map(destinationKey).sort(), enrollment.map(enrolledKey).sort()), "intent destinations differ from enrollment");
  need(intents.every(x => x.record_id === plan.recordId && x.record_version === next && x.state === "acknowledged"
    && equal(json(x.desired_payload_json), plan.afterProfile)), "intent row is malformed or unacknowledged");
  unique(before.relationshipDependencies, x => x.intent_id, "before relationship dependencies");
  unique(settled.relationshipDependencies, x => x.intent_id, "settled relationship dependencies");
  unique(before.relationshipDependencyEvidence, x => x.intent_id, "before relationship dependency evidence");
  unique(settled.relationshipDependencyEvidence, x => x.intent_id, "settled relationship dependency evidence");
  need(before.relationshipDependencyEvidence.every(r => settled.relationshipDependencyEvidence.some(x => equal(x,r))), "prior relationship dependency provenance changed");
  need(before.relationshipDependencies.every(r => settled.relationshipDependencies.some(x => equal(x,r))), "prior relationship dependencies changed");
  need(settled.relationshipDependencies.length === before.relationshipDependencies.length + (plan.kind === "client" ? intents.length : 0),
    "relationship dependency delta is not exact");
  const acquiredDependencyCount=settled.relationshipDependencies.filter(x=>intents.some(i=>i.intent_id===x.intent_id)&&x.evidence_kind==="acquired_mapping").length;
  need(settled.relationshipDependencyEvidence.length===before.relationshipDependencyEvidence.length+acquiredDependencyCount,
    "relationship dependency provenance delta is not exact");
  const mats = settled.materializations.filter(x => intents.some(i => i.intent_id === x.intent_id));
  const outbox = settled.outbox.filter(x => mats.some(m => m.command_id === x.command_id));
  unique(before.materializations, x => x.intent_id, "before materializations");
  unique(settled.materializations, x => x.intent_id, "settled materializations");
  unique(before.outbox, x => x.command_id, "before outbox"); unique(settled.outbox, x => x.command_id, "settled outbox");
  need(mats.length === intents.length && outbox.length === intents.length, "materialization/outbox cardinality is not exact");
  need(settled.materializations.length === before.materializations.length + enrollment.length
    && before.materializations.every(r => settled.materializations.some(x => equal(x, r))), "materialization set has incomplete or extra changes");
  need(settled.outbox.length === before.outbox.length + enrollment.length
    && before.outbox.every(r => settled.outbox.some(x => equal(x, r))), "outbox set has incomplete or extra changes");
  unique(mats, x => x.intent_id, "materializations"); unique(outbox, x => x.command_id, "outbox");
  for (const intent of intents) {
    const mat = mats.find(x => x.intent_id === intent.intent_id), box = mat && outbox.find(x => x.command_id === mat.command_id);
    need(mat && box, "intent lacks exact delivery evidence");
    const wire = json(mat.command_json), origin = json(mat.origin_snapshot_json), disposition = json(mat.disposition_json), outcome = json(box.outcome_json);
    const trusted = plan.destinations.find(d => enrolledKey(d) === destinationKey(intent));
    need(trusted && intent.external_canonical_id === trusted.externalCanonicalId, "intent is not bound to trusted remote prestate");
    need(wire && wire.operation === "update" && wire.commandId === mat.command_id && wire.resourceType === plan.kind
      && wire.externalId === trusted.externalCanonicalId && wire.expectedProjectAlphaPublicId === trusted.projectAlphaPublicId
      && wire.expectedRevision === trusted.revision && wire.expectedAuthorizationGeneration === trusted.authorizationGeneration
      && !own(wire, "scopes"), "wire update command is malformed");
    const dependency = plan.kind === "client" ? settled.relationshipDependencies.find(d => d.intent_id === intent.intent_id) : null;
    if (plan.kind === "client") need(dependency && exactKeys(dependency,["intent_id","client_record_id","client_record_version","relationship_version",
      "relationship_mutation_id","organization_record_id","organization_record_version","source_id","source_instance_uuid","application_uuid",
      "history_epoch_id","destination_origin","parent_external_canonical_id","evidence_kind","parent_intent_id","parent_mapping_command_id",
      "parent_activation_id","parent_public_id","parent_ack_revision","parent_ack_command_json","parent_ack_outcome_json","resolved_parent_public_id"])
      && ["unlinked","parent_intent","existing_mapping","acquired_mapping"].includes(dependency.evidence_kind)
      && typeof dependency.relationship_mutation_id === "string"
      && dependency.client_record_id === plan.recordId && dependency.client_record_version === next
      && dependency.relationship_version === settled.relationship.relationship_version && dependency.organization_record_id === settled.relationship.organization_record_id
      && dependency.source_id === intent.source_id && dependency.source_instance_uuid === intent.source_instance_uuid
      && dependency.application_uuid === intent.application_uuid && dependency.history_epoch_id === intent.expected_history_epoch_id
      && dependency.destination_origin === intent.destination_origin
      && (dependency.organization_record_id === null
        ? dependency.evidence_kind === "unlinked" && dependency.organization_record_version === null && dependency.resolved_parent_public_id === null
        : Number.isSafeInteger(dependency.organization_record_version) && dependency.organization_record_version >= 1
          && typeof dependency.parent_external_canonical_id === "string" && typeof dependency.resolved_parent_public_id === "string"
          && (dependency.evidence_kind === "parent_intent" ? typeof dependency.parent_intent_id === "string"
            : dependency.evidence_kind === "existing_mapping" ? typeof dependency.parent_mapping_command_id === "string"
              && typeof dependency.parent_ack_command_json === "string" && typeof dependency.parent_ack_outcome_json === "string"
            : dependency.evidence_kind === "acquired_mapping" && typeof dependency.parent_activation_id === "string")),
      "client relationship dependency is absent or mismatched");
    if(dependency?.evidence_kind === "acquired_mapping") {
      const proof=settled.relationshipDependencyEvidence.find(x=>x.intent_id===intent.intent_id);
      const mapping=proof?.activeMapping,receipt=proof?.activationReceipt;
      need(proof && exactKeys(proof,["intent_id","activeMapping","activationReceipt"])
        && exactKeys(mapping,["source_id","resource_type","record_id","external_id","project_alpha_public_id","source_instance_id","application_id","history_epoch_id","provenance_id","mapping_kind","created_at"])
        && exactKeys(receipt,["activation_id","review_receipt_id","idempotency_key","acquired_receipt_id","native_owner_claim_id","record_id","source_id","source_instance_id","application_id","history_epoch_id","resource_type","external_id","project_alpha_public_id","project_alpha_revision","local_record_version","request_sha256","acquisition_evidence_sha256","profile_evidence_sha256","binding_status_evidence_sha256","activated_by_staff_id","directory_grant_generation","activated_at","expected_authorization_generation","result_authorization_generation"])
        && mapping.mapping_kind==="acquired" && mapping.provenance_id===dependency.parent_activation_id
        && mapping.record_id===dependency.organization_record_id && mapping.resource_type==="organization"
        && mapping.source_id===dependency.source_id && mapping.source_instance_id===dependency.source_instance_uuid
        && mapping.application_id===dependency.application_uuid && mapping.history_epoch_id===dependency.history_epoch_id
        && mapping.external_id===dependency.parent_external_canonical_id && mapping.project_alpha_public_id===dependency.resolved_parent_public_id
        && dependency.parent_public_id===mapping.project_alpha_public_id
        && receipt.activation_id===mapping.provenance_id && receipt.record_id===mapping.record_id && receipt.resource_type===mapping.resource_type
        && receipt.source_id===mapping.source_id && receipt.source_instance_id===mapping.source_instance_id
        && receipt.application_id===mapping.application_id && receipt.history_epoch_id===mapping.history_epoch_id
        && receipt.external_id===mapping.external_id && receipt.project_alpha_public_id===mapping.project_alpha_public_id
        && receipt.local_record_version===dependency.organization_record_version && receipt.project_alpha_revision===dependency.parent_ack_revision
        && revision(receipt.project_alpha_revision) && dependency.parent_intent_id===null && dependency.parent_mapping_command_id===null
        && dependency.parent_ack_command_json===null && dependency.parent_ack_outcome_json===null,
        "acquired parent dependency lacks exact active mapping and activation receipt provenance");
    }
    const expectedFields = plan.kind === "client" ? { ...plan.afterProfile, organizationPublicId: dependency.resolved_parent_public_id } : plan.afterProfile;
    need(equal(wire.fields, expectedFields), "wire fields differ from the planned profile");
    need(equal(origin, { actorId: plan.actor.staffId, authorityRevision: String(next), actorSubject: plan.actor.accessSubject }), "origin snapshot is not exact");
    need(disposition?.kind === "existing" && disposition.sourceId === trusted.sourceId && disposition.sourceInstanceUUID === trusted.sourceInstanceUUID
      && disposition.applicationUUID === trusted.applicationUUID && disposition.historyEpoch === trusted.historyEpoch && disposition.origin === trusted.origin
      && disposition.externalCanonicalId === trusted.externalCanonicalId && disposition.projectAlphaPublicId === trusted.projectAlphaPublicId
      && disposition.projectAlphaRevision === trusted.revision, "materialization disposition is not exact");
    need(mat.history_epoch_id === intent.expected_history_epoch_id && box.command_json === mat.command_json
      && box.origin_snapshot_json === mat.origin_snapshot_json
      && box.source_id === intent.source_id && box.application_id === intent.application_uuid
      && box.resource_type === plan.kind && box.external_id === intent.external_canonical_id
      && box.destination_base_url === intent.destination_origin && box.expected_source_instance_id === intent.source_instance_uuid
      && box.expected_history_epoch_id === intent.expected_history_epoch_id && box.state === "acknowledged", "outbox identity/ACK is not exact");
    const response = outcome?.response, resource = response?.result?.resource;
    need(outcome?.status === "acknowledged" && exactKeys(response,["sourceInstanceId","applicationId","historyEpoch","requestId","replayed","result"])
      && typeof response.requestId === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(response.requestId)
      && typeof response.replayed === "boolean"
      && exactKeys(response.result,["resource","authorizationGeneration","data"])
      && exactKeys(resource,["type","publicId","revision"])
      && equal(response.result.data,{publicId:trusted.projectAlphaPublicId}) && response?.sourceInstanceId === intent.source_instance_uuid
      && response?.applicationId === intent.application_uuid && response?.historyEpoch === intent.expected_history_epoch_id
      && resource?.type === plan.kind
      && resource?.publicId === trusted.projectAlphaPublicId && advances(resource?.revision, trusted.revision)
      && response?.result?.authorizationGeneration === trusted.expectedAuthorizationGeneration, "ACK outcome is malformed or stale");
  }
  return Object.freeze({ status: "acknowledged", mutationId: plan.mutationId, version: next, destinations: intents.length });
}

/** Phase 2: prove the two temporary resource grants were deactivated afterward. */
export function validatePairedGrantCleanup(input) {
  safeJsonTree(input);
  need(exactKeys(input, ["settlement", "acknowledged", "cleaned"]), "phase-two input shape is not exact");
  const settlement = validateAcknowledgedScalarUpdate(input.settlement), plan = input.settlement.plan;
  const keys = ["grants", "grantGeneration", "grantHistory", "settlementSnapshot", "protectedSnapshots"];
  need(exactKeys(input.acknowledged, keys) && exactKeys(input.cleaned, keys), "cleanup snapshots are incomplete or extra");
  cleanupProtectedShape(input.acknowledged.protectedSnapshots); cleanupProtectedShape(input.cleaned.protectedSnapshots);
  need(equal(input.acknowledged.settlementSnapshot, input.settlement), "cleanup does not preserve the full validated settlement packet");
  need(equal(input.acknowledged.settlementSnapshot, input.cleaned.settlementSnapshot), "settlement evidence changed during cleanup");
  need(equal(input.acknowledged.protectedSnapshots, input.cleaned.protectedSnapshots), "unrelated protected snapshots changed during cleanup");
  const ids = plan.temporaryGrantIds, expected = new Map([[ids.profileEdit, "directory.profile.edit"],
    ...(plan.kind === "client" ? [[ids.identityLink, "directory.identity.link"]] : [])]);
  unique(input.acknowledged.grants, x => x.id, "acknowledged grants"); unique(input.cleaned.grants, x => x.id, "cleaned grants");
  need(input.acknowledged.grants.length === expected.size && input.cleaned.grants.length === expected.size, "grant row cardinality is not exact");
  for (const [id, permission] of expected) {
    const pre = input.acknowledged.grants.find(x => x.id === id), post = input.cleaned.grants.find(x => x.id === id);
    need(pre && post && pre.staff_id === plan.actor.staffId && pre.permission === permission && pre.effect === "allow"
      && pre.scope_kind === "resource" && pre.business_area_id === null && pre.division_id === null
      && pre.resource_id === plan.recordId && pre.active === 1, `temporary grant ${id} precondition is invalid`);
    need(equal({ ...pre, active: 0 }, post), `temporary grant ${id} was not only deactivated`);
  }
  const g = input.acknowledged.grantGeneration;
  need(Number.isSafeInteger(g) && input.cleaned.grantGeneration === g + expected.size, "grant generation did not advance once per grant");
  need(Array.isArray(input.acknowledged.grantHistory) && Array.isArray(input.cleaned.grantHistory)
    && input.acknowledged.grantHistory.every(r => input.cleaned.grantHistory.some(x => equal(x, r))), "prior grant history changed");
  const added = input.cleaned.grantHistory.filter(r => !input.acknowledged.grantHistory.some(x => equal(x, r)));
  need(added.length === expected.size && equal(added.map(x => x.grant_generation).sort((a,b)=>a-b),
    Array.from({length:expected.size},(_,i)=>g+i+1)), "cleanup history generations are not exact");
  for (const [id, permission] of expected) {
    const prior = input.acknowledged.grantHistory.filter(x => x.grant_id === id);
    const row = added.find(x => x.grant_id === id), pre = input.acknowledged.grants.find(x => x.id === id);
    const max = Math.max(0, ...prior.map(x => x.grant_version));
    need(row && row.grant_version === max + 1 && row.staff_id === pre.staff_id && row.permission === permission
      && row.effect === pre.effect && row.scope_kind === pre.scope_kind && row.business_area_id === pre.business_area_id
      && row.division_id === pre.division_id && row.resource_id === pre.resource_id && row.active === 0, `cleanup history for ${id} is invalid`);
  }
  return Object.freeze({ status: "cleaned", mutationId: settlement.mutationId, grantGeneration: g + expected.size });
}
