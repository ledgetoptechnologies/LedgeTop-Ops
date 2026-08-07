PRAGMA foreign_keys = ON;

INSERT OR IGNORE INTO permissions(key,description) VALUES
  ('sops.view','View published internal standard operating procedures'),
  ('sops.manage','Create, revise, publish, and archive internal standard operating procedures');

INSERT OR IGNORE INTO role_permissions(role_id,permission_key)
SELECT id,'sops.view' FROM roles
WHERE id IN ('role-owner','role-admin','role-division-manager','role-operator','role-delivery-coordinator');

INSERT OR IGNORE INTO role_permissions(role_id,permission_key)
SELECT id,'sops.manage' FROM roles WHERE id IN ('role-owner','role-admin');

CREATE TABLE sop_documents (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE COLLATE NOCASE,
  status TEXT NOT NULL CHECK (status IN ('draft','published','archived')),
  version INTEGER NOT NULL CHECK (version > 0),
  draft_revision_id TEXT,
  published_revision_id TEXT,
  acknowledgement_policy_json TEXT
    CHECK (acknowledgement_policy_json IS NULL OR json_valid(acknowledgement_policy_json)),
  created_by TEXT NOT NULL,
  updated_by TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  published_at TEXT,
  archived_at TEXT,
  FOREIGN KEY (created_by) REFERENCES staff_users(id),
  FOREIGN KEY (updated_by) REFERENCES staff_users(id),
  FOREIGN KEY (draft_revision_id) REFERENCES sop_revisions(id),
  FOREIGN KEY (published_revision_id) REFERENCES sop_revisions(id)
);

CREATE TABLE sop_revisions (
  id TEXT PRIMARY KEY,
  sop_id TEXT NOT NULL,
  revision_number INTEGER NOT NULL CHECK (revision_number > 0),
  parent_revision_id TEXT,
  change_kind TEXT NOT NULL CHECK (change_kind IN ('created','draft_saved','published','archived','restored')),
  title TEXT NOT NULL,
  purpose TEXT NOT NULL,
  markdown_body TEXT NOT NULL,
  rendered_html TEXT NOT NULL,
  toc_json TEXT NOT NULL CHECK (json_valid(toc_json)),
  sanitizer_version INTEGER NOT NULL CHECK (sanitizer_version > 0),
  author_id TEXT NOT NULL,
  author_email TEXT NOT NULL,
  author_display_name TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  published_at TEXT,
  UNIQUE (sop_id,revision_number),
  FOREIGN KEY (sop_id) REFERENCES sop_documents(id),
  FOREIGN KEY (parent_revision_id) REFERENCES sop_revisions(id),
  FOREIGN KEY (author_id) REFERENCES staff_users(id)
);

CREATE INDEX idx_sop_documents_status_updated
ON sop_documents(status,updated_at DESC,id);

CREATE INDEX idx_sop_revisions_document
ON sop_revisions(sop_id,revision_number DESC);

CREATE TABLE operational_job_brief_sop_links (
  operation_id TEXT NOT NULL,
  sop_id TEXT NOT NULL,
  revision_id TEXT NOT NULL,
  linked_by TEXT NOT NULL,
  linked_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (operation_id,revision_id),
  FOREIGN KEY (operation_id) REFERENCES operational_job_briefs(operation_id),
  FOREIGN KEY (sop_id) REFERENCES sop_documents(id),
  FOREIGN KEY (revision_id) REFERENCES sop_revisions(id),
  FOREIGN KEY (linked_by) REFERENCES staff_users(id),
  UNIQUE (operation_id,sop_id)
);

CREATE INDEX idx_job_brief_sop_links_operation
ON operational_job_brief_sop_links(operation_id,linked_at,revision_id);

CREATE TRIGGER sop_documents_slug_immutable
BEFORE UPDATE OF slug ON sop_documents
BEGIN
  SELECT RAISE(ABORT, 'SOP slugs are immutable');
END;

CREATE TRIGGER sop_documents_no_delete
BEFORE DELETE ON sop_documents
BEGIN
  SELECT RAISE(ABORT, 'SOP documents must be archived, not deleted');
END;

CREATE TRIGGER sop_documents_revision_pointers_belong_to_document
BEFORE UPDATE OF draft_revision_id,published_revision_id,status ON sop_documents
BEGIN
  SELECT RAISE(ABORT, 'draft revision does not belong to SOP document')
  WHERE NEW.draft_revision_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM sop_revisions r WHERE r.id=NEW.draft_revision_id AND r.sop_id=NEW.id
  );
  SELECT RAISE(ABORT, 'published revision does not belong to SOP document')
  WHERE NEW.published_revision_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM sop_revisions r WHERE r.id=NEW.published_revision_id AND r.sop_id=NEW.id
  );
  SELECT RAISE(ABORT, 'draft SOP requires a draft revision')
  WHERE NEW.status='draft' AND NEW.draft_revision_id IS NULL;
  SELECT RAISE(ABORT, 'published SOP requires a published revision')
  WHERE NEW.status='published' AND NEW.published_revision_id IS NULL;
END;

CREATE TRIGGER sop_revisions_no_update
BEFORE UPDATE ON sop_revisions
BEGIN
  SELECT RAISE(ABORT, 'SOP revisions are immutable');
END;

CREATE TRIGGER sop_revisions_no_delete
BEFORE DELETE ON sop_revisions
BEGIN
  SELECT RAISE(ABORT, 'SOP revisions are immutable');
END;

CREATE TRIGGER job_brief_sop_link_must_be_current_published_revision
BEFORE INSERT ON operational_job_brief_sop_links
BEGIN
  SELECT RAISE(ABORT, 'job briefs may link only the current published SOP revision')
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
