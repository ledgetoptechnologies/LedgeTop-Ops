# Native staff Access group membership

Ops Sync reconciles the native staff Access group from current Operations D1
identity state. Before the staff-login-bindings migration is installed, the
consumer retains the existing primary-login-only behavior. Once the complete
0226 schema is present, it adds an alternate login only when its binding is
active, its intent is claimed and points back to that binding, its intent
generation is older than the current staff generation, and its issuer exactly
matches the configured `TEAM_DOMAIN`. The canonical staff row must still be
active and match the intent's canonical email and subject; the native admission
must be active and bound to that subject; and the native profile must still
match the canonical email.

A missing 0226 schema is a rolling-deployment compatibility case. A partial or
invalid schema, malformed issuer, duplicate or invalid membership email, or
stale identity is held pending rather than guessed through. Pending intents,
revoked bindings, aliases from another Access tenant, email-only matches, and
links whose canonical identity or native admission has changed do not add a
group member. Primary and accepted alternate login emails are reconciled as a
single sorted set; this consumer does not create staff, admissions, or login
bindings.

Any staged cutover or synchronization-preparation evidence must use the same
active binding predicate and must not claim alternate-login support until this
consumer revision is included in the reviewed candidate.
