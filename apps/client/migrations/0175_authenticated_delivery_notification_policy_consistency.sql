PRAGMA foreign_keys=ON;

-- A master opt-in without a subscribed change kind is contradictory. Keep the
-- original 0170 table history intact and enforce the stronger invariant for
-- every new or updated row.
CREATE TRIGGER portal_authenticated_delivery_notification_policy_mode_insert_guard
BEFORE INSERT ON portal_authenticated_delivery_notification_policies
WHEN NEW.access_notice_enabled=1 AND NEW.change_mode='off'
BEGIN SELECT RAISE(ABORT,'authenticated delivery notification policy mode is contradictory'); END;

CREATE TRIGGER portal_authenticated_delivery_notification_policy_mode_update_guard
BEFORE UPDATE ON portal_authenticated_delivery_notification_policies
WHEN NEW.access_notice_enabled=1 AND NEW.change_mode='off'
BEGIN SELECT RAISE(ABORT,'authenticated delivery notification policy mode is contradictory'); END;
