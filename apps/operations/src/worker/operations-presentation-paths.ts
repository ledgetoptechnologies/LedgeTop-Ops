/** Finite SPA surfaces only. API, legacy assets, Incoming and staging-owner
 * namespaces are never inferred to be presentation routes from Accept alone.
 * Import-free: the browser fixture server reads this exact rule too. */
export function operationsUiPresentationPath(pathname: string): boolean {
  if (pathname === "/") return true;
  if (["/dashboard", "/notifications", "/airspace", "/team", "/administration", "/configurations", "/intel", "/account", "/fleet",
    "/administration/client-onboarding", "/administration/client-portal/recipients"].includes(pathname)) return true;
  return ["/operations", "/clients", "/viewer", "/delivery", "/jobs", "/projects", "/tasks", "/sops"]
    .some(base => pathname === base || pathname.startsWith(`${base}/`));
}
