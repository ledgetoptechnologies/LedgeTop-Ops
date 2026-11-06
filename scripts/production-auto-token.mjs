/** GitHub App installation tokens are opaque HTTP header values. In
 * particular, current stateless tokens can contain dots and are much longer
 * than the historical base64url-looking form. Accept only bounded visible
 * ASCII, without parsing token structure or allowing header whitespace. */
export function isGitHubHeaderCredential(value) {
  return typeof value === 'string' && /^[\x21-\x7e]{20,16384}$/u.test(value);
}
