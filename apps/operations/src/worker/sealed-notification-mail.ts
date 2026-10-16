import type { OutboundMail } from './mailer';

/** Select only an exact current or historical template reconstructed from the
 * caller's freshly authorized recipient/content witness. A stored fingerprint
 * is never replaced, and a changed witness must still fail both comparisons. */
export async function selectSealedNotificationMail(
  current: OutboundMail,
  legacy: () => OutboundMail,
  expectedFingerprint: string | null,
  fingerprint: (mail: OutboundMail) => Promise<string>,
): Promise<Readonly<{ mail: OutboundMail; fingerprint: string }> | null> {
  if (expectedFingerprint !== null && !/^[a-f0-9]{64}$/.test(expectedFingerprint)) return null;
  const currentFingerprint = await fingerprint(current);
  if (expectedFingerprint === null || expectedFingerprint === currentFingerprint)
    return { mail: current, fingerprint: currentFingerprint };
  const historical = legacy(), historicalFingerprint = await fingerprint(historical);
  return expectedFingerprint === historicalFingerprint
    ? { mail: historical, fingerprint: historicalFingerprint } : null;
}
