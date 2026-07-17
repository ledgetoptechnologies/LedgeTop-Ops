const encoder = new TextEncoder();

export function base64Url(bytes: Uint8Array): string {
  let binary = ""; for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

export function randomToken(bytes = 32): string { const value = new Uint8Array(bytes); crypto.getRandomValues(value); return base64Url(value); }
export async function sha256(value: string): Promise<string> { return base64Url(new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(value)))); }
export async function hmac(secret: string, value: string): Promise<string> {
  if (secret.length < 32) throw new Error("A cryptographic Worker secret is missing or too short");
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return base64Url(new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(value))));
}
export function timingSafeEqual(left: string, right: string): boolean { const a = encoder.encode(left),b=encoder.encode(right);const length=Math.max(a.length,b.length);let difference=a.length^b.length;for(let index=0;index<length;index++)difference|=(a[index]||0)^(b[index]||0);return difference===0; }

export async function hashAccessCode(value: string, _legacyPepper?: string): Promise<{ hash: string; salt: string; iterations: number }> {
  if (value.length < 8) throw new Error("Access codes must be at least eight characters");
  const salt = randomToken(16); const iterations = 150_000;
  const material = await crypto.subtle.importKey("raw", encoder.encode(value), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: encoder.encode(salt), iterations }, material, 256);
  return { hash: base64Url(new Uint8Array(bits)), salt, iterations };
}
