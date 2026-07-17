const ACCESS_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";

export function generateSecureAccessCode(length = 16): string {
  if (!Number.isInteger(length) || length < 8) throw new Error("Access code length must be at least eight characters");

  const code: string[] = [];
  const unbiasedLimit = Math.floor(256 / ACCESS_CODE_ALPHABET.length) * ACCESS_CODE_ALPHABET.length;
  while (code.length < length) {
    const bytes = crypto.getRandomValues(new Uint8Array(length - code.length));
    for (const value of bytes) {
      if (value >= unbiasedLimit) continue;
      code.push(ACCESS_CODE_ALPHABET[value % ACCESS_CODE_ALPHABET.length]!);
      if (code.length === length) break;
    }
  }
  return code.join("");
}
