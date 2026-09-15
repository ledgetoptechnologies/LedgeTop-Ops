-- A scheduler progress hint, not a permission grant or dispatch lease.
CREATE TABLE operations_directory_delivery_checkpoint (
  singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1),
  revision INTEGER NOT NULL CHECK (revision >= 0),
  checkpoint_json TEXT NOT NULL CHECK (
    length(checkpoint_json) BETWEEN 1 AND 1024 AND json_valid(checkpoint_json)
  )
);

INSERT INTO operations_directory_delivery_checkpoint (singleton_id,revision,checkpoint_json)
VALUES (1,0,'{"version":1,"reconcileCursor":null,"prepareCursor":null,"destinationOffset":0}');

CREATE TRIGGER operations_directory_delivery_checkpoint_no_insert
BEFORE INSERT ON operations_directory_delivery_checkpoint
BEGIN SELECT RAISE(ABORT,'directory delivery checkpoint singleton is immutable'); END;

CREATE TRIGGER operations_directory_delivery_checkpoint_no_delete
BEFORE DELETE ON operations_directory_delivery_checkpoint
BEGIN SELECT RAISE(ABORT,'directory delivery checkpoint cannot be deleted'); END;

CREATE TRIGGER operations_directory_delivery_checkpoint_guard_update
BEFORE UPDATE ON operations_directory_delivery_checkpoint
WHEN NEW.singleton_id IS NOT OLD.singleton_id OR NEW.revision IS NOT OLD.revision + 1
BEGIN SELECT RAISE(ABORT,'directory delivery checkpoint revision is invalid'); END;
