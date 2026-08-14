PRAGMA foreign_keys = ON;

-- Direct, LTDS-local quick links for Project Alpha-projected work. Project and
-- task link sets are intentionally separate: links never inherit between a
-- project, task, or operational job brief.
CREATE TABLE work_context_sop_link_sets (
  context_kind TEXT NOT NULL CHECK (context_kind IN ('project','task')),
  context_id TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version > 0),
  mutation_id TEXT NOT NULL,
  updated_by TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (context_kind,context_id),
  FOREIGN KEY (updated_by) REFERENCES staff_users(id)
);

CREATE TABLE work_context_sop_links (
  context_kind TEXT NOT NULL CHECK (context_kind IN ('project','task')),
  context_id TEXT NOT NULL,
  sop_id TEXT NOT NULL,
  revision_id TEXT NOT NULL,
  linked_by TEXT NOT NULL,
  linked_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (context_kind,context_id,revision_id),
  UNIQUE (context_kind,context_id,sop_id),
  FOREIGN KEY (context_kind,context_id)
    REFERENCES work_context_sop_link_sets(context_kind,context_id)
    ON DELETE CASCADE,
  FOREIGN KEY (sop_id) REFERENCES sop_documents(id),
  FOREIGN KEY (revision_id) REFERENCES sop_revisions(id),
  FOREIGN KEY (linked_by) REFERENCES staff_users(id)
);

CREATE INDEX idx_work_context_sop_links_context
ON work_context_sop_links(context_kind,context_id,linked_at,revision_id);

-- Ephemeral authorization tickets used only inside the atomic replacement
-- batch. A ticket is created from current ACL and Project Alpha visibility,
-- consumed by the CAS and downstream writes, then removed before commit.
CREATE TABLE work_context_sop_mutation_guards (
  mutation_id TEXT PRIMARY KEY,
  context_kind TEXT NOT NULL CHECK (context_kind IN ('project','task')),
  context_id TEXT NOT NULL,
  staff_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (staff_id) REFERENCES staff_users(id)
);

CREATE TRIGGER work_context_sop_link_set_requires_active_context_insert
BEFORE INSERT ON work_context_sop_link_sets
BEGIN
  SELECT RAISE(ABORT, 'project work context is not active')
  WHERE NEW.context_kind='project' AND NOT EXISTS (
    SELECT 1 FROM pa_projects p WHERE p.id=NEW.context_id AND p.active=1
  );
  SELECT RAISE(ABORT, 'task work context is not active')
  WHERE NEW.context_kind='task' AND NOT EXISTS (
    SELECT 1 FROM pa_tasks t WHERE t.id=NEW.context_id AND t.active=1
  );
END;

CREATE TRIGGER work_context_sop_link_set_requires_active_context_update
BEFORE UPDATE ON work_context_sop_link_sets
BEGIN
  SELECT RAISE(ABORT, 'work-context identity is immutable')
  WHERE NEW.context_kind<>OLD.context_kind OR NEW.context_id<>OLD.context_id;
  SELECT RAISE(ABORT, 'project work context is not active')
  WHERE NEW.context_kind='project' AND NOT EXISTS (
    SELECT 1 FROM pa_projects p WHERE p.id=NEW.context_id AND p.active=1
  );
  SELECT RAISE(ABORT, 'task work context is not active')
  WHERE NEW.context_kind='task' AND NOT EXISTS (
    SELECT 1 FROM pa_tasks t WHERE t.id=NEW.context_id AND t.active=1
  );
END;

CREATE TRIGGER work_context_sop_links_no_update
BEFORE UPDATE ON work_context_sop_links
BEGIN
  SELECT RAISE(ABORT, 'work-context SOP links are immutable; replace the link set');
END;

CREATE TRIGGER work_context_sop_link_requires_active_context
BEFORE INSERT ON work_context_sop_links
BEGIN
  SELECT RAISE(ABORT, 'project work context is not active')
  WHERE NEW.context_kind='project' AND NOT EXISTS (
    SELECT 1 FROM pa_projects p WHERE p.id=NEW.context_id AND p.active=1
  );
  SELECT RAISE(ABORT, 'task work context is not active')
  WHERE NEW.context_kind='task' AND NOT EXISTS (
    SELECT 1 FROM pa_tasks t WHERE t.id=NEW.context_id AND t.active=1
  );
END;

CREATE TRIGGER work_context_sop_link_requires_current_published_revision
BEFORE INSERT ON work_context_sop_links
BEGIN
  SELECT RAISE(ABORT, 'work contexts may pin only the current published SOP revision')
  WHERE NOT EXISTS (
    SELECT 1 FROM sop_documents d
    WHERE d.id=NEW.sop_id
      AND d.status='published'
      AND d.published_revision_id=NEW.revision_id
  );
  SELECT RAISE(ABORT, 'SOP revision does not belong to the document')
  WHERE NOT EXISTS (
    SELECT 1 FROM sop_revisions r
    WHERE r.id=NEW.revision_id AND r.sop_id=NEW.sop_id
  );
END;
