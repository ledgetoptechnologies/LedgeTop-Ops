PRAGMA foreign_keys = ON;

-- Historical durable records deliberately remain NULL. An operator-reviewed
-- reconciliation is required after PA history-epoch rotation; no worker may
-- infer or backfill an epoch from a probe.
ALTER TABLE project_alpha_project_destinations ADD COLUMN expected_history_epoch_id TEXT NULL;
ALTER TABLE project_alpha_project_outbox ADD COLUMN expected_history_epoch_id TEXT NULL;
ALTER TABLE project_alpha_project_mappings ADD COLUMN history_epoch_id TEXT NULL;
ALTER TABLE project_alpha_project_refresh ADD COLUMN history_epoch_id TEXT NULL;

CREATE TRIGGER project_alpha_project_destination_epoch_immutable BEFORE UPDATE ON project_alpha_project_destinations
WHEN NEW.expected_history_epoch_id IS NOT OLD.expected_history_epoch_id
BEGIN SELECT RAISE(ABORT,'project destination history epoch is immutable'); END;
CREATE TRIGGER project_alpha_project_outbox_epoch_immutable BEFORE UPDATE ON project_alpha_project_outbox
WHEN NEW.expected_history_epoch_id IS NOT OLD.expected_history_epoch_id
BEGIN SELECT RAISE(ABORT,'project outbox history epoch is immutable'); END;
CREATE TRIGGER project_alpha_project_refresh_epoch_immutable BEFORE UPDATE ON project_alpha_project_refresh
WHEN NEW.history_epoch_id IS NOT OLD.history_epoch_id
BEGIN SELECT RAISE(ABORT,'project refresh history epoch is immutable'); END;

CREATE TRIGGER project_alpha_project_destination_epoch_valid BEFORE INSERT ON project_alpha_project_destinations
WHEN NEW.expected_history_epoch_id IS NULL OR length(NEW.expected_history_epoch_id)<>36
 OR substr(NEW.expected_history_epoch_id,9,1)<>'-' OR substr(NEW.expected_history_epoch_id,14,1)<>'-'
 OR substr(NEW.expected_history_epoch_id,15,1)<>'4' OR substr(NEW.expected_history_epoch_id,19,1)<>'-'
 OR substr(NEW.expected_history_epoch_id,20,1) NOT GLOB '[89ab]' OR substr(NEW.expected_history_epoch_id,24,1)<>'-'
 OR length(replace(NEW.expected_history_epoch_id,'-',''))<>32
 OR replace(NEW.expected_history_epoch_id,'-','') GLOB '*[^0-9a-f]*'
BEGIN SELECT RAISE(ABORT,'project destination history epoch is invalid'); END;
CREATE TRIGGER project_alpha_project_outbox_epoch_valid BEFORE INSERT ON project_alpha_project_outbox
WHEN NEW.expected_history_epoch_id IS NULL OR length(NEW.expected_history_epoch_id)<>36
 OR substr(NEW.expected_history_epoch_id,9,1)<>'-' OR substr(NEW.expected_history_epoch_id,14,1)<>'-'
 OR substr(NEW.expected_history_epoch_id,15,1)<>'4' OR substr(NEW.expected_history_epoch_id,19,1)<>'-'
 OR substr(NEW.expected_history_epoch_id,20,1) NOT GLOB '[89ab]' OR substr(NEW.expected_history_epoch_id,24,1)<>'-'
 OR length(replace(NEW.expected_history_epoch_id,'-',''))<>32
 OR replace(NEW.expected_history_epoch_id,'-','') GLOB '*[^0-9a-f]*'
 OR NOT EXISTS(SELECT 1 FROM project_alpha_project_destinations d WHERE d.external_project_id=NEW.external_project_id
   AND d.expected_history_epoch_id=NEW.expected_history_epoch_id)
BEGIN SELECT RAISE(ABORT,'project outbox history epoch is invalid'); END;
CREATE TRIGGER project_alpha_project_mapping_epoch_valid BEFORE INSERT ON project_alpha_project_mappings
WHEN NEW.history_epoch_id IS NULL OR length(NEW.history_epoch_id)<>36
 OR substr(NEW.history_epoch_id,9,1)<>'-' OR substr(NEW.history_epoch_id,14,1)<>'-'
 OR substr(NEW.history_epoch_id,15,1)<>'4' OR substr(NEW.history_epoch_id,19,1)<>'-'
 OR substr(NEW.history_epoch_id,20,1) NOT GLOB '[89ab]' OR substr(NEW.history_epoch_id,24,1)<>'-'
 OR length(replace(NEW.history_epoch_id,'-',''))<>32
 OR replace(NEW.history_epoch_id,'-','') GLOB '*[^0-9a-f]*'
 OR NOT EXISTS(SELECT 1 FROM project_alpha_project_outbox o WHERE o.command_id=NEW.establishment_command_id
   AND o.expected_history_epoch_id=NEW.history_epoch_id AND o.state='leased')
BEGIN SELECT RAISE(ABORT,'project mapping history epoch is invalid'); END;
CREATE TRIGGER project_alpha_project_refresh_epoch_valid BEFORE INSERT ON project_alpha_project_refresh
WHEN NEW.history_epoch_id IS NULL OR length(NEW.history_epoch_id)<>36
 OR substr(NEW.history_epoch_id,9,1)<>'-' OR substr(NEW.history_epoch_id,14,1)<>'-'
 OR substr(NEW.history_epoch_id,15,1)<>'4' OR substr(NEW.history_epoch_id,19,1)<>'-'
 OR substr(NEW.history_epoch_id,20,1) NOT GLOB '[89ab]' OR substr(NEW.history_epoch_id,24,1)<>'-'
 OR length(replace(NEW.history_epoch_id,'-',''))<>32
 OR replace(NEW.history_epoch_id,'-','') GLOB '*[^0-9a-f]*'
 OR NOT EXISTS(SELECT 1 FROM project_alpha_project_mappings m JOIN project_alpha_project_outbox o
   ON o.command_id=m.establishment_command_id WHERE m.external_project_id=NEW.external_project_id
   AND m.establishment_command_id=NEW.establishment_command_id AND m.history_epoch_id=NEW.history_epoch_id
   AND o.expected_history_epoch_id=NEW.history_epoch_id)
BEGIN SELECT RAISE(ABORT,'project refresh history epoch is invalid'); END;
