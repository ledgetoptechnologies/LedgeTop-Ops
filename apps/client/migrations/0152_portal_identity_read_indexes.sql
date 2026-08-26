-- Read-only support for the Operations portal-login directory and lazy history.
-- Preserve all identity, invitation, membership and access records unchanged.
-- Normalized-email expressions match the reader and existing mutation semantics.
CREATE INDEX IF NOT EXISTS idx_portal_invitations_email_history
  ON portal_v2_invitations(workspace_id,lower(trim(invited_email)),created_at DESC,id DESC);

CREATE INDEX IF NOT EXISTS idx_portal_entitlements_identity_history
  ON portal_v2_entitlements(workspace_id,identity_id,created_at DESC,id DESC);

CREATE INDEX IF NOT EXISTS idx_portal_eligibility_email_history
  ON portal_v2_identity_eligibility_blocks(match_type,lower(trim(normalized_email)),created_at DESC,id DESC);

CREATE INDEX IF NOT EXISTS idx_portal_eligibility_subject_history
  ON portal_v2_identity_eligibility_blocks(match_type,issuer,subject,created_at DESC,id DESC);
