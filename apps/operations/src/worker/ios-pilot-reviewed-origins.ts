/** Source-reviewed resource origins shared by the edge and private reader.
 * Environment variables cannot extend this list. A cross-account migration
 * requires review of the provider, app pins and both backend boundaries first.
 * Retain the working legacy origin until its replacement is explicitly reviewed.
 */
export const IOS_PILOT_REVIEWED_ORIGINS: readonly string[] = Object.freeze([
  'https://ios-pilot-staging.ledgetop.app',
  'https://ledge-top-ios-edge-staging.ledge-top-staging.workers.dev',
]);
