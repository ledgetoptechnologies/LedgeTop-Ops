# Authenticated client model viewing

Clients open the full Viewer on its configured origin using their existing scoped
one-time session grant. The portal owns issuance and renewal; it stays open as
the controller when launching a separate Viewer tab. The existing exact-window,
allowed-origin renewal protocol and model/identity checks apply unchanged.

After redemption, client sessions include `clientPortalOrigin`, sourced only from
the Viewer server's `CLIENT_PORTAL_BASE_URL`. Only the exact production public
Viewer origin `https://viewer.ledgetopdroneservices.com` defaults to the canonical
`https://portal.ledgetop.app`. Staging or alternate deployments must set their own
portal origin or omit the link. Explicit empty configuration disables the link.
The return link always targets `/portal`; request parameters and
referrers cannot supply a destination. Staff sessions omit this metadata and
retain their existing Operations navigation. Public viewing has no client return
navigation.

This Viewer patch supplies return navigation and client-specific expiry text.
The coordinated Client Portal patch must replace its embedded model presentation
with the existing top-level launch controller. A same-tab fallback cannot preserve
an opener for silent renewal; it must explain reopening when the session expires.

Browser acceptance must cover full-page launch, one-time grant removal from the
URL, reload, renewal, portal return, expired/revoked access, absence of staff
controls, and unchanged public-link behavior. Full-page presentation alone does
not establish that browser local-network permission prompts are eliminated.
