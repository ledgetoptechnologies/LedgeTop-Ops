import { Hono, type Context } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { readBoundedJson } from "./bounded-json";
import { authenticateNativeStaffWithAdmissionVersion } from "./native-staff-auth";
import { nativeExistingImportAreas, nativeExistingImportAuthority, nativeExistingImportEnabled } from "./native-directory-existing-import-common";
import { prepareNativeExistingDirectoryImport, executeNativeExistingDirectoryImport, readNativeExistingDirectoryImportStatus, renewNativeExistingDirectoryImport } from "./native-directory-existing-import";
import type { Env, StaffPrincipal } from "./types";
import type { NativeExistingImportActor, NativeExistingImportReview } from "./native-directory-existing-import-types";
type Bindings = {
    Bindings: Env;
    Variables: {
        principal: StaffPrincipal;
        administrator: boolean;
    };
};
const ROOT = "/api/client-hub/directory/existing-import";
const uuid = z.string().uuid(), source = z.string().regex(/^project-alpha:[a-z0-9][a-z0-9_-]{0,63}$/);
const selection = z.object({ batchId: uuid, sourceId: source, kind: z.enum(["organization", "client"]), recordId: z.string().min(1).max(191), businessAreaId: z.string().min(1).max(191), idempotencyKey: uuid }).strict();
const ref = z.object({ importId: uuid }).strict();
export function redactNativeImportReview(review: NativeExistingImportReview) {
    const { importId, batchId, sourceId, kind, recordId, nativeRecordId, publicId, parentRecordId, parentNativeRecordId, parentPublicId, businessAreaId, profile, expiresAt } = review;
    return { importId, batchId, sourceId, kind, recordId, nativeRecordId, publicId, parentRecordId, parentNativeRecordId, parentPublicId, businessAreaId, name: profile.name, profile, expiresAt };
}
async function actor(c: Context<Bindings>): Promise<NativeExistingImportActor> {
    if (!c.get("administrator"))
        throw new HTTPException(403, { message: "Administrator authority required" });
    let authenticated: Awaited<ReturnType<typeof authenticateNativeStaffWithAdmissionVersion>>;
    try {
        authenticated = await authenticateNativeStaffWithAdmissionVersion(c.req.raw, c.env.OPS_DB, { enabled: true, issuer: c.env.TEAM_DOMAIN ?? "", staffAudience: c.env.OPERATIONS_AUD });
    } catch {
        throw new HTTPException(403, { message: "Current native staff authority required" });
    }
    const principal = c.get("principal"), identity = authenticated.identity;
    if (identity.staffId !== principal.id || identity.email !== principal.email || identity.verifiedAccessSubject !== principal.accessSubject)
        throw new HTTPException(403, { message: "Native staff identity mismatch" });
    const generation = await c.env.OPS_DB.prepare("SELECT generation FROM native_directory_grant_generations WHERE staff_id=?").bind(identity.staffId).first<number>("generation");
    if (generation == null)
        throw new HTTPException(403, { message: "Native staff authority required" });
    return { staffId: identity.staffId, accessSubject: identity.verifiedAccessSubject, loginEmail: identity.email, admissionVersion: authenticated.admissionVersion,
        profileVersion: identity.profileVersion, grantGeneration: generation, verifiedUntil: authenticated.verifiedUntil };
}
async function body<T>(c: Context<Bindings>, schema: z.ZodType<T>): Promise<T> {
    const value = await readBoundedJson(c.req.raw, 8192);
    const parsed = schema.safeParse(value);
    if (!parsed.success)
        throw new HTTPException(400, { message: "Invalid import request" });
    return parsed.data;
}
export function registerNativeDirectoryExistingImportRoutes(app: Hono<Bindings>): void {
    app.use(`${ROOT}/*`, async (c, next) => { c.header("Cache-Control", "no-store"); if (!await nativeExistingImportEnabled(c.env))
        throw new HTTPException(404, { message: "Not found" }); await next(); });
    app.get(`${ROOT}/candidates`, async (c) => {
        const current = await actor(c), areas = nativeExistingImportAreas(c.env), selected = c.req.query("sourceId"), limit = Math.floor(Math.min(50, Math.max(1, Number(c.req.query("limit") ?? 50) || 50)));
        const cursor = c.req.query("cursor") ?? "";
        if (cursor.length > 512 || /\p{C}/u.test(cursor))
            throw new HTTPException(400, { message: "Invalid import cursor" });
        if (selected && !Object.hasOwn(areas, selected))
            throw new HTTPException(400, { message: "Unknown import source" });
        const sources = Object.entries(areas).filter(([id]) => !selected || id === selected);
        const eligible: Array<{
            sourceId: string;
            businessAreaId: string;
        }> = [];
        for (const [sourceId, businessAreaId] of sources)
            if (await nativeExistingImportAuthority(c.env, current, sourceId, "organization", "candidate-admission", businessAreaId))
                eligible.push({ sourceId, businessAreaId });
        if (!eligible.length)
            throw new HTTPException(403, { message: "Native import authority required" });
        const rows = await c.env.OPS_DB.prepare(`SELECT classic.*,parent.public_id parent_public_id FROM native_directory_existing_import_classic classic
   LEFT JOIN native_directory_existing_import_classic parent ON parent.source_id=classic.source_id AND parent.record_kind='organization' AND parent.record_id=classic.parent_record_id
   WHERE classic.source_id IN (${eligible.map(() => "?").join(",")}) AND classic.source_id||'|'||classic.record_kind||'|'||classic.record_id>?
    AND NOT EXISTS(SELECT 1 FROM native_directory_grants deny WHERE deny.staff_id=? AND deny.active=1 AND deny.effect='deny'
     AND deny.permission IN ('directory.profile.view','directory.profile.edit','directory.identity.link','directory.enrollment.manage')
     AND deny.scope_kind='resource' AND deny.resource_id IN (classic.record_id,'pa-import:'||classic.source_id||':'||classic.record_kind||':'||classic.record_id))
    AND NOT EXISTS(SELECT 1 FROM native_directory_existing_import_identity_translations translation WHERE translation.source_id=classic.source_id AND translation.record_kind=classic.record_kind AND translation.classic_record_id=classic.record_id)
   ORDER BY classic.source_id||'|'||classic.record_kind||'|'||classic.record_id LIMIT ?`).bind(...eligible.map(s => s.sourceId), cursor, current.staffId, limit + 1).all<{
            source_id: string;
            record_kind: "organization" | "client";
            record_id: string;
            public_id: string;
            name: string;
            parent_record_id: string | null;
            parent_public_id: string | null;
        }>();
        const visible = rows.results.slice(0, limit);
        return c.json({ sources: eligible, items: visible.map(r => ({ sourceId: r.source_id, kind: r.record_kind, recordId: r.record_id, publicId: r.public_id, name: r.name, parentRecordId: r.parent_record_id, parentPublicId: r.parent_public_id, businessAreaId: areas[r.source_id] })),
            nextCursor: rows.results.length > limit && visible.length ? `${visible.at(-1)!.source_id}|${visible.at(-1)!.record_kind}|${visible.at(-1)!.record_id}` : null });
    });
    app.post(`${ROOT}/review`, async (c) => {
        const input = await body(c, selection);
        if (c.req.header("Idempotency-Key") !== input.idempotencyKey)
            throw new HTTPException(400, { message: "Idempotency-Key mismatch" });
        const result = await prepareNativeExistingDirectoryImport(c.env, input, await actor(c));
        return c.json(result.status === "reviewed" ? { ...result, review: redactNativeImportReview(result.review) } : result);
    });
    app.post(`${ROOT}/execute`, async (c) => { const input = await body(c, ref); if (c.req.header("Idempotency-Key") !== input.importId)
        throw new HTTPException(400, { message: "Idempotency-Key mismatch" }); return c.json(await executeNativeExistingDirectoryImport(c.env, input, await actor(c))); });
    app.post(`${ROOT}/renew`, async (c) => {
        const input = await body(c, ref);
        if (c.req.header("Idempotency-Key") !== input.importId)
            throw new HTTPException(400, { message: "Idempotency-Key mismatch" });
        const result = await renewNativeExistingDirectoryImport(c.env, input.importId, await actor(c));
        return c.json(result.status === "reviewed" ? { ...result, review: redactNativeImportReview(result.review) } : result);
    });
    app.get(`${ROOT}/status`, async (c) => {
        const input = uuid.safeParse(c.req.query("importId"));
        if (!input.success) throw new HTTPException(400, { message: "Invalid import ID" });
        const result = await readNativeExistingDirectoryImportStatus(c.env, input.data, await actor(c));
        return c.json("review" in result ? { ...result, review: redactNativeImportReview(result.review) } : result);
    });
}
