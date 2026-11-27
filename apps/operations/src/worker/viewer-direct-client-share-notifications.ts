import { sendNotificationMail, smtpNotificationsEnabled, type OutboundMail } from "./mailer";
import { portalRootAccessAllowedSql } from "./client-portal-root-access";
import { sha256 } from "./crypto";
import type { Env } from "./types";

/**
 * "Email client" for a new Viewer direct share.
 *
 * No table of its own: every state change is an append-only row in
 * viewer_direct_client_grant_audit with a deterministic primary key, so a
 * duplicate INSERT fails and a replay can never claim or record twice.
 *   vdcg-notify:<grant>                     asked for, written with the grant itself
 *   vdcg-notify-attempt:<grant>:<id>:<n>    attempt n for one portal identity (the lease)
 *   vdcg-notify-sent:<grant>:<id>           delivered to that identity
 *   vdcg-notify-closed:<grant>              nothing more will be sent for this grant
 * Mail goes out from the scheduled run, never inside the share request, so a
 * slow or failing mail server cannot block or fail a share. Delivery is at
 * least once: a crash between the provider accepting a mail and its sent row
 * resends once after the lease, with the same Message-ID, as in the other
 * notification paths. A workspace of more than 200 members gets no email.
 */
export const SHARE_NOTICE_ACTOR = "system:viewer-share-email";
const REQUESTED = "grant.notify.requested", ATTEMPT = "grant.notify.attempt", SENT = "grant.notify.sent", CLOSED = "grant.notify.closed";
const GRACE_MS = 60_000;                 // a multi-task share is posted one task at a time; gather it first
const WINDOW_MS = 48 * 60 * 60_000;      // after this a share email would be stale
const LEASE_MS = 15 * 60_000;            // a claimed attempt is retried only after this
const MAX_ATTEMPTS = 3;
const MAX_RECIPIENTS = 200;              // per workspace; a larger workspace is closed without mail
const MAX_GRANTS = 50, MAX_MAILS = 25;   // bounded work per run; the next run continues

/** What the Viewer Share dialog may offer. No box is shown for an email that would never be sent. */
export function directViewerShareCapabilities(env: Pick<Env, "SMTP_NOTIFICATIONS_ENABLED">): string[] {
  return smtpNotificationsEnabled(env) ? ["notify_client_v1"] : [];
}

const requestId = (grant: string) => `vdcg-notify:${grant}`;
const attemptId = (grant: string, identity: string, n: number) => `vdcg-notify-attempt:${grant}:${identity}:${n}`;
const sentId = (grant: string, identity: string) => `vdcg-notify-sent:${grant}:${identity}`;
const closedId = (grant: string) => `vdcg-notify-closed:${grant}`;
const text = (value: unknown) => typeof value === "string" ? value.replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, 200) : "";

function auditRow(db: Pick<D1Database, "prepare">, id: string, grantId: string, action: string, actor: string,
  idempotencyKey: string, details: Record<string, unknown>, now: string): D1PreparedStatement {
  return db.prepare(`INSERT INTO viewer_direct_client_grant_audit VALUES(?,?,?,?,?,?,?)`)
    .bind(id, grantId, action, actor, idempotencyKey, JSON.stringify(details), now);
}

/** Added to the share's own INSERT batch, so it exists exactly when the new share does. */
export function shareNoticeRequestStatement(db: Pick<D1Database, "prepare">, input: { grantId: string; staffId: string;
  idempotencyKey: string; now: string; projectName?: string | null; taskName?: string | null }): D1PreparedStatement {
  return auditRow(db, requestId(input.grantId), input.grantId, REQUESTED, input.staffId, input.idempotencyKey,
    { projectName: text(input.projectName), taskName: text(input.taskName) }, input.now);
}

interface OpenGrant {
  id: string; workspace_id: string; source_id: string; viewer_project_id: string; task_id: string | null; scope_type: "project" | "task";
  status: string; revoked_at: string | null; authorization_expires_at: string | null; requested_at: string; details_json: string;
}
interface Member { identity_id: string; email: string }
interface Pair { grant: OpenGrant; identity: string }

export async function processDirectViewerShareNotices(env: Env,
  options: { nowMs?: number; send?: (env: Env, mail: OutboundMail) => Promise<void> } = {}): Promise<{ sent: number; closed: number }> {
  if (!smtpNotificationsEnabled(env)) return { sent: 0, closed: 0 };
  const nowMs = options.nowMs ?? Date.now(), send = options.send ?? sendNotificationMail;
  const iso = (ms: number) => new Date(ms).toISOString(), now = iso(nowMs);
  const db = env.DELIVERY_DB.withSession("first-primary");
  const open = (await db.prepare(`SELECT g.id,g.workspace_id,g.source_id,g.viewer_project_id,g.task_id,g.scope_type,g.status,g.revoked_at,
      g.authorization_expires_at,request.created_at requested_at,request.details_json
    FROM viewer_direct_client_grant_audit request JOIN viewer_direct_client_grants g ON g.id=request.grant_id
    WHERE request.id>='vdcg-notify:' AND request.id<'vdcg-notify;' AND request.action=? AND request.id='vdcg-notify:'||g.id
      AND NOT EXISTS(SELECT 1 FROM viewer_direct_client_grant_audit closed WHERE closed.id='vdcg-notify-closed:'||g.id)
    ORDER BY request.created_at,g.id LIMIT ?`).bind(REQUESTED, MAX_GRANTS).all<OpenGrant>()).results;
  // The Viewer posts a multi-task share one task at a time. Hold every open request for a project
  // and workspace until the newest of them is a minute old, so one click becomes one email.
  const newest = new Map<string, number>();
  for (const grant of open) { const key = JSON.stringify([grant.viewer_project_id, grant.workspace_id]);
    newest.set(key, Math.max(newest.get(key) ?? 0, Date.parse(grant.requested_at))); }
  const settled = (grant: OpenGrant) => newest.get(JSON.stringify([grant.viewer_project_id, grant.workspace_id]))! <= nowMs - GRACE_MS;
  let closed = 0, sent = 0;
  const close = async (grant: OpenGrant, reason: string) => {
    try { await auditRow(db, closedId(grant.id), grant.id, CLOSED, SHARE_NOTICE_ACTOR, closedId(grant.id), { reason }, now).run(); closed++; }
    catch { /* closed concurrently */ }
  };
  const live: OpenGrant[] = [];
  for (const grant of open) {
    if (Date.parse(grant.requested_at) < nowMs - WINDOW_MS) await close(grant, "window-passed");
    else if (!settled(grant)) continue;
    else if (grant.status !== "active" || grant.revoked_at !== null
      || (grant.authorization_expires_at !== null && !(Date.parse(grant.authorization_expires_at) > nowMs))) await close(grant, "share-not-active");
    else live.push(grant);
  }
  // Current members only: active verified identity, active unrevoked unexpired membership, not denied.
  const denylist = env.CLIENT_PORTAL_IDENTITY_DENYLIST_ENABLED === "true" ? `AND NOT EXISTS(SELECT 1 FROM portal_v2_identity_denials denial
      WHERE denial.identity_id=identity.id AND denial.status='active' AND datetime(denial.valid_from)<=datetime(?2)
        AND (denial.expires_at IS NULL OR datetime(denial.expires_at)>datetime(?2))
        AND (denial.scope_type='global' OR (denial.scope_type='workspace' AND denial.workspace_id=w.id AND denial.scope_public_id=w.id)))` : "";
  const members = new Map<string, Member[] | null>();
  for (const grant of live) {
    if (members.has(grant.workspace_id)) continue;
    const rows = (await db.prepare(`SELECT identity.id identity_id,lower(trim(identity.verified_email)) email
      FROM portal_v2_workspaces w
      JOIN portal_v2_workspace_memberships membership ON membership.workspace_id=w.id AND membership.status='active'
        AND membership.revoked_at IS NULL AND (membership.expires_at IS NULL OR datetime(membership.expires_at)>datetime(?2))
      JOIN portal_v2_identities identity ON identity.id=membership.identity_id AND identity.status='active'
        AND identity.revoked_at IS NULL AND identity.verified_email IS NOT NULL AND instr(identity.verified_email,'@')>1
      WHERE w.id=?1 AND w.status='active' AND w.legacy_account_id IS NULL AND ${portalRootAccessAllowedSql(env, "w")} ${denylist}
      ORDER BY identity.id LIMIT ?3`).bind(grant.workspace_id, now, MAX_RECIPIENTS + 1).all<Member>()).results;
    members.set(grant.workspace_id, rows.length > MAX_RECIPIENTS ? null : rows);
  }
  // What is already recorded for every (grant, identity), read by primary key.
  const pairs: Pair[] = [];
  for (const grant of live) {
    const list = members.get(grant.workspace_id);
    if (list === null) { await close(grant, "recipient-limit"); continue; }
    if (!list!.length) { await close(grant, "no-current-members"); continue; }
    for (const member of list!) pairs.push({ grant, identity: member.identity_id });
  }
  const ids = pairs.flatMap(pair => [sentId(pair.grant.id, pair.identity),
    ...Array.from({ length: MAX_ATTEMPTS }, (_, n) => attemptId(pair.grant.id, pair.identity, n + 1))]);
  const recorded = new Map<string, string>();
  for (let start = 0; start < ids.length; start += 400) {
    const rows = (await db.prepare(`SELECT id,created_at FROM viewer_direct_client_grant_audit WHERE id IN (SELECT value FROM json_each(?))`)
      .bind(JSON.stringify(ids.slice(start, start + 400))).all<{ id: string; created_at: string }>()).results;
    for (const row of rows) recorded.set(row.id, row.created_at);
  }
  const attempts = (pair: Pair) => { let n = 0; while (n < MAX_ATTEMPTS && recorded.has(attemptId(pair.grant.id, pair.identity, n + 1))) n++; return n; };
  const done = (pair: Pair) => recorded.has(sentId(pair.grant.id, pair.identity)) || (attempts(pair) >= MAX_ATTEMPTS && !leased(pair));
  const leased = (pair: Pair) => { const n = attempts(pair); return n > 0 && !recorded.has(sentId(pair.grant.id, pair.identity))
    && Date.parse(recorded.get(attemptId(pair.grant.id, pair.identity, n))!) > nowMs - LEASE_MS; };
  // One email per person and Viewer project: several tasks, or linked workspaces, never mean several emails.
  const email = new Map<string, string>();
  for (const list of members.values()) for (const member of list ?? []) email.set(member.identity_id, member.email);
  const groups = new Map<string, Pair[]>();
  for (const pair of pairs) {
    const key = JSON.stringify([email.get(pair.identity), pair.grant.viewer_project_id]);
    groups.set(key, [...groups.get(key) ?? [], pair]);
  }
  const base = portalBase(env);
  if (!base && groups.size) console.warn(JSON.stringify({ event: "viewer_share_email_portal_url_invalid" }));
  for (const [key, group] of groups) {
    if (!base || sent >= MAX_MAILS) break;
    const pending = group.filter(pair => !done(pair));
    // Another run holds part of this person's email: leave the whole email to it.
    if (!pending.length || pending.some(leased)) continue;
    const to = JSON.parse(key)[0] as string;
    const claims = pending.map(pair => { const n = attempts(pair) + 1;
      return auditRow(db, attemptId(pair.grant.id, pair.identity, n), pair.grant.id, ATTEMPT, SHARE_NOTICE_ACTOR,
        attemptId(pair.grant.id, pair.identity, n), { attempt: n }, now); });
    // All-or-nothing: if any attempt key exists already, a concurrent run claimed it.
    try { await db.batch(claims); } catch { continue; }
    for (const pair of pending) recorded.set(attemptId(pair.grant.id, pair.identity, attempts(pair) + 1), now);
    const grants = [...new Map(pending.map(pair => [pair.grant.id, pair.grant])).values()].sort((a, b) => a.id.localeCompare(b.id));
    try {
      await send(env, await shareMail(base, to, grants));
    } catch { continue; /* the claim stays; retried once its lease ends */ }
    try {
      await db.batch(pending.map(pair => auditRow(db, sentId(pair.grant.id, pair.identity), pair.grant.id, SENT, SHARE_NOTICE_ACTOR,
        sentId(pair.grant.id, pair.identity), {}, now)));
    } catch { /* recorded by a concurrent run */ }
    for (const pair of pending) recorded.set(sentId(pair.grant.id, pair.identity), now);
    sent++;
  }
  // A grant is finished once every current member has been sent to or has run out of attempts.
  for (const grant of live) {
    const own = pairs.filter(pair => pair.grant === grant);
    if (own.length && own.every(done)) await close(grant, own.every(pair => recorded.has(sentId(grant.id, pair.identity))) ? "sent" : "attempts-exhausted");
  }
  return { sent, closed };
}

function portalBase(env: Env): URL | null {
  try {
    const base = new URL(env.DELIVERY_BASE_URL);
    return base.protocol === "https:" && !base.username && !base.password && !base.search && !base.hash ? base : null;
  } catch { return null; }
}

const escapeHtml = (value: string) => value.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

async function shareMail(base: URL, to: string, grants: OpenGrant[]): Promise<OutboundMail> {
  const details = grants.map(grant => { try { return JSON.parse(grant.details_json) as { projectName?: string; taskName?: string }; } catch { return {}; } });
  const project = text(details.find(item => text(item.projectName))?.projectName);
  const only = grants.length === 1 ? grants[0]! : null;
  const link = only?.scope_type === "task" && only.task_id
    ? new URL(`/portal/viewer/${encodeURIComponent(only.id)}/tasks/${encodeURIComponent(only.task_id)}?${new URLSearchParams({ workspace: only.workspace_id })}`, base).href
    : new URL("/portal", base).href;
  const taskName = only?.scope_type === "task" ? text(details[0]?.taskName) : "";
  const what = taskName ? `the 3D model “${taskName}”${project ? ` from ${project}` : ""}`
    : grants.every(grant => grant.scope_type === "task") && grants.length > 1 ? `${grants.length} 3D models${project ? ` from ${project}` : ""}`
    : project ? `the 3D project ${project}` : "a 3D model";
  const body = `Ledge Top has shared ${what} with you.`;
  return {
    to, fromName: "Ledge Top Client Portal",
    subject: project ? `${project} is ready to view` : "A 3D model is ready to view",
    text: `${body}\n\nOpen it in your client portal: ${link}`,
    html: `<p>${escapeHtml(body)}</p><p><a href="${escapeHtml(link)}">Open it in your client portal</a></p>`,
    messageIdKey: `viewer-share-${(await sha256(JSON.stringify([to, grants.map(grant => grant.id)]))).slice(0, 48)}`,
  };
}
