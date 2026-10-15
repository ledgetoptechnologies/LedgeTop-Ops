import { resolveProjectAlphaApiV2Connection } from "./project-alpha-api-v2-connections";
import { readConfiguredProjectAlphaDirectoryProfile, readConfiguredProjectAlphaDirectoryBindingStatus } from "./project-alpha-directory-read-api-v2";
import { canonicalProjectAlphaExistingDirectoryBindingCommand } from "./project-alpha-existing-directory-binding-api-v2";
import { acquireProjectAlphaExistingDirectoryBinding } from "./project-alpha-existing-directory-acquisition-coordinator";
import { activateProjectAlphaExistingDirectoryBinding } from "./project-alpha-existing-directory-binding-review-consumer";
import { IMPORT_UUID, importSha, importUuid, nativeExistingImportAuthority, nativeExistingImportEnabled, nativeImportProfile, savedNativeImport, sameImportActor, nativeImportConfiguredReview, validNativeImportProfile } from "./native-directory-existing-import-common";
import { nativeExistingImportRecordId } from "./native-directory-existing-import-identity";
import { writeNativeExistingDirectoryImport } from "./native-directory-existing-import-writer";
import type { NativeExistingImportActor, NativeExistingImportEnvironment, NativeExistingImportOutcome, NativeExistingImportReview, NativeExistingImportSelection } from "./native-directory-existing-import-types";
const blocked = (reason: string, importId?: string): NativeExistingImportOutcome => ({ status: "blocked", reason, ...(importId ? { importId } : {}) });
const now = () => new Date().toISOString();
async function activeImport(env:NativeExistingImportEnvironment,review:NativeExistingImportReview):Promise<boolean>{
    return !!await env.OPS_DB.prepare(`SELECT 1 ok FROM project_alpha_active_directory_mappings mapping
      WHERE mapping.source_id=? AND mapping.source_instance_id=? AND mapping.application_id=? AND mapping.history_epoch_id=?
       AND mapping.resource_type=? AND mapping.record_id=? AND mapping.external_id=? AND mapping.project_alpha_public_id=?`)
      .bind(review.sourceId,review.sourceInstanceId,review.applicationId,review.historyEpoch,review.kind,review.nativeRecordId,review.nativeRecordId,review.publicId).first("ok");
}
const shaBytes = async (body: string) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body)))].map(b => b.toString(16).padStart(2, "0")).join("");
export async function prepareNativeExistingDirectoryImport(env: NativeExistingImportEnvironment, selection: NativeExistingImportSelection, actor: NativeExistingImportActor, send: typeof fetch = fetch): Promise<NativeExistingImportOutcome> {
    try {
        if (!await nativeExistingImportEnabled(env) || !IMPORT_UUID.test(selection.batchId) || !IMPORT_UUID.test(selection.idempotencyKey)
            || !["organization", "client"].includes(selection.kind))
            return blocked("configuration_or_input");
        const nativeRecordId = nativeExistingImportRecordId(selection.sourceId, selection.kind, selection.recordId);
        const selectedGrants = await nativeExistingImportAuthority(env, actor, selection.sourceId, selection.kind, selection.recordId, selection.businessAreaId);
        if (!selectedGrants)
            return blocked("authority");
        const requestSha = await importSha(selection);
        const prior = await env.OPS_DB.prepare("SELECT review_json,request_sha256 FROM native_directory_existing_import_reviews WHERE idempotency_key=?").bind(selection.idempotencyKey).first<{
            review_json: string;
            request_sha256: string;
        }>();
        if (prior) {
            const review = JSON.parse(prior.review_json) as NativeExistingImportReview;
            return prior.request_sha256 === requestSha && sameImportActor(review, actor)
                ? { status: "reviewed", review, replayed: true } : { status: "conflict", reason: "idempotency" };
        }
        const classic = await env.OPS_DB.prepare("SELECT * FROM native_directory_existing_import_classic WHERE source_id=? AND record_kind=? AND record_id=?")
            .bind(selection.sourceId, selection.kind, selection.recordId).first<{
            name: string;
            payload_json: string;
            profile_json: string;
            public_id: string;
            parent_record_id: string | null;
        }>();
        if (!classic || !/^[0-9a-f]{32}$/.test(classic.public_id))
            return blocked("classic_identity");
        const grouped=await env.OPS_DB.prepare(`SELECT 1 linked FROM business_party_links WHERE source_id=? AND record_kind=?
            AND record_id IN (?,?) AND unlinked_at IS NULL`).bind(selection.sourceId,selection.kind,selection.recordId,nativeRecordId).first("linked");
        if(grouped)return blocked("business_party_reconciliation");
        const configured = resolveProjectAlphaApiV2Connection(env, selection.sourceId);
        if (!configured.enabled)
            return blocked("configuration");
        const remote = await readConfiguredProjectAlphaDirectoryProfile(env, selection.sourceId, selection.kind, classic.public_id, send);
        const binding = await readConfiguredProjectAlphaDirectoryBindingStatus(env, selection.sourceId, selection.kind, nativeRecordId, classic.public_id, send);
        if (remote.status !== "observed" || binding.status !== "not_found")
            return blocked("remote_identity");
        const profile = nativeImportProfile(remote.observation.profile, selection.kind);
        if (!validNativeImportProfile(profile, selection.kind))
            return blocked("profile_shape");
        const localProfile = JSON.parse(classic.profile_json) as Record<string, string>, comparedProfile = { ...profile } as Record<string, string>;
        // Classic organization snapshots never carried general contact fields.
        // Review the fresh authoritative PA values rather than importing blanks.
        if (selection.kind === "organization") {
            delete localProfile.generalEmail;
            delete localProfile.generalPhone;
            delete comparedProfile.generalEmail;
            delete comparedProfile.generalPhone;
        }
        if (JSON.stringify(comparedProfile) !== JSON.stringify(localProfile))
            return blocked("profile_drift");
        const parent = classic.parent_record_id ? await env.OPS_DB.prepare("SELECT public_id FROM native_directory_existing_import_classic WHERE source_id=? AND record_kind='organization' AND record_id=?")
            .bind(selection.sourceId, classic.parent_record_id).first<{
            public_id: string;
        }>() : null;
        if ((remote.observation.profile.organizationPublicId ?? null) !== (parent?.public_id ?? null))
            return blocked("parent_drift");
        const reviewedAt = now(), review: NativeExistingImportReview = { ...selection, importId: await importUuid(`existing-import:${selection.idempotencyKey}`), nativeRecordId,
            sourceInstanceId: configured.connection.expectedSourceInstanceId, applicationId: configured.connection.expectedApplicationId,
            historyEpoch: configured.connection.expectedHistoryEpoch!, origin: new URL(configured.connection.baseUrl).origin, publicId: classic.public_id,
            classicPayload: classic.payload_json, classicName: classic.name, parentRecordId: classic.parent_record_id, parentPublicId: parent?.public_id ?? null,
            parentNativeRecordId: classic.parent_record_id ? nativeExistingImportRecordId(selection.sourceId, "organization", classic.parent_record_id) : null,
            profile, observation: remote.observation, actor, selectedGrants, reviewedAt, expiresAt: new Date(Date.parse(reviewedAt) + 4 * 60 * 60 * 1000).toISOString() };
        await env.OPS_DB.batch([
            env.OPS_DB.prepare("INSERT INTO native_directory_existing_import_reviews(import_id,idempotency_key,request_sha256,review_json,created_at,expires_at) VALUES(?,?,?,?,?,?)")
                .bind(review.importId, selection.idempotencyKey, requestSha, JSON.stringify(review), review.reviewedAt, review.expiresAt),
            env.OPS_DB.prepare("INSERT INTO native_directory_existing_import_source_cursors(batch_id,source_id,source_instance_id,application_id,history_epoch_id,generation) VALUES(?,?,?,?,?,?) ON CONFLICT(batch_id,source_id) DO NOTHING")
                .bind(review.batchId, review.sourceId, review.sourceInstanceId, review.applicationId, review.historyEpoch, review.observation.authorizationGeneration),
        ]);
        return { status: "reviewed", review, replayed: false };
    }
    catch {
        return blocked("review_validation");
    }
}
export async function executeNativeExistingDirectoryImport(env: NativeExistingImportEnvironment, input: {
    importId: string;
}, actor: NativeExistingImportActor, send: typeof fetch = fetch): Promise<NativeExistingImportOutcome> {
    try {
        if (!await nativeExistingImportEnabled(env) || !IMPORT_UUID.test(input.importId))
            return blocked("configuration_or_input");
        const review = await savedNativeImport(env, input.importId);
        if (!review || !sameImportActor(review, actor) || !nativeImportConfiguredReview(env, review))
            return blocked("authority", input.importId);
        if (!await nativeExistingImportAuthority(env, actor, review.sourceId, review.kind, review.recordId, review.businessAreaId))
            return blocked("authority", input.importId);
        const done = await env.OPS_DB.prepare("SELECT detail_json FROM native_directory_existing_import_events WHERE import_id=? AND state='activated'").bind(input.importId).first<{
            detail_json: string;
        }>();
        if(done&&!await activeImport(env,review))return blocked("activation_no_longer_current",input.importId);
        if (done)
            return { status: "activated", importId: input.importId, recordId: review.nativeRecordId, activationId: JSON.parse(done.detail_json).activationId, replayed: true };
        const localReceipt=await env.OPS_DB.prepare("SELECT 1 ok FROM native_directory_existing_import_local_receipts WHERE import_id=?").bind(input.importId).first("ok");
        if(!localReceipt){
            const [profileBefore,bindingBefore]=await Promise.all([
                readConfiguredProjectAlphaDirectoryProfile(env,review.sourceId,review.kind,review.publicId,send),
                readConfiguredProjectAlphaDirectoryBindingStatus(env,review.sourceId,review.kind,review.nativeRecordId,review.publicId,send),
            ]);
            if(profileBefore.status==="uncertain"||bindingBefore.status==="uncertain")
                return {status:"pending",importId:input.importId,reason:"pre_import_transport"};
            if(profileBefore.status!=="observed"||bindingBefore.status!=="not_found"
                ||profileBefore.observation.resource.revision!==review.observation.resource.revision
                ||JSON.stringify(nativeImportProfile(profileBefore.observation.profile,review.kind))!==JSON.stringify(review.profile)
                ||(profileBefore.observation.profile.organizationPublicId??null)!==review.parentPublicId)
                return blocked("remote_drift",input.importId);
            const cursorBefore=await env.OPS_DB.prepare("SELECT generation FROM native_directory_existing_import_source_cursors WHERE batch_id=? AND source_id=?")
                .bind(review.batchId,review.sourceId).first<{generation:string}>();
            if(cursorBefore?.generation!==profileBefore.observation.authorizationGeneration)return blocked("generation_drift",input.importId);
        }
        const local = await writeNativeExistingDirectoryImport(env, review, actor);
        if (local.status !== "imported")
            return { ...local, importId: input.importId };
        let intent = await env.OPS_DB.prepare("SELECT * FROM native_directory_existing_import_binding_intents WHERE import_id=?").bind(input.importId).first<{
            command_id: string;
            review_receipt_id: string;
            command_json: string;
        }>();
        if (!intent) {
            const cursor = await env.OPS_DB.prepare("SELECT generation FROM native_directory_existing_import_source_cursors WHERE batch_id=? AND source_id=?").bind(review.batchId, review.sourceId).first<{
                generation: string;
            }>();
            const remote = await readConfiguredProjectAlphaDirectoryProfile(env, review.sourceId, review.kind, review.publicId, send);
            const binding = await readConfiguredProjectAlphaDirectoryBindingStatus(env, review.sourceId, review.kind, review.nativeRecordId, review.publicId, send);
            if (!cursor || remote.status !== "observed" || binding.status !== "not_found" || remote.observation.authorizationGeneration !== cursor.generation
                || remote.observation.resource.revision !== review.observation.resource.revision || JSON.stringify(nativeImportProfile(remote.observation.profile, review.kind)) !== JSON.stringify(review.profile)
                || (remote.observation.profile.organizationPublicId ?? null) !== review.parentPublicId)
                return blocked("remote_drift", input.importId);
            const commandId = await importUuid(`existing-import-bind:${input.importId}`), receiptId = await importUuid(`existing-import-receipt:${input.importId}`);
            const canonical = canonicalProjectAlphaExistingDirectoryBindingCommand({ commandId, externalId: review.nativeRecordId, expectedPublicId: review.publicId,
                expectedRevision: remote.observation.resource.revision, expectedAuthorizationGeneration: cursor.generation });
            if (!canonical)
                return blocked("command", input.importId);
            const requestSha = await shaBytes(canonical.body), at = now();
            await env.OPS_DB.batch([
                env.OPS_DB.prepare("INSERT INTO native_directory_existing_import_binding_intents(import_id,command_id,review_receipt_id,command_json,request_sha256,profile_evidence_json,actor_json,created_at) VALUES(?,?,?,?,?,?,?,?)")
                    .bind(input.importId, commandId, receiptId, canonical.body, requestSha, JSON.stringify(remote.observation), JSON.stringify(actor), at),
                env.OPS_DB.prepare(`INSERT INTO project_alpha_existing_directory_binding_review_evidence(receipt_id,request_sha256,record_id,source_id,source_instance_id,application_id,history_epoch_id,resource_type,external_id,project_alpha_public_id,project_alpha_revision,review_id,reviewed_binding_evidence_sha256,reviewer_staff_id,reviewer_access_subject,reviewer_admission_version,reviewer_profile_version,reviewed_at,reviewed_local_record_version) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1)`)
                    .bind(receiptId, requestSha, review.nativeRecordId, review.sourceId, review.sourceInstanceId, review.applicationId, review.historyEpoch, review.kind, review.nativeRecordId, review.publicId, remote.observation.resource.revision, input.importId, await importSha(remote.observation), actor.staffId, actor.accessSubject, actor.admissionVersion, actor.profileVersion, at),
                env.OPS_DB.prepare(`INSERT INTO project_alpha_existing_directory_binding_acquisition_commands(command_id,request_sha256,record_id,source_id,source_instance_id,application_id,history_epoch_id,resource_type,external_id,project_alpha_public_id,project_alpha_revision,review_receipt_id) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`)
                    .bind(commandId, requestSha, review.nativeRecordId, review.sourceId, review.sourceInstanceId, review.applicationId, review.historyEpoch, review.kind, review.nativeRecordId, review.publicId, remote.observation.resource.revision, receiptId),
                env.OPS_DB.prepare("INSERT INTO project_alpha_existing_directory_binding_acquisition_events(command_id,state_version,transition_id,request_sha256,state,occurred_at) VALUES(?,1,?,?,'pending',?)").bind(commandId, crypto.randomUUID(), requestSha, at),
            ]);
            intent = { command_id: commandId, review_receipt_id: receiptId, command_json: canonical.body };
        }
        const priorActivation = await env.OPS_DB.prepare(`SELECT activation.activation_id FROM project_alpha_existing_directory_binding_activation_receipts activation
            WHERE activation.review_receipt_id=? AND activation.record_id=? AND activation.resource_type=?`)
            .bind(intent.review_receipt_id,review.nativeRecordId,review.kind).first<{activation_id:string}>();
        if (priorActivation) {
            if(!await activeImport(env,review))return blocked("activation_no_longer_current",input.importId);
            const restored = await activateProjectAlphaExistingDirectoryBinding(env,
                {reviewItemId:intent.review_receipt_id,idempotencyKey:await importUuid(`existing-import-activate:${input.importId}`)},
                {staffId:actor.staffId,accessSubject:actor.accessSubject},send);
            if(restored.status!=="activated")return blocked("activation_reconciliation",input.importId);
            await env.OPS_DB.prepare("INSERT INTO native_directory_existing_import_events(import_id,state,detail_json) VALUES(?,'activated',?)")
                .bind(input.importId,JSON.stringify({activationId:restored.activationId})).run();
            return {status:"activated",importId:input.importId,recordId:review.nativeRecordId,activationId:restored.activationId,replayed:true};
        }
        const command = JSON.parse(intent.command_json);
        const currentProfile = await readConfiguredProjectAlphaDirectoryProfile(env, review.sourceId, review.kind, review.publicId, send);
        if (currentProfile.status !== "observed" || currentProfile.observation.resource.revision !== command.expectedRevision
            || JSON.stringify(nativeImportProfile(currentProfile.observation.profile, review.kind)) !== JSON.stringify(review.profile)
            || (currentProfile.observation.profile.organizationPublicId ?? null) !== review.parentPublicId)
            return blocked("remote_drift", input.importId);
        const acquired = await acquireProjectAlphaExistingDirectoryBinding(env, { reviewId: input.importId, commandId: intent.command_id, sourceId: review.sourceId,
            recordId: review.nativeRecordId, externalId: review.nativeRecordId, resourceType: review.kind, projectAlphaPublicId: review.publicId,
            expectedProjectAlphaRevision: command.expectedRevision, expectedAuthorizationGeneration: command.expectedAuthorizationGeneration, localRecordVersion: 1,
            reviewer: { staffId: actor.staffId, accessSubject: actor.accessSubject, admissionVersion: actor.admissionVersion, profileVersion: actor.profileVersion, grantGeneration: actor.grantGeneration } }, send);
        if (acquired.status !== "acquired")
            return acquired.status==="uncertain" ? { status: "pending", importId: input.importId, reason: `acquisition_${acquired.reason}` }
                : {status:acquired.status==="conflict"?"conflict":"blocked",importId:input.importId,reason:`acquisition_${acquired.reason}`};
        const prior = await env.OPS_DB.prepare("SELECT 1 ok FROM native_directory_existing_import_events WHERE import_id=? AND state='acquired'").bind(input.importId).first("ok");
        if (!prior) {
            const next = (BigInt(command.expectedAuthorizationGeneration) + 1n).toString();
            await env.OPS_DB.batch([
                env.OPS_DB.prepare("INSERT INTO native_directory_existing_import_events(import_id,state,detail_json) VALUES(?,'acquired',?)").bind(input.importId, JSON.stringify({ commandId: intent.command_id, expectedGeneration: command.expectedAuthorizationGeneration, nextGeneration: next })),
                env.OPS_DB.prepare("UPDATE native_directory_existing_import_source_cursors SET generation=?,last_import_id=? WHERE batch_id=? AND source_id=? AND generation=?")
                    .bind(next, input.importId, review.batchId, review.sourceId, command.expectedAuthorizationGeneration),
            ]);
        }
        const activation = await activateProjectAlphaExistingDirectoryBinding(env, { reviewItemId: intent.review_receipt_id, idempotencyKey: await importUuid(`existing-import-activate:${input.importId}`) }, { staffId: actor.staffId, accessSubject: actor.accessSubject }, send);
        if (activation.status !== "activated")
            return activation.status==="uncertain" ? { status: "pending", importId: input.importId, reason: `activation_${activation.reason}` }
                : {status:activation.status==="conflict"?"conflict":"blocked",importId:input.importId,reason:`activation_${activation.reason}`};
        await env.OPS_DB.prepare("INSERT INTO native_directory_existing_import_events(import_id,state,detail_json) VALUES(?,'activated',?)").bind(input.importId, JSON.stringify({ activationId: activation.activationId })).run();
        return { status: "activated", importId: input.importId, recordId: review.nativeRecordId, activationId: activation.activationId, replayed: false };
    }
    catch {
        return { status: "pending", importId: input.importId, reason: "reconcile_required" };
    }
}
export async function readNativeExistingDirectoryImportStatus(env: NativeExistingImportEnvironment, importId: string, actor: NativeExistingImportActor) {
    if (!await nativeExistingImportEnabled(env))
        return blocked("configuration");
    const review = await savedNativeImport(env, importId);
    if (!review || !sameImportActor(review, actor) || !nativeImportConfiguredReview(env, review) || !await nativeExistingImportAuthority(env, actor, review.sourceId, review.kind, review.recordId, review.businessAreaId))
        return blocked("authority");
    const event = await env.OPS_DB.prepare("SELECT state,detail_json FROM native_directory_existing_import_events WHERE import_id=? ORDER BY event_id DESC LIMIT 1").bind(importId).first<{
        state: string;
        detail_json: string;
    }>();
    const renewal = await env.OPS_DB.prepare("SELECT max(expires_at) expires FROM native_directory_existing_import_renewals WHERE import_id=?").bind(importId).first<{
        expires: string | null;
    }>();
    const expiresAt = renewal?.expires && renewal.expires > review.expiresAt ? renewal.expires : review.expiresAt;
    const expired = Date.parse(expiresAt) <= Date.now();
    const activation=await env.OPS_DB.prepare(`SELECT activation.activation_id FROM native_directory_existing_import_binding_intents intent
        JOIN project_alpha_existing_directory_binding_activation_receipts activation ON activation.review_receipt_id=intent.review_receipt_id
        WHERE intent.import_id=? AND activation.record_id=? AND activation.resource_type=?`)
        .bind(importId,review.nativeRecordId,review.kind).first<{activation_id:string}>();
    if(activation){
        if(!await activeImport(env,review))return {status:"blocked",review:{...review,expiresAt},reason:"activation_no_longer_current",renewable:false};
        return {status:"activated",review:{...review,expiresAt},activationId:activation.activation_id,replayed:true,renewable:false};
    }
    return { status: event?.state === "activated" ? "activated" : event ? "pending" : "reviewed", review: { ...review, expiresAt }, renewable: expired && event?.state!=="activated",
        ...(expired ? { expiryReason: "review_expired" } : {}), ...(event?.state === "activated" ? JSON.parse(event.detail_json) : {}) };
}
export async function renewNativeExistingDirectoryImport(env: NativeExistingImportEnvironment, importId: string, actor: NativeExistingImportActor, send: typeof fetch = fetch): Promise<NativeExistingImportOutcome> {
    try {
        if (!await nativeExistingImportEnabled(env))
            return blocked("configuration");
        const review = await savedNativeImport(env, importId);
        if (!review || !sameImportActor(review, actor) || !nativeImportConfiguredReview(env, review) || !await nativeExistingImportAuthority(env, actor, review.sourceId, review.kind, review.recordId, review.businessAreaId))
            return blocked("authority", importId);
        const remote = await readConfiguredProjectAlphaDirectoryProfile(env, review.sourceId, review.kind, review.publicId, send);
        if (remote.status !== "observed" || remote.observation.resource.revision !== review.observation.resource.revision
            || JSON.stringify(nativeImportProfile(remote.observation.profile, review.kind)) !== JSON.stringify(review.profile)
            || (remote.observation.profile.organizationPublicId ?? null) !== review.parentPublicId)
            return blocked("remote_drift", importId);
        const cursor=await env.OPS_DB.prepare("SELECT generation FROM native_directory_existing_import_source_cursors WHERE batch_id=? AND source_id=?")
            .bind(review.batchId,review.sourceId).first<{generation:string}>();
        const intent=await env.OPS_DB.prepare("SELECT command_json FROM native_directory_existing_import_binding_intents WHERE import_id=?")
            .bind(importId).first<{command_json:string}>();
        const binding=await readConfiguredProjectAlphaDirectoryBindingStatus(env,review.sourceId,review.kind,review.nativeRecordId,review.publicId,send);
        const expected=intent?JSON.parse(intent.command_json).expectedAuthorizationGeneration as string:null;
        const next=expected?(BigInt(expected)+1n).toString():null;
        const unbound=binding.status==="not_found"&&cursor?.generation===remote.observation.authorizationGeneration;
        const ownBound=binding.status==="observed"&&next===remote.observation.authorizationGeneration
            &&(cursor?.generation===expected||cursor?.generation===next);
        if(!unbound&&!ownBound)return blocked("generation_or_binding_drift",importId);
        const createdAt = now(), expiresAt = new Date(Date.parse(createdAt) + 4 * 60 * 60 * 1000).toISOString();
        await env.OPS_DB.prepare("INSERT INTO native_directory_existing_import_renewals(renewal_id,import_id,actor_json,created_at,expires_at) VALUES(?,?,?,?,?)")
            .bind(crypto.randomUUID(), importId, JSON.stringify(actor), createdAt, expiresAt).run();
        return { status: "reviewed", review: { ...review, expiresAt }, replayed: false };
    }
    catch {
        return blocked("renewal_validation", importId);
    }
}
