# Legacy staff management from the Team page

Pre-cutover only (the native staff readiness control is absent or disabled).
Administrators holding global `roles.manage` can add a staff member, change a
name, and deactivate or reactivate legacy staff on the Team page. Owners, the
acting administrator, sync-protected rows and rows that belong to native
employee management cannot be changed there. Email and role changes are not
available.

Nothing in Operations changes the Cloudflare Access group or policy for the
Operations app before cutover. The operator keeps it in step by hand.

## After adding someone

1. Add the new person in Team (name and email). They start with no access.
2. In the Cloudflare Zero Trust dashboard, add the same email to the Operations
   Access group or policy used by the Operations app.
3. Grant the narrow access they need with the access controls on their Team card.
4. The first sign-in with that email binds the person's Access identity. Check
   the email carefully before step 2: whoever first signs in with it is bound.

## After deactivating someone

1. Deactivate them in Team. Their next Operations request is refused.
2. In the Cloudflare Zero Trust dashboard, remove their email from the
   Operations Access group or policy. Leave shared groups, apps and service
   tokens used by other apps unchanged.
3. For a departure, also complete the private change record described in
   [manual-staff-offboarding.md](manual-staff-offboarding.md).

Reactivating restores Operations sign-in only after the email is back in the
Access group or policy.
