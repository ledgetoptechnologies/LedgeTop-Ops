// AES-256-GCM sealing for DJI per-log decryption keys. The 32-byte key comes from the
// KEYCHAIN_ENCRYPTION_KEY secret (base64), set by an operator, never committed. Only the parser decrypts.
import { LogsError } from './errors.mjs';

export const KEY_VERSION = 1;
const toBase64 = bytes => btoa(String.fromCharCode(...bytes));
const fromBase64 = text => Uint8Array.from(atob(text), char => char.charCodeAt(0));

async function sealingKey(env) {
  const raw = typeof env?.KEYCHAIN_ENCRYPTION_KEY === 'string' ? fromBase64(env.KEYCHAIN_ENCRYPTION_KEY.trim()) : null;
  if (!raw || raw.length !== 32) throw new LogsError('keychain_key_missing', 503, 'Flight-log key storage isn’t configured yet, so decryption keys can’t be imported.');
  return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

export async function encryptKeychain(env, value) {
  const key = await sealingKey(env), iv = crypto.getRandomValues(new Uint8Array(12));
  const sealed = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(String(value))));
  return { ciphertext: toBase64(sealed), iv: toBase64(iv), keyVersion: KEY_VERSION };
}

/** For the log parser only. */
export async function decryptKeychain(env, { ciphertext, iv }) {
  const key = await sealingKey(env);
  return new TextDecoder().decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromBase64(iv) }, key, fromBase64(ciphertext)));
}
