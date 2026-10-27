# Viewer staff navigation

Top-level Operations model sessions show Dashboard › Models above the model title,
instead of a separate pair of pill buttons alongside the data-mode controls. The
logo links to Dashboard. On phones, the path becomes ‹ Models. The existing
branding, project selector, model viewport and desktop header height are retained.
The complete model title remains accessible and is also available as a tooltip.

All destinations still come from the validated, server-owned `operationsOrigin`.
Only top-level `session` views with the `ops` audience receive these links.
Public shares, embedded sessions and Client Portal frames acquire no Operations
navigation; plain branding is restored when a session becomes ineligible.

An ordinary same-tab click on Dashboard, Models or the logo asks “Leave this
model? Your unfinished measurement will be lost.” when there is a draft/edit,
an expiry-recovery checkpoint, or a pending/failed measurement save. Stay and
Escape leave that work untouched; Leave follows the selected destination only
if it is still eligible. Keyboard input inside the dialog belongs to the dialog,
so Enter on Stay cannot save a drawing and Escape cannot discard it. Repeated
clicks do not create duplicate dialogs. Successful saves remove the prompt when
there is no other unfinished work.

Modified clicks and new-tab actions retain native browser behavior. This is an
application-link guard, not protection against browser Back, reload, or closing
the tab. It does not change measurement persistence, save/cancel semantics,
session issuance, permissions or public-link sharing.

Validation includes the existing origin/audience gates, a deferred real-store
save regression, and an isolated browser fixture using the shipped header/CSS,
navigation module and actual measurement workspace. The fixture uses synthetic
geometry and local module routes; it does not exercise production authentication,
the complete renderer or the authenticated Client iframe. Layout checks cover
375, 768, 1024 and 1280 pixels with staff-session, admin and public variants.
