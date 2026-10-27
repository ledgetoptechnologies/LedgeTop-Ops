/** Separate reviewed trust pin for encrypted private release response artifacts.
 * The all-zero sentinel intentionally prevents production use until an
 * operator-approved public recipient is installed in a reviewed change. */
export const PRODUCTION_AUTO_JOURNAL_RECIPIENT = Object.freeze({
  schemaVersion: 1,
  keyIdSha256: '0000000000000000000000000000000000000000000000000000000000000000',
  publicKeyPem: '',
});
