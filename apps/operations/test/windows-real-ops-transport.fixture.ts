// Local-only fixture. Synthetic owner/admission seeds; actual directory,
// reservation, publication, recipient and delivery commands establish authority.
import { expect } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { applyCanonicalChain } from "./helpers/verified-recipient-canonical-lineage";
import { writeNativeDirectoryProfile, type NativeDirectoryCreateWrite } from "../src/worker/native-directory-profile-writer";
import { reserveOperationsPortalFolder, reserveOperationsPortalWorkspace } from "../src/worker/operations-portal-workspace-reservations";
import { reserveOperationsPortalWorkspacePublication, dispatchOperationsPortalWorkspacePublication as dispatchPublication, type OperationsPortalWorkspacePublicationBinding } from "../src/worker/operations-portal-workspace-publication-outbox";
import { reserveOperationsPortalWorkspacePublicationInvocation } from "../src/worker/operations-portal-workspace-publication-invocations";
import { publishOperationsPortalWorkspaceRpc, getOperationsPortalWorkspacePublicationStatusRpc } from "../../client/src/worker/operations-portal-workspace-publication-entrypoint";
import { issueOperationsPortalNativeRecipientIntent, redeemOperationsPortalNativeRecipientIntent, confirmOperationsPortalNativeRecipientIntent, readOperationsPortalNativeRecipientIntent } from "../src/worker/operations-portal-native-recipient-authority";
import { materializeOperationsPortalNativeRecipientAuthority, dispatchOperationsPortalNativeRecipientAuthority } from "../src/worker/operations-portal-native-recipient-authority-dispatch";
import { applyOperationsPortalNativeRecipientAuthority, readOperationsPortalNativeRecipientAuthorityStatus } from "../../client/src/worker/operations-portal-native-recipient-authority";
import { issueOperationsPortalNativeDeliveryAuthority, listOperationsPortalNativeDeliveryCandidates, revokeOperationsPortalNativeDeliveryAuthority } from "../src/worker/operations-portal-native-delivery-authority-issuer";
import { dispatchNextOperationsPortalNativeDeliveryAuthority } from "../src/worker/operations-portal-native-delivery-authority-dispatch";
import { parseOperationsPortalNativeDeliveryAuthorityCommand } from "@ltds/shared/operations-portal-native-delivery-authority";
import type { AuthenticatedNativeStaffWithAdmissionVersion } from "../src/worker/native-staff-auth";
import { applyOperationsPortalNativeDeliveryAuthority, readOperationsPortalNativeDeliveryAuthorityStatus } from "../../client/src/worker/operations-portal-native-delivery-authority";
export async function realOpsTransportAuthority(operations: D1Database, client: D1Database) {
    let sequence = 1;
    const id = () => `d0000000-0000-4000-8000-${String(sequence++).padStart(12, "0")}`;
    const organization = "ops/organization/native-delivery";
    const clientRecord = "ops/client/native-delivery";
    const externalProject = "ops/project/native-delivery";
    const physicalProject = "ops/physical/native-delivery";
    const division = "native-delivery-division";
    const basePrefix = "clients/native-delivery/project/";
    const issuer = "https://synthetic.cloudflareaccess.com", subject = "synthetic-recipient";
    function future(hours = 1) { return new Date(Date.now() + hours * 3600000).toISOString(); }
    function owner(): AuthenticatedNativeStaffWithAdmissionVersion {
        return { identity: { kind: "native", staffId: "native-delivery-owner",
                verifiedAccessSubject: "access|native-delivery-owner", email: "native-delivery-owner@example.test",
                displayName: "Native Delivery Owner", profileVersion: 1 }, admissionVersion: 1, verifiedUntil: future(2) };
    }
    async function seedManager() {
        await operations.batch([
            operations.prepare(`INSERT INTO staff_users(id,email,display_name,access_subject,status)
      VALUES('native-delivery-owner','native-delivery-owner@example.test','Native Delivery Owner',
        'access|native-delivery-owner','active')`),
            operations.prepare(`INSERT INTO native_staff_admissions(staff_id,bound_access_subject,active,admitted_by)
      VALUES('native-delivery-owner','access|native-delivery-owner',1,'native-delivery-owner')`),
            operations.prepare(`INSERT INTO native_staff_profiles(staff_id,login_email,display_name)
      VALUES('native-delivery-owner','native-delivery-owner@example.test','Native Delivery Owner')`),
            operations.prepare(`INSERT INTO staff_role_assignments(id,staff_id,role_id,scope,division_id,scope_key,created_by)
      VALUES('native-delivery-owner-role','native-delivery-owner','role-owner','global',NULL,'global',
        'native-delivery-owner')`),
            ...["directory.portal_access.manage", "directory.profile.edit", "directory.identity.link"].map((permission, index) => operations.prepare(`INSERT INTO native_directory_grants
        (id,staff_id,permission,effect,scope_kind,active,granted_by)
        VALUES(?, 'native-delivery-owner',?,'allow','global',1,'native-delivery-owner')`)
                .bind(`native-delivery-grant-${index}`, permission)),
            ...["projects.view", "delivery.browse", "delivery.share.create", "delivery.share.revoke"].map((permission, index) => operations.prepare(`INSERT INTO staff_permission_overrides
        (id,staff_id,permission_key,effect,scope,division_id,scope_key,created_by)
        VALUES(?,'native-delivery-owner',?,'allow','global',NULL,'global','native-delivery-owner')`)
                .bind(`native-delivery-permission-${index}`, permission)),
        ]);
    }
    async function seedRecord(recordId: string, kind: "organization" | "client", parent: string | null = null) {
        const mutationId = id(), admissionId = `admission-${id()}`;
        const scopes = [{ businessAreaId: "native-delivery-area", divisionId: "native-delivery-business-division" }];
        const destination = { sourceId: "project-alpha:primary", sourceInstanceUUID: "11111111-1111-4111-8111-111111111111",
            applicationUUID: "22222222-2222-4222-8222-222222222222",
            historyEpoch: "33333333-3333-4333-8333-333333333333", origin: "https://pa.example.test",
            externalCanonicalId: recordId, expectedAuthorizationGeneration: "0" };
        const profile = kind === "organization"
            ? { name: "Native Delivery Organization", generalEmail: "organization@example.test", generalPhone: "",
                addressLine1: "1 Main", addressLine2: "", city: "Austin", state: "TX", postalCode: "78701", country: "US" }
            : { name: "Native Delivery Client", email: "client@example.test", phone: "", clientType: "business" as const,
                addressLine1: "2 Main", addressLine2: "", city: "Austin", state: "TX", postalCode: "78702", country: "US" };
        await operations.batch([
            operations.prepare(`INSERT INTO native_directory_create_admissions
      (id,staff_id,bound_access_subject,record_id,record_kind,scopes_json,profile_json,destinations_json,issued_by)
      VALUES(?,?,?,?,?,?,?,?,?)`).bind(admissionId, "native-delivery-owner", "access|native-delivery-owner", recordId, kind, JSON.stringify(scopes), JSON.stringify(profile), JSON.stringify([{ sourceId: destination.sourceId,
                    sourceInstanceUUID: destination.sourceInstanceUUID, applicationUUID: destination.applicationUUID,
                    historyEpoch: destination.historyEpoch, origin: destination.origin, externalCanonicalId: recordId }]), "native-delivery-owner"),
            ...(kind === "client" ? [operations.prepare(`INSERT INTO native_directory_create_admission_relationships
      (create_admission_id,client_record_id,organization_record_id,organization_record_version)
      VALUES(?,?,?,?)`).bind(admissionId, recordId, parent, parent === null ? null : 1)] : []),
        ]);
        const write = { operation: "create", mutationId, createAdmissionId: admissionId, recordId,
            expectedLocalVersion: 0, kind, profile, scopes, destinations: [destination], actor: {
                staffId: "native-delivery-owner", accessSubject: "access|native-delivery-owner",
                loginEmail: "native-delivery-owner@example.test", admissionVersion: 1, profileVersion: 1,
                selectedGrantId: "native-delivery-grant-1", selectedIdentityGrantId: "native-delivery-grant-2"
            },
            ...(kind === "client" ? { relationship: { organizationRecordId: parent, expectedRelationshipVersion: 0 } } : {}),
        } as NativeDirectoryCreateWrite;
        const outcome = await writeNativeDirectoryProfile(operations, write);
        if (outcome.status !== "written")
            throw new Error(`native directory seed failed: ${outcome.reason}`);
        expect(outcome).toMatchObject({ status: "written", version: 1 });
        return { write, outcome };
    }
    async function acknowledgeCreate(seed: Awaited<ReturnType<typeof seedRecord>>, publicId: string) {
        for (const commandId of seed.outcome.commandIds)
            await operations.batch([
                operations.prepare(`UPDATE project_alpha_directory_outbox SET state='leased',attempts=1,
      lease_token='native-delivery-fixture',lease_expires_at=9999999999999
      WHERE command_id=? AND state='pending'`).bind(commandId),
                operations.prepare(`INSERT INTO project_alpha_directory_mappings(source_id,resource_type,external_id,
      project_alpha_public_id,source_instance_id,application_id,history_epoch_id,command_id)
      VALUES(?,?,?,?,?,?,?,?)`).bind(seed.write.destinations[0]!.sourceId, seed.write.kind, seed.write.recordId, publicId, seed.write.destinations[0]!.sourceInstanceUUID, seed.write.destinations[0]!.applicationUUID, seed.write.destinations[0]!.historyEpoch, commandId),
                operations.prepare(`UPDATE project_alpha_directory_outbox SET state='acknowledged',outcome_json=?,
      lease_token=NULL,lease_expires_at=NULL WHERE command_id=? AND state='leased'`).bind(JSON.stringify({
                    status: "acknowledged", response: { sourceInstanceId: seed.write.destinations[0]!.sourceInstanceUUID,
                        applicationId: seed.write.destinations[0]!.applicationUUID,
                        historyEpoch: seed.write.destinations[0]!.historyEpoch, requestId: commandId, replayed: false,
                        result: { resource: { type: seed.write.kind,
                                id: seed.write.recordId, publicId, revision: "1" }, data: { publicId },
                            authorizationGeneration: "1" } },
                }), commandId),
            ]);
        await operations.prepare(`UPDATE operations_directory_intents SET state='acknowledged'
    WHERE mutation_id=? AND state='materialized'`).bind(seed.write.mutationId).run();
    }
    async function dispatchCurrentPublication(operationId: string) {
        const clientEnvironment = { DELIVERY_DB: client, CLIENT_PORTAL_OPERATIONS_PUBLICATION_WRITER_ENABLED: "true",
            ENVIRONMENT: "staging", EXPECTED_HOST: "delivery-staging.ledgetopdroneservices.com" } as const;
        const binding: OperationsPortalWorkspacePublicationBinding = {
            publishWorkspace: async (publication) => JSON.stringify(await publishOperationsPortalWorkspaceRpc(clientEnvironment, publication)),
            getPublicationStatus: async (publication) => JSON.stringify(await getOperationsPortalWorkspacePublicationStatusRpc(clientEnvironment, publication)),
        };
        const invocationId = id();
        await reserveOperationsPortalWorkspacePublicationInvocation(operations, owner(), { invocationId, operationId,
            action: "publish", reason: "Dispatch exact native delivery publication" });
        return dispatchPublication({ db: operations, binding, operationId, invocationId, action: "publish" });
    }
    // Pin this fixture's complete baseline+successor schema without modifying any
    // frozen migration receipt or bypassing migration triggers.
    const migrationDirectory = new URL("../migrations/", import.meta.url);
    const names = readdirSync(migrationDirectory).filter(name => /^\d{4}_.+\.sql$/.test(name) && name <= "0224_windows_portal_publication_chain_index.sql").sort();
    const inventory = names.map(name => `${name}\0${createHash("sha256").update(readFileSync(new URL(name, migrationDirectory), "utf8").replace(/\r\n/g, "\n")).digest("hex")}`).join("\n");
    expect(createHash("sha256").update(inventory).digest("hex")).toBe("cc84e0c3216e591ad8d546a89708dfc3dcd5a608a4bf455fefad745ced5800a4");
    expect(await applyCanonicalChain(operations, "operations", "0224_windows_portal_publication_chain_index.sql", true)).toHaveLength(224);
    await seedManager();
    await operations.batch([
        operations.prepare("INSERT INTO divisions(id,name,code,active) VALUES(?,'Synthetic Division','SYNTHETIC',1)").bind(division),
        operations.prepare("INSERT INTO native_business_areas(id,name,active) VALUES('native-delivery-area','Synthetic Area',1)"),
        operations.prepare("INSERT INTO native_business_divisions(id,business_area_id,name,active) VALUES('native-delivery-business-division','native-delivery-area','Synthetic Business Division',1)")
    ]);
    const org = await seedRecord(organization, "organization");
    await acknowledgeCreate(org, "10000000000000000000000000000001");
    await seedRecord(clientRecord, "client", organization);
    await operations.batch([
        operations.prepare("INSERT INTO operations_shared_projects(external_project_id,name,lifecycle,organization_record_id,client_record_id,scopes_json) VALUES(?,'Synthetic Project','active',?,?,'[]')").bind(externalProject, organization, clientRecord),
        operations.prepare("INSERT INTO operations_shared_project_revisions(external_project_id,version,read_json) VALUES(?,1,'{}')").bind(externalProject),
        operations.prepare("INSERT INTO project_folders(project_id,division_id,r2_prefix,match_method,confirmed_by,confirmed_at) VALUES(?,?,?,'manual','native-delivery-owner','2026-09-30 12:00:00')").bind(physicalProject, division, basePrefix)
    ]);
    const workspace = { operationId: id(), targetId: id(), clientAuthorityId: id(), workspaceId: `workspace:${id()}`, rootKind: "organization" as const, rootRecordId: organization, rootRecordVersion: 1, relationshipVersion: null, expectedRevision: 0 as const, reason: "Synthetic local transport" };
    await reserveOperationsPortalWorkspace(operations, owner(), workspace);
    const folder = { operationId: id(), targetId: workspace.targetId, reservationId: id(), expectedRevision: 0 as const, expectedWorkspaceRevision: 1, externalProjectId: externalProject, projectVersion: 1, opsFolderProjectId: physicalProject, opsDivisionId: division, baseR2Prefix: basePrefix, baseMatchMethod: "manual", baseConfirmedBy: "native-delivery-owner", baseConfirmedAt: "2026-09-30 12:00:00", clientFolderBindingId: `folder:${id()}`, selectedR2Prefix: `${basePrefix}selected/`, reason: "Synthetic selected folder" };
    await reserveOperationsPortalFolder(operations, owner(), folder);
    const publication = await reserveOperationsPortalWorkspacePublication(operations, owner(), { operationId: id(), publicationId: id(), targetId: workspace.targetId, snapshotId: id(), checkpointId: id(), expectedRevision: 0, reason: "Synthetic publication" });
    expect(await dispatchCurrentPublication(publication.operationId)).toMatchObject({ status: "acknowledged" });
    const issued = await issueOperationsPortalNativeRecipientIntent(operations, { operationId: id(), targetId: workspace.targetId, targetClientRecordId: clientRecord, expiresAt: future(24), owner: owner() });
    await redeemOperationsPortalNativeRecipientIntent(operations, { operationId: id(), intentId: issued.review.intentId, opaqueToken: issued.opaqueToken!, principal: { issuer, subject }, recipientLabel: "synthetic@example.invalid", verifiedUntil: future(2), acknowledgedTarget: { targetId: workspace.targetId, targetRevision: 1, clientRecordId: clientRecord } });
    const homeOperationId = id();
    await confirmOperationsPortalNativeRecipientIntent(operations, { operationId: homeOperationId, intentId: issued.review.intentId, expectedRevision: 2, owner: owner() });
    await materializeOperationsPortalNativeRecipientAuthority(operations, homeOperationId);
    const recipientEnvironment = { DELIVERY_DB: client, ENVIRONMENT: "staging", EXPECTED_HOST: "client-staging.example.test", CLIENT_PORTAL_ORIGIN: "https://client-staging.example.test", CLIENT_PORTAL_OPERATIONS_NATIVE_AUTHORITY_WRITER_ENABLED: "true", CLIENT_PORTAL_OPERATIONS_NATIVE_AUTHORITY_STATUS_ENABLED: "true" };
    expect(await dispatchOperationsPortalNativeRecipientAuthority({ OPS_DB: operations, OPERATIONS_PORTAL_NATIVE_RECIPIENT_AUTHORITY_DISPATCH_ENABLED: "true", OPERATIONS_PORTAL_NATIVE_RECIPIENT_AUTHORITY: { applyNativeAuthority: wire => applyOperationsPortalNativeRecipientAuthority(recipientEnvironment, wire), getNativeAuthorityStatus: wire => readOperationsPortalNativeRecipientAuthorityStatus(recipientEnvironment, wire) } }, homeOperationId)).toMatchObject({ status: "acknowledged" });
    const home = await readOperationsPortalNativeRecipientIntent(operations, issued.review.intentId);
    const candidates = await listOperationsPortalNativeDeliveryCandidates(operations, { targetId: workspace.targetId, owner: owner() });
    const candidate = candidates.items.find(item => item.recipientBindingId === home!.recipientBindingId && item.folderReservationId === folder.reservationId);
    if (!candidate)
        throw Error("Synthetic delivery candidate missing");
    const operationId = id(), authorityId = id();
    await issueOperationsPortalNativeDeliveryAuthority(operations, { operationId, authorityId, recipientBindingId: home!.recipientBindingId!, folderReservationId: folder.reservationId, expectedRevision: 0, expectedCandidateFingerprint: candidate.candidateFingerprint, features: ["folder.list", "file.metadata", "file.download"], expiresAt: future(1), reasonCode: "Synthetic local transport", owner: owner() });
    const deliveryEnvironment = { DELIVERY_DB: client, ENVIRONMENT: "staging", CLIENT_PORTAL_OPERATIONS_NATIVE_DELIVERY_WRITER_ENABLED: "true", CLIENT_PORTAL_OPERATIONS_NATIVE_DELIVERY_STATUS_ENABLED: "true" };
    expect(await dispatchNextOperationsPortalNativeDeliveryAuthority({ database: operations, operationId, binding: { applyNativeDeliveryAuthority: wire => applyOperationsPortalNativeDeliveryAuthority(deliveryEnvironment, wire), getNativeDeliveryAuthorityStatus: wire => readOperationsPortalNativeDeliveryAuthorityStatus(deliveryEnvironment, wire) } })).toMatchObject({ state: "acknowledged" });
    const wire = await operations.prepare("SELECT canonical_wire_json FROM operations_portal_native_delivery_authority_outbox WHERE operation_id=?").bind(operationId).first<string>("canonical_wire_json");
    const command = parseOperationsPortalNativeDeliveryAuthorityCommand(JSON.parse(wire!));
    if (!command)
        throw Error("Synthetic grant command missing");
    return { command, objectKey: `${folder.selectedR2Prefix}map.bin`,
        async revoke() {
            await revokeOperationsPortalNativeDeliveryAuthority(operations, { operationId: id(), authorityId, expectedRevision: 1, reasonCode: "Synthetic Ops-only revoke", owner: owner() });
            // Deliberately leave the Client consumer's grant active: denial must come from Ops reader.
            expect(await client.prepare("SELECT state FROM operations_portal_native_delivery_heads WHERE authority_id=?").bind(authorityId).first("state")).toBe("active");
        } };
}
