# Import existing PA Directory records

This owner workflow connects existing PA organizations and clients to native Ops editing. It never creates a replacement PA customer. Existing classic IDs, PA public IDs, portal workspaces and shared links keep their identities.

Apply migration0206 before enabling `NATIVE_DIRECTORY_EXISTING_IMPORT_ENABLED=true`. `NATIVE_DIRECTORY_EXISTING_IMPORT_AREAS` is a deployment-owned JSON object mapping each enabled PA source ID to a reviewed, active native business-area ID. Both settings default to disabled; the UI stays hidden until the schema and configuration are ready.

In **Project Alpha Connections**, refresh the existing-record import list, review the selected records, then import the reviewed records. Organizations run first so each child client can retain its exact same-source parent. The server checks current native owner permissions, explicit denies, source identity, inventory evidence, PA profile/revision and binding state before writing. Each native ID is `pa-import:<source>:<kind>:<classic ID>`; immutable translations preserve old classic URLs and business history.

Each PA binding command is stored before sending. A timeout pauses the batch. **Resume reviewed import** checks saved state and reconciles the same command; reloading the page does not send commands automatically. Completed imports require the exact current active native mapping. This workflow sends no invitations and creates no client portal grants, financial transactions or PA create commands.

Expired reviews can be renewed explicitly using current native staff authorization. Renewal preserves the import ID, identity, profile and original binding command. Changed permissions, source identity, parent, profile/revision or unexpected authorization generation block recovery. A genuine PA change after local import requires owner reconciliation; the workflow does not silently replace the frozen command, delete its audit history or create a second native identity.

Before the first production import, retain a tested fallback Worker containing the same translation support with import admissions disabled. After importing, disable the import flag when further admissions are unnecessary. Keep translation support deployed: reverting to older code that does not understand qualified native IDs would lose authenticated classic-history and old-URL bridging. Imported records and their immutable receipts are preserved; rollback does not delete them.

The current rollout reviews a separately validated manifest of60 existing records. Candidate listing filters source authority, resource denies and prior imports; full record eligibility is enforced during server review. A follow-up for mixed legacy datasets is to apply the shared classic eligibility query before candidate pagination, so malformed or otherwise ineligible records do not prevent the strict browser list from loading.

Records already linked to a business-party grouping are blocked during review and local admission. Those existing links require explicit identity reconciliation before import; this workflow does not rewrite or discard business-party membership. The reviewed60-record rollout contains no business-party links.
