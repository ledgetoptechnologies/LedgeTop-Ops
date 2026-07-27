const encoder = new TextEncoder();
const decoder = new TextDecoder();

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64UrlToBytes(value: string): Uint8Array<ArrayBuffer> {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - normalized.length % 4) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

export function randomBase64Url(byteLength = 32): string {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return bytesToBase64Url(bytes);
}

export async function sha256Base64Url(value: string): Promise<string> {
  return bytesToBase64Url(new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(value))));
}

export interface EncryptedValue {
  ciphertext: string;
  iv: string;
}

async function importAesKey(secret: string): Promise<CryptoKey> {
  const bytes = base64UrlToBytes(secret);
  if (bytes.byteLength !== 32) throw new Error("cloud-transfer-encryption-key-invalid");
  return crypto.subtle.importKey("raw", bytes, "AES-GCM", false, ["encrypt", "decrypt"]);
}

export async function encryptJson(value: unknown, secret: string, additionalData: string): Promise<EncryptedValue> {
  const iv = new Uint8Array(12);
  crypto.getRandomValues(iv);
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: encoder.encode(additionalData), tagLength: 128 },
    await importAesKey(secret),
    encoder.encode(JSON.stringify(value)),
  );
  return { ciphertext: bytesToBase64Url(new Uint8Array(ciphertext)), iv: bytesToBase64Url(iv) };
}

export async function decryptJson<T>(
  encrypted: EncryptedValue,
  secret: string,
  additionalData: string,
): Promise<T> {
  try {
    const cleartext = await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: base64UrlToBytes(encrypted.iv),
        additionalData: encoder.encode(additionalData),
        tagLength: 128,
      },
      await importAesKey(secret),
      base64UrlToBytes(encrypted.ciphertext),
    );
    return JSON.parse(decoder.decode(cleartext)) as T;
  } catch {
    throw new Error("cloud-transfer-encrypted-value-invalid");
  }
}
