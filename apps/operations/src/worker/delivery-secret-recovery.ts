import { decryptDeliveryToken, encryptDeliveryToken } from "./crypto";
import type { Env } from "./types";

export interface RecoverableDeliverySecret {
  id: string;
  secret_ciphertext: string | null;
  secret_iv: string | null;
}

/**
 * Recover an existing share bearer with the current key or the bounded previous
 * key. A successful previous-key read is immediately re-encrypted so queued
 * mail and staff recovery do not extend the rotation window indefinitely.
 */
export async function recoverDeliveryShareSecret(
  env: Pick<Env, "DELIVERY_DB" | "DELIVERY_TOKEN_SECRET" | "DELIVERY_PREVIOUS_TOKEN_SECRET">,
  share: RecoverableDeliverySecret,
): Promise<string | null> {
  if (!share.secret_ciphertext || !share.secret_iv) return null;
  try {
    return await decryptDeliveryToken(share.secret_ciphertext, share.secret_iv, env.DELIVERY_TOKEN_SECRET, share.id);
  } catch {
    if (!env.DELIVERY_PREVIOUS_TOKEN_SECRET) return null;
    try {
      const secret = await decryptDeliveryToken(
        share.secret_ciphertext,
        share.secret_iv,
        env.DELIVERY_PREVIOUS_TOKEN_SECRET,
        share.id,
      );
      const encrypted = await encryptDeliveryToken(secret, env.DELIVERY_TOKEN_SECRET, share.id);
      await env.DELIVERY_DB.prepare(`UPDATE shares SET secret_ciphertext=?,secret_iv=?
        WHERE id=? AND secret_ciphertext=? AND secret_iv=?`)
        .bind(encrypted.ciphertext, encrypted.iv, share.id, share.secret_ciphertext, share.secret_iv).run();
      return secret;
    } catch {
      return null;
    }
  }
}
