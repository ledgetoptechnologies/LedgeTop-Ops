// Reproduces the deployed v1 wire format independently of the current encoder.
export async function legacyNotificationCursor(secret: string, actor: {issuer: string; subject: string}) {
  return historicalNotificationCursor(secret,actor,1);
}
/** Independently encoded deployed/prepared v2 continuation. */
export async function v2NotificationCursor(secret: string, actor: {issuer: string; subject: string}) {
  return historicalNotificationCursor(secret,actor,2);
}
export async function v3NotificationCursor(secret: string, actor: {issuer: string; subject: string}) {
  return historicalNotificationCursor(secret,actor,3);
}
async function historicalNotificationCursor(secret: string, actor: {issuer: string; subject: string}, version:1|2|3) {
  const encode = (value: string) => new TextEncoder().encode(value);
  const key = await crypto.subtle.importKey('raw', await crypto.subtle.digest('SHA-256',
    encode(`portal-notification-history-v1\0${secret}`)), {name: 'AES-GCM'}, false, ['encrypt']);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const value = {v: version, scope: 'a'.repeat(64), asOf: '2026-09-06T12:00:00.000Z',
    coverage: {requests: 'included', feedback: 'included', ...(version===3?{nativeDelivery:'included'}:{})},
    water: {requests: 1, feedback: 1, ...(version===3?{nativeDelivery:1}:{})},
    after: ['2026-09-06T11:00:00.000Z', 'request:n1'], expires: Date.now() + 60_000};
  const cipher = new Uint8Array(await crypto.subtle.encrypt({name: 'AES-GCM', iv,
    additionalData: encode(`portal-notification-history-v1\0${actor.issuer}\0${actor.subject}`)}, key, encode(JSON.stringify(value))));
  const payload = new Uint8Array(iv.length + cipher.length);
  payload.set(iv); payload.set(cipher, iv.length);
  return `nh1_${Buffer.from(payload).toString('base64url')}`;
}
