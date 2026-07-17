const encoder = new TextEncoder();

export function base64Url(bytes: Uint8Array): string {
  let binary = ""; for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

export function randomToken(bytes = 32): string { const value = new Uint8Array(bytes); crypto.getRandomValues(value); return base64Url(value); }
export async function sha256(value: string): Promise<string> { return base64Url(new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(value)))); }

function fromBase64Url(value: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("Encrypted token data is invalid");
  const raw = atob(value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "="));
  const bytes = new Uint8Array(raw.length);
  for (let index = 0; index < raw.length; index += 1) bytes[index] = raw.charCodeAt(index);
  return bytes;
}

async function tokenEncryptionKey(secret: string): Promise<CryptoKey> {
  if (secret.length < 32) throw new Error("DELIVERY_TOKEN_SECRET must contain at least 32 characters");
  const keyMaterial = await crypto.subtle.digest("SHA-256", encoder.encode(`ltds-delivery-link:v1:${secret}`));
  return crypto.subtle.importKey("raw", keyMaterial, "AES-GCM", false, ["encrypt", "decrypt"]);
}

function tokenAdditionalData(shareId: string): Uint8Array<ArrayBuffer> {
  return encoder.encode(`ltds-delivery-link:v1:${shareId}`);
}

export async function encryptDeliveryToken(value: string, secret: string, shareId: string): Promise<{ ciphertext: string; iv: string }> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: tokenAdditionalData(shareId) },
    await tokenEncryptionKey(secret),
    encoder.encode(value),
  );
  return { ciphertext: base64Url(new Uint8Array(ciphertext)), iv: base64Url(iv) };
}

export async function decryptDeliveryToken(ciphertext: string, iv: string, secret: string, shareId: string): Promise<string> {
  try {
    const plaintext = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: fromBase64Url(iv), additionalData: tokenAdditionalData(shareId) },
      await tokenEncryptionKey(secret),
      fromBase64Url(ciphertext),
    );
    return new TextDecoder("utf-8", { fatal: true }).decode(plaintext);
  } catch {
    throw new Error("The saved delivery link cannot be recovered and must be rotated");
  }
}
export async function hmac(secret: string, value: string): Promise<string> {
  if (secret.length < 32) throw new Error("A cryptographic Worker secret is missing or too short");
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return base64Url(new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(value))));
}
export function timingSafeEqual(left: string, right: string): boolean { const a = encoder.encode(left),b=encoder.encode(right);const length=Math.max(a.length,b.length);let difference=a.length^b.length;for(let index=0;index<length;index++)difference|=(a[index]||0)^(b[index]||0);return difference===0; }

export async function hashAccessCode(value: string, pepper?: string): Promise<{ hash: string; salt: string; iterations: number; algorithm: "hmac-sha256-v1" }> {
  if (value.length < 8) throw new Error("Access codes must be at least eight characters");
  if (!pepper) throw new Error("DELIVERY_ACCESS_CODE_PEPPER is required");
  const salt = randomToken(16);
  return { hash: await hmac(pepper, `access-code:v1:${salt}:${value}`), salt, iterations: 1, algorithm: "hmac-sha256-v1" };
}

export async function accessCodeMatches(value:string,expectedHash:string,salt:string,algorithm:string|null,pepper:string):Promise<boolean>{
  if(algorithm!=="hmac-sha256-v1"||value.length<8)return false;
  return timingSafeEqual(await hmac(pepper,`access-code:v1:${salt}:${value}`),expectedHash);
}
