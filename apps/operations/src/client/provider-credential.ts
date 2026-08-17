export const MAX_PROVIDER_CREDENTIAL_BYTES = 4096;

export function providerCredentialError(value: string): string | null {
  if (!value) return "Enter a provider token.";
  if (/[\0\r\n]/.test(value)) return "Provider tokens cannot contain line breaks or null characters.";
  if (new TextEncoder().encode(value).byteLength > MAX_PROVIDER_CREDENTIAL_BYTES)
    return `Provider tokens cannot exceed ${MAX_PROVIDER_CREDENTIAL_BYTES} UTF-8 bytes.`;
  return null;
}
