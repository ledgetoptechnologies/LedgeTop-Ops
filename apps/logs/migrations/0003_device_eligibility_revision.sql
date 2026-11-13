-- Controller access is bound to the Ops eligibility revision it was issued under (Ops StaffDirectory
-- getPilotDeviceAuthority). Every Ops grant or deny creates a new revision, so a sign-in request or device
-- token issued under an older revision stops working and is never revived by a later grant.
-- Additive only. Rows created before this migration have no revision and fail closed until signed in again.
ALTER TABLE device_sign_ins ADD COLUMN eligibility_revision INTEGER;
ALTER TABLE devices ADD COLUMN eligibility_revision INTEGER;
