import { constants, createHash, createPublicKey, verify as verifySignature } from 'node:crypto';
import { closeSync, fstatSync, fsyncSync, lstatSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalJson, verifyCloudflareAccessJwt } from './native-staff-bootstrap-owner-approval.mjs';
import { createApprovedExecutorD1Provider } from './native-staff-bootstrap-approved-executor.mjs';
import { STAGE_PINS, STAGE_OWNER_ADOPTION_TARGET_STAFF_ID as STAFF, STAGE_OWNER_ADOPTION_CONSENT_PHRASE,
  readStageOwnerAdoptionSnapshot, buildStageOwnerAdoptionPlan, stageOwnerAdoptionConsentEnvelope,
  prepareStageOwnerAdoption, executeStageOwnerAdoption } from './stage-owner-native-adoption.mjs';
import { STAGE_OWNER_ADOPTION_OPERATOR_TRUST_SHA256 } from './stage-owner-native-adoption-operator-trust-pin.mjs';

export const STAGE_OWNER_ACCESS = Object.freeze({
  origin: 'https://ledge-top-ops-staging.ledge-top-staging.workers.dev',
  issuer: 'https://ledge-top-staging.cloudflareaccess.com',
  audience: 'ffb0d85b1929560fbafd7476a987401e0e25dc5000a251fcdcf85bc2ae5d7f84',
});
const TARGET = Object.freeze({ accountId: STAGE_PINS.accountId, databaseId: STAGE_PINS.databaseId });
const KIND = 'operations-stage-owner-adoption-private-review-v1';
const TRUST_KIND = 'operations-stage-owner-adoption-operator-trust-v1';
const MAX = 16 * 1024 * 1024;
const sha = value => createHash('sha256').update(value).digest('hex');
const fail = code => { throw new Error(`stage_owner_operator_${code}`); };
const need = (ok, code) => { if (!ok) fail(code); };
const exact = (v, keys) => v && Object.getPrototypeOf(v) === Object.prototype
  && Reflect.ownKeys(v).length === keys.length && keys.every(k => Object.hasOwn(v, k));
const same = (a, b) => canonicalJson(a) === canonicalJson(b);

function checkedOwner(owner) {
  need(owner?.id === STAFF && owner.status === 'active' && typeof owner.email === 'string'
    && owner.email === owner.email.trim().toLowerCase() && owner.email.includes('@')
    && typeof owner.access_subject === 'string' && owner.access_subject === owner.access_subject.trim()
    && owner.access_subject.length > 0 && owner.access_subject.length <= 191, 'canonical_owner_unavailable');
  return owner;
}

/** Mapping ONLY; production first calls the real exported RS256/JWKS verifier. */
export function stageOwnerClaimsFromVerifiedJwt(verified, owner, now = Date.now()) {
  checkedOwner(owner);
  need(verified?.issuer === STAGE_OWNER_ACCESS.issuer && verified.audience === STAGE_OWNER_ACCESS.audience
    && verified.subject === owner.access_subject && typeof verified.email === 'string'
    && verified.email === verified.email.trim() && verified.email.toLowerCase() === owner.email
    && Number.isSafeInteger(verified.issuedAt) && verified.issuedAt >= 0 && verified.issuedAt <= Math.floor(now / 1000)
    && Number.isSafeInteger(verified.expiresAt) && verified.expiresAt > Math.floor(now / 1000)
    && verified.expiresAt > verified.issuedAt && verified.expiresAt <= 253402300799, 'verified_owner_mismatch_or_expired');
  return Object.freeze({ staffId: STAFF, email: owner.email, accessSubject: owner.access_subject,
    verifiedUntil: new Date(verified.expiresAt * 1000).toISOString() });
}

/** No caller-supplied identity verifier; owner comes from the current fixed D1 row. */
export function createStageOwnerIdentityVerifier(db, { fetchImpl = globalThis.fetch, now = Date.now } = {}) {
  const current = async () => checkedOwner(await db.prepare('SELECT id,email,display_name,access_subject,status FROM staff_users WHERE id=?').bind(STAFF).first());
  return async token => {
    const before = await current();
    const verified = await verifyCloudflareAccessJwt(token, { ...STAGE_OWNER_ACCESS,
      owner: { staffId: STAFF, accessSubject: before.access_subject } }, { fetchImpl, now: now() });
    const after = await current();
    need(before.email === after.email && before.access_subject === after.access_subject, 'owner_changed_during_jwks');
    return stageOwnerClaimsFromVerifiedJwt(verified, after, now());
  };
}

export function parseStageOwnerOperatorTrust(text, reviewedSha256) {
  need(typeof text === 'string' && Buffer.byteLength(text) <= 32768
    && typeof reviewedSha256 === 'string' && /^[0-9a-f]{64}$/.test(reviewedSha256)
    && sha(text) === reviewedSha256, 'trust_unprovisioned_or_pin_mismatch');
  let v; try { v = JSON.parse(text); } catch { fail('trust_invalid'); }
  need(exact(v, ['schemaVersion','kind','target','ownerStaffId','issuer','audience','keyId','publicKeyPem','consentDirectory'])
    && v.schemaVersion === 1 && v.kind === TRUST_KIND && same(v.target, TARGET) && v.ownerStaffId === STAFF
    && v.issuer === STAGE_OWNER_ACCESS.issuer && v.audience === STAGE_OWNER_ACCESS.audience
    && typeof v.keyId === 'string' && /^[0-9a-f]{64}$/.test(v.keyId)
    && typeof v.publicKeyPem === 'string' && v.publicKeyPem.length <= 16384
    && typeof v.consentDirectory === 'string' && path.isAbsolute(v.consentDirectory), 'trust_invalid');
  let key; try { key = createPublicKey(v.publicKeyPem); } catch { fail('trust_key_invalid'); }
  need(key.asymmetricKeyType === 'rsa' && (key.asymmetricKeyDetails?.modulusLength ?? 0) >= 3072
    && sha(key.export({ type: 'spki', format: 'der' })) === v.keyId, 'trust_key_invalid');
  return Object.freeze({ ...v, target: TARGET });
}

/** Verify the owner's EXTERNALLY produced signature over the exact closed envelope. */
export function verifyStageOwnerConsentProof(envelope, proof, trust) {
  if (!exact(proof, ['schemaVersion','algorithm','keyId','signature']) || proof.schemaVersion !== 1
    || proof.algorithm !== 'RSA-PSS-SHA256' || proof.keyId !== trust.keyId
    || typeof proof.signature !== 'string' || proof.signature.length > 4096
    || !/^[A-Za-z0-9+/]+={0,2}$/.test(proof.signature)) return false;
  try {
    const bytes = Buffer.from(proof.signature, 'base64');
    if (bytes.toString('base64') !== proof.signature) return false;
    return verifySignature('sha256', Buffer.from(canonicalJson(envelope)),
      { key: createPublicKey(trust.publicKeyPem), padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: 32 }, bytes);
  } catch { return false; }
}

/** One attempt only. A lost ACK may follow a committed transaction. */
export function createStageOwnerSingleDispatch(submit) {
  need(typeof submit === 'function', 'transport_required');
  let dispatched = false;
  return Object.freeze({
    get dispatched() { return dispatched; },
    async submit(request, target) {
      need(!dispatched && same(target, TARGET) && exact(request, ['batch']), 'duplicate_or_wrong_target_dispatch');
      dispatched = true;
      return submit(request.batch);
    },
  });
}

function consentPath(trust, approvalId) {
  // Hash IDs so colons/ADS or path components accepted by old identifier contracts never become filenames.
  return path.join(trust.consentDirectory, `stage-owner-consent-${sha(approvalId)}.json`);
}

/** Concrete fixed-target provider. Credential/fetch primitives are root-owned, not JSON approval callbacks. */
export function createStageOwnerAdoptionOperator({ getBearerToken, getOwnerIdentityToken,
  fetchImpl = globalThis.fetch, now = Date.now, trustFile } = {}) {
  need(typeof getBearerToken === 'function' && typeof getOwnerIdentityToken === 'function'
    && typeof fetchImpl === 'function' && typeof now === 'function', 'credentials_required');
  const db = createApprovedExecutorD1Provider({ config: { target: TARGET }, getBearerToken, fetchImpl });
  const verifyOwnerIdentity = createStageOwnerIdentityVerifier(db, { fetchImpl, now });
  const trust = () => parseStageOwnerOperatorTrust(readPrivateText(trustFile, 32768), STAGE_OWNER_ADOPTION_OPERATOR_TRUST_SHA256);
  return Object.freeze({
    async prepare({ approvalId, commandId }) {
      await db.assertTarget();
      const token = await getOwnerIdentityToken(); await verifyOwnerIdentity(token);
      const reviewedSnapshot = await readStageOwnerAdoptionSnapshot(db, TARGET);
      const identity = await verifyOwnerIdentity(token), owner = JSON.parse(reviewedSnapshot.snapshotJson).owner;
      need(owner.staffId === STAFF && owner.email.toLowerCase() === identity.email && owner.accessSubject === identity.accessSubject, 'review_owner_changed');
      const approval = { approvalId, issuedAt: new Date(now()).toISOString(), expiresAt: new Date(now() + 10 * 60 * 1000).toISOString() };
      const canonicalPlanJson = buildStageOwnerAdoptionPlan(reviewedSnapshot, { approvalId, commandId });
      const envelope = stageOwnerAdoptionConsentEnvelope({ snapshot: reviewedSnapshot, canonicalPlanJson, approval, commandId });
      return Object.freeze({ schemaVersion: 1, kind: KIND, target: TARGET,
        reviewedSnapshot: { snapshotJson: reviewedSnapshot.snapshotJson, snapshotSha256: reviewedSnapshot.snapshotSha256 },
        canonicalPlanJson, approval, commandId, consentEnvelope: envelope, consentEnvelopeSha256: sha(canonicalJson(envelope)) });
    },
    async execute(packet) {
      // Own the review bytes across every asynchronous verification boundary.
      packet = JSON.parse(canonicalJson(packet));
      need(exact(packet, ['schemaVersion','kind','target','reviewedSnapshot','canonicalPlanJson','approval','commandId','consentEnvelope','consentEnvelopeSha256'])
        && packet.schemaVersion === 1 && packet.kind === KIND && same(packet.target, TARGET)
        && packet.consentEnvelopeSha256 === sha(canonicalJson(packet.consentEnvelope)), 'review_packet_invalid');
      const loadConsent = () => {
        const configured = trust(), receipt = JSON.parse(readPrivateText(consentPath(configured, packet.approval.approvalId), 65536));
        need(exact(receipt, ['envelope','proof']) && same(receipt.envelope, packet.consentEnvelope)
          && verifyStageOwnerConsentProof(receipt.envelope, receipt.proof, configured), 'external_consent_unverified');
        return receipt;
      };
      // Re-read exact external consent/trust on every check: removing/replacing it revokes before dispatch.
      const signed = loadConsent();
      const verifyConsent = ({ envelope, envelopeSha256, proof }) => {
        try { const fresh = loadConsent(); return envelopeSha256 === packet.consentEnvelopeSha256
          && same(envelope, fresh.envelope) && same(proof, fresh.proof); } catch { return false; }
      };
      await db.assertTarget();
      const ownerIdentityToken = await getOwnerIdentityToken();
      const prepared = await prepareStageOwnerAdoption({ target: TARGET, reviewedSnapshot: packet.reviewedSnapshot,
        canonicalPlanJson: packet.canonicalPlanJson, approval: packet.approval, commandId: packet.commandId,
        ownerIdentityToken, consent: signed }, { verifyOwnerIdentity, verifyConsent, now });
      const dispatch = createStageOwnerSingleDispatch(batch => db.query(batch));
      try {
        return await executeStageOwnerAdoption(db, prepared, { ownerIdentityToken: await getOwnerIdentityToken(), verifyOwnerIdentity, verifyConsent, now,
          submitBatch: dispatch.submit });
      } catch {
        // Do not infer rollback from a transport exception or a failed readback.
        // Retain this exact packet's IDs; reconcile read-only before any further action.
        fail(dispatch.dispatched ? 'outcome_uncertain_no_replay_reconcile_exact_packet' : 'refused_before_dispatch');
      }
    },
  });
}

// File helpers operate only when the real CLI/root calls them; imports/tests read no credentials.
function windowsPrivateCheck(file) {
  const script = `$ErrorActionPreference='Stop'; $i=Get-Item -LiteralPath $env:LT_STAGE_PRIVATE_FILE -Force; if($i.PSIsContainer -or ($i.Attributes -band [IO.FileAttributes]::ReparsePoint)){exit 1}; $a=Get-Acl -LiteralPath $i.FullName; $s=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value; if(-not $a.AreAccessRulesProtected -or $a.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $s){exit 1}; $r=@($a.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])); if($r.Count -ne 3){exit 1}; $seen=@{}; foreach($x in $r){$v=$x.IdentityReference.Value; if($v -notin @($s,'S-1-5-18','S-1-5-32-544') -or $seen.ContainsKey($v) -or $x.IsInherited -or $x.AccessControlType -ne 'Allow' -or $x.FileSystemRights -ne [Security.AccessControl.FileSystemRights]::FullControl -or $x.InheritanceFlags -ne 'None' -or $x.PropagationFlags -ne 'None'){exit 1};$seen[$v]=$true}`;
  const p = spawnSync('pwsh.exe', ['-NoLogo','-NoProfile','-NonInteractive','-Command',script],
    { env: { ...process.env, LT_STAGE_PRIVATE_FILE: file }, windowsHide: true, timeout: 5000, stdio: 'ignore' });
  need(!p.error && p.status === 0, 'private_file_acl_invalid');
}
export function readPrivateText(file, max = MAX) {
  need(typeof file === 'string' && path.isAbsolute(file), 'private_file_path_required');
  const info = lstatSync(file);
  need(info.isFile() && !info.isSymbolicLink() && info.nlink === 1 && info.size > 0 && info.size <= max, 'private_file_invalid');
  if (process.platform === 'win32') windowsPrivateCheck(file);
  else need((info.mode & 0o077) === 0 && info.uid === process.getuid(), 'private_file_permissions');
  return readFileSync(file, 'utf8');
}
export function writePrivateReview(file, packet) {
  need(typeof file === 'string' && path.isAbsolute(file), 'private_file_path_required');
  const bytes = `${canonicalJson(packet)}\n`; need(Buffer.byteLength(bytes) <= MAX, 'review_too_large');
  const fd = openSync(file, 'wx', 0o600);
  try {
    if (process.platform === 'win32') {
      const helper = fileURLToPath(new URL('./restrict-private-authority-file.ps1', import.meta.url));
      const p = spawnSync('pwsh.exe', ['-NoLogo','-NoProfile','-NonInteractive','-File',helper,'-LiteralFile',file], { windowsHide:true,timeout:5000,stdio:'ignore' });
      need(!p.error && p.status === 0, 'private_file_acl_unavailable'); windowsPrivateCheck(file);
    }
    need(lstatSync(file).ino === fstatSync(fd).ino && lstatSync(file).dev === fstatSync(fd).dev, 'review_file_replaced');
    writeFileSync(fd, bytes); fsyncSync(fd);
  } finally { closeSync(fd); }
  return sha(bytes);
}

async function secretStdin() {
  need(!process.stdin.isTTY, 'secret_stdin_required'); const chunks = []; let bytes = 0;
  for await (const chunk of process.stdin) { bytes += chunk.length; need(bytes <= 40000, 'secret_stdin_too_large'); chunks.push(chunk); }
  let v; try { v = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { fail('secret_stdin_invalid'); }
  need(exact(v, ['ownerIdentityToken','managementBearerToken']) && typeof v.ownerIdentityToken === 'string'
    && v.ownerIdentityToken.length <= 16384 && typeof v.managementBearerToken === 'string'
    && v.managementBearerToken.length >= 20 && v.managementBearerToken.length <= 16384, 'secret_stdin_invalid');
  return v;
}
async function main(argv) {
  need((argv[0] === 'prepare' && argv.length === 4) || (argv[0] === 'execute' && argv.length === 3), 'usage');
  const secret = await secretStdin();
  const operator = createStageOwnerAdoptionOperator({ getBearerToken: () => secret.managementBearerToken,
    getOwnerIdentityToken: () => secret.ownerIdentityToken, trustFile: argv[0] === 'execute' ? path.resolve(argv[2]) : undefined });
  if (argv[0] === 'prepare') {
    const packet = await operator.prepare({ approvalId: argv[2], commandId: argv[3] });
    const digest = writePrivateReview(path.resolve(argv[1]), packet);
    console.log(canonicalJson({ mode: 'prepared_read_only', reviewSha256: digest,
      snapshotSha256: packet.reviewedSnapshot.snapshotSha256, consentEnvelopeSha256: packet.consentEnvelopeSha256, grantCount: 0 }));
  } else {
    const packet = JSON.parse(readPrivateText(path.resolve(argv[1])));
    console.log(canonicalJson(await operator.execute(packet)));
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch(() => { process.stderr.write('stage_owner_operator_refused_or_outcome_uncertain_no_automatic_retry\n'); process.exitCode = 1; });
}
