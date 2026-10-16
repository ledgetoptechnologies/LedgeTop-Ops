PRAGMA foreign_keys=ON;
-- Shared business fields overlay existing identities. Membership never changes
-- PA mappings, enrollment destinations, parent relations, or portal access.
CREATE TABLE native_directory_shared_profiles(
 id TEXT PRIMARY KEY CHECK(length(id)=36),kind TEXT NOT NULL CHECK(kind IN('organization','client')),
 version INTEGER NOT NULL DEFAULT 1 CHECK(version>=1),profile_json TEXT NOT NULL CHECK(json_valid(profile_json)),
 membership_json TEXT NOT NULL CHECK(json_valid(membership_json) AND json_array_length(membership_json) BETWEEN 1 AND 2),
 created_by TEXT NOT NULL REFERENCES staff_users(id),created_at TEXT NOT NULL DEFAULT(datetime('now'))
);
CREATE TABLE native_directory_shared_profile_members(
 record_id TEXT PRIMARY KEY REFERENCES operations_directory_records(record_id),
 group_id TEXT NOT NULL REFERENCES native_directory_shared_profiles(id),
 initial_version INTEGER NOT NULL CHECK(initial_version>=1),
 initial_parent_record_id TEXT REFERENCES operations_directory_records(record_id),
 initial_relationship_version INTEGER CHECK(initial_relationship_version IS NULL OR initial_relationship_version>=1)
);
CREATE INDEX native_directory_shared_profile_members_group ON native_directory_shared_profile_members(group_id);
CREATE TABLE native_directory_shared_profile_previews(
 token TEXT PRIMARY KEY CHECK(length(token)=36),actor_id TEXT NOT NULL REFERENCES staff_users(id),
 proof_json TEXT NOT NULL CHECK(json_valid(proof_json)),expires_at TEXT NOT NULL,
 confirmed_mutation_id TEXT UNIQUE,group_id TEXT REFERENCES native_directory_shared_profiles(id)
);
CREATE TABLE native_directory_shared_profile_commands(
 mutation_id TEXT PRIMARY KEY CHECK(length(mutation_id)=36),group_id TEXT NOT NULL REFERENCES native_directory_shared_profiles(id),
 expected_version INTEGER NOT NULL CHECK(expected_version>=1),request_sha256 TEXT NOT NULL CHECK(length(request_sha256)=64),
 profile_json TEXT NOT NULL CHECK(json_valid(profile_json)),members_json TEXT NOT NULL CHECK(json_valid(members_json) AND json_array_length(members_json) BETWEEN 1 AND 2),
 actor_kind TEXT NOT NULL DEFAULT 'staff' CHECK(actor_kind IN('staff','portal')),
 identity_safe_contact_profile INTEGER NOT NULL DEFAULT 0 CHECK(identity_safe_contact_profile IN(0,1)),
 actor_id TEXT NOT NULL,created_at TEXT NOT NULL DEFAULT(datetime('now')),
 UNIQUE(group_id,expected_version)
);
CREATE TABLE native_directory_shared_profile_revisions(
 group_id TEXT NOT NULL REFERENCES native_directory_shared_profiles(id),version INTEGER NOT NULL CHECK(version>=1),
 mutation_id TEXT UNIQUE REFERENCES native_directory_shared_profile_commands(mutation_id),
 profile_json TEXT NOT NULL CHECK(json_valid(profile_json)),PRIMARY KEY(group_id,version)
);
-- A creation fence captures the authenticated owner and exact reviewed records.
-- It is inserted in the same atomic batch as the group; no reusable raw grant.
CREATE TABLE native_directory_shared_profile_creation_fences(
 group_id TEXT PRIMARY KEY CHECK(length(group_id)=36),mutation_id TEXT NOT NULL UNIQUE CHECK(length(mutation_id)=36),
 mode TEXT NOT NULL CHECK(mode IN('pair','single')),request_sha256 TEXT NOT NULL CHECK(length(request_sha256)=64),
 actor_id TEXT NOT NULL REFERENCES staff_users(id),access_subject TEXT NOT NULL,admission_version INTEGER NOT NULL,
 profile_version INTEGER NOT NULL,login_email TEXT NOT NULL,
 kind TEXT NOT NULL CHECK(kind IN('organization','client')),profile_json TEXT NOT NULL CHECK(json_valid(profile_json)),
 membership_json TEXT NOT NULL CHECK(json_valid(membership_json)),members_json TEXT NOT NULL CHECK(json_valid(members_json)),
 preview_token TEXT REFERENCES native_directory_shared_profile_previews(token),created_at TEXT NOT NULL DEFAULT(datetime('now')),
 CHECK(json_array_length(membership_json)=CASE mode WHEN 'pair' THEN 2 ELSE 1 END),
 CHECK(json_array_length(members_json)=json_array_length(membership_json)),
 CHECK((mode='pair' AND preview_token IS NOT NULL) OR (mode='single' AND preview_token IS NULL))
);
CREATE TRIGGER native_directory_shared_creation_actor BEFORE INSERT ON native_directory_shared_profile_creation_fences
WHEN NOT EXISTS(SELECT 1 FROM staff_users actor JOIN native_staff_admissions admission ON admission.staff_id=actor.id
 JOIN native_staff_profiles profile ON profile.staff_id=actor.id
 WHERE actor.id=NEW.actor_id AND actor.status='active' AND admission.active=1
 AND actor.access_subject=NEW.access_subject AND admission.bound_access_subject=NEW.access_subject
 AND admission.version=NEW.admission_version AND profile.version=NEW.profile_version AND profile.login_email=NEW.login_email
 AND EXISTS(SELECT 1 FROM native_directory_grants g WHERE g.staff_id=actor.id AND g.permission='directory.profile.edit' AND g.effect='allow' AND g.scope_kind='global' AND g.active=1)
 AND EXISTS(SELECT 1 FROM native_directory_grants g WHERE g.staff_id=actor.id AND g.permission='directory.identity.link' AND g.effect='allow' AND g.scope_kind='global' AND g.active=1)
 AND NOT EXISTS(SELECT 1 FROM native_directory_grants g WHERE g.staff_id=actor.id AND g.permission IN('directory.profile.edit','directory.identity.link') AND g.effect='deny' AND g.active=1))
BEGIN SELECT RAISE(ABORT,'shared_creation_actor_changed'); END;
CREATE TRIGGER native_directory_shared_creation_members BEFORE INSERT ON native_directory_shared_profile_creation_fences
WHEN json_type(NEW.profile_json)<>'object' OR (SELECT count(*) FROM json_each(NEW.profile_json))<>9
 OR EXISTS(SELECT 1 FROM json_each(NEW.profile_json) field WHERE field.type<>'text'
 OR field.key NOT IN('name','addressLine1','addressLine2','city','state','postalCode','country',
 CASE NEW.kind WHEN 'organization' THEN 'generalEmail' ELSE 'email' END,
 CASE NEW.kind WHEN 'organization' THEN 'generalPhone' ELSE 'phone' END))
 OR EXISTS(SELECT 1 FROM json_each(NEW.members_json) m
 LEFT JOIN operations_directory_records r ON r.record_id=json_extract(m.value,'$.recordId')
 LEFT JOIN operations_directory_revisions revision ON revision.record_id=r.record_id AND revision.version=r.current_version
 WHERE r.record_id IS NULL OR r.record_kind<>NEW.kind OR r.current_version<>json_extract(m.value,'$.version')
 OR r.record_kind<>json_extract(m.value,'$.kind')
 OR json_extract(m.value,'$.profile')<>json(NEW.profile_json)
 OR NOT EXISTS(SELECT 1 FROM json_each(NEW.membership_json) id WHERE id.value=r.record_id)
 OR EXISTS(SELECT 1 FROM native_directory_shared_profile_members existing WHERE existing.record_id=r.record_id)
 OR EXISTS(SELECT 1 FROM json_each(NEW.profile_json) field WHERE coalesce(json_extract(revision.profile_json,'$.'||field.key),'')<>field.value)
 OR (NEW.kind='client' AND NOT EXISTS(SELECT 1 FROM operations_directory_client_organizations relation
 LEFT JOIN operations_directory_records parent ON parent.record_id=relation.organization_record_id
 WHERE relation.client_record_id=r.record_id AND relation.relationship_version=json_extract(m.value,'$.relationshipVersion')
 AND relation.organization_record_id IS json_extract(m.value,'$.parentRecordId')
 AND parent.current_version IS json_extract(m.value,'$.parentVersion'))))
 OR (SELECT count(DISTINCT json_extract(value,'$.recordId')) FROM json_each(NEW.members_json))<>json_array_length(NEW.membership_json)
BEGIN SELECT RAISE(ABORT,'shared_creation_member_changed'); END;
CREATE TRIGGER native_directory_shared_creation_sources BEFORE INSERT ON native_directory_shared_profile_creation_fences
WHEN EXISTS(SELECT 1 FROM json_each(NEW.members_json) m
 LEFT JOIN effective_native_directory_enrollments e ON e.record_id=json_extract(m.value,'$.recordId')
 WHERE e.record_id IS NULL OR json_array_length(e.destinations_json)<>json_array_length(json_extract(m.value,'$.sourceIds'))
 OR EXISTS(SELECT 1 FROM json_each(e.destinations_json) d WHERE NOT EXISTS(
 SELECT 1 FROM json_each(json_extract(m.value,'$.sourceIds')) s WHERE s.value=json_extract(d.value,'$.sourceId'))))
BEGIN SELECT RAISE(ABORT,'shared_creation_source_changed'); END;
CREATE TRIGGER native_directory_shared_creation_preview BEFORE INSERT ON native_directory_shared_profile_creation_fences
WHEN NEW.mode='pair' AND NOT EXISTS(SELECT 1 FROM native_directory_shared_profile_previews p
 WHERE p.token=NEW.preview_token AND p.actor_id=NEW.actor_id AND p.confirmed_mutation_id IS NULL
 AND julianday(p.expires_at)>julianday('now') AND json_array_length(p.proof_json,'$.differences')=0
 AND json_extract(p.proof_json,'$.actor.staffId')=NEW.actor_id
 AND json_extract(p.proof_json,'$.actor.accessSubject')=NEW.access_subject
 AND json_extract(p.proof_json,'$.actor.admissionVersion')=NEW.admission_version
 AND json_extract(p.proof_json,'$.actor.profileVersion')=NEW.profile_version
 AND json_extract(p.proof_json,'$.actor.loginEmail')=NEW.login_email
 AND json_extract(p.proof_json,'$.kind')=NEW.kind AND json_extract(p.proof_json,'$.members')=json(NEW.members_json)
 AND json_extract(p.proof_json,'$.profile')=json(NEW.profile_json))
BEGIN SELECT RAISE(ABORT,'shared_creation_preview_changed'); END;
CREATE TRIGGER native_directory_shared_creation_immutable BEFORE UPDATE ON native_directory_shared_profile_creation_fences
BEGIN SELECT RAISE(ABORT,'shared_creation_immutable'); END;
CREATE TRIGGER native_directory_shared_creation_no_delete BEFORE DELETE ON native_directory_shared_profile_creation_fences
BEGIN SELECT RAISE(ABORT,'shared_creation_immutable'); END;
CREATE TRIGGER native_directory_shared_group_insert BEFORE INSERT ON native_directory_shared_profiles
WHEN NOT EXISTS(SELECT 1 FROM native_directory_shared_profile_creation_fences fence WHERE fence.group_id=NEW.id
 AND fence.actor_id=NEW.created_by AND fence.kind=NEW.kind AND fence.profile_json=NEW.profile_json AND fence.membership_json=NEW.membership_json)
 OR NOT EXISTS(SELECT 1 FROM staff_users actor JOIN native_staff_admissions admission ON admission.staff_id=actor.id
 WHERE actor.id=NEW.created_by AND actor.status='active' AND admission.active=1 AND actor.access_subject=admission.bound_access_subject
 AND EXISTS(SELECT 1 FROM native_directory_grants g WHERE g.staff_id=actor.id AND g.permission='directory.profile.edit' AND g.effect='allow' AND g.scope_kind='global' AND g.active=1)
 AND EXISTS(SELECT 1 FROM native_directory_grants g WHERE g.staff_id=actor.id AND g.permission='directory.identity.link' AND g.effect='allow' AND g.scope_kind='global' AND g.active=1)
 AND NOT EXISTS(SELECT 1 FROM native_directory_grants g WHERE g.staff_id=actor.id AND g.permission IN('directory.profile.edit','directory.identity.link') AND g.effect='deny' AND g.active=1))
 OR (json_array_length(NEW.membership_json)=2 AND json_extract(NEW.membership_json,'$[0]')>=json_extract(NEW.membership_json,'$[1]'))
 OR EXISTS(SELECT 1 FROM effective_native_directory_enrollments a JOIN effective_native_directory_enrollments b
 ON a.record_id=json_extract(NEW.membership_json,'$[0]') AND b.record_id=json_extract(NEW.membership_json,'$[1]')
 JOIN json_each(a.destinations_json) da JOIN json_each(b.destinations_json) db
 WHERE json_extract(da.value,'$.sourceId')=json_extract(db.value,'$.sourceId'))
BEGIN SELECT RAISE(ABORT,'shared_profile_group_authority'); END;
CREATE TRIGGER native_directory_shared_member_insert BEFORE INSERT ON native_directory_shared_profile_members
WHEN NOT EXISTS(SELECT 1 FROM native_directory_shared_profiles g JOIN operations_directory_records r ON r.record_id=NEW.record_id
 JOIN operations_directory_revisions revision ON revision.record_id=r.record_id AND revision.version=r.current_version
 WHERE g.id=NEW.group_id AND g.kind=r.record_kind AND r.current_version=NEW.initial_version
 AND NOT EXISTS(SELECT 1 FROM json_each(g.profile_json) field WHERE coalesce(json_extract(revision.profile_json,'$.'||field.key),'')<>field.value)
 AND ((g.kind='organization' AND NEW.initial_parent_record_id IS NULL AND NEW.initial_relationship_version IS NULL)
 OR (g.kind='client' AND EXISTS(SELECT 1 FROM operations_directory_client_organizations relation
 WHERE relation.client_record_id=NEW.record_id AND relation.relationship_version=NEW.initial_relationship_version
 AND relation.organization_record_id IS NEW.initial_parent_record_id)
 AND ((NEW.initial_parent_record_id IS NULL AND NOT EXISTS(SELECT 1 FROM json_each(g.membership_json) member
 JOIN operations_directory_client_organizations other ON other.client_record_id=member.value WHERE other.organization_record_id IS NOT NULL))
 OR (NEW.initial_parent_record_id IS NOT NULL AND (json_array_length(g.membership_json)=1 OR EXISTS(SELECT 1 FROM native_directory_shared_profile_members parent
 WHERE parent.record_id=NEW.initial_parent_record_id AND NOT EXISTS(SELECT 1 FROM json_each(g.membership_json) member
 LEFT JOIN operations_directory_client_organizations other ON other.client_record_id=member.value
 LEFT JOIN native_directory_shared_profile_members other_parent ON other_parent.record_id=other.organization_record_id
 WHERE other_parent.group_id IS NOT parent.group_id)))))))
 AND EXISTS(SELECT 1 FROM json_each(g.membership_json) m WHERE m.value=NEW.record_id))
BEGIN SELECT RAISE(ABORT,'shared_profile_member_identity'); END;
CREATE TRIGGER native_directory_shared_member_immutable BEFORE UPDATE ON native_directory_shared_profile_members
BEGIN SELECT RAISE(ABORT,'shared_profile_member_immutable'); END;
CREATE TRIGGER native_directory_shared_member_no_delete BEFORE DELETE ON native_directory_shared_profile_members
BEGIN SELECT RAISE(ABORT,'shared_profile_member_immutable'); END;
CREATE TRIGGER native_directory_shared_group_update BEFORE UPDATE ON native_directory_shared_profiles
WHEN NEW.id<>OLD.id OR NEW.kind<>OLD.kind OR NEW.membership_json<>OLD.membership_json OR NEW.created_by<>OLD.created_by
 OR NEW.created_at<>OLD.created_at OR NEW.version<>OLD.version+1
 OR NOT EXISTS(SELECT 1 FROM native_directory_shared_profile_commands c WHERE c.group_id=OLD.id AND c.expected_version=OLD.version
 AND json(c.profile_json)=json(NEW.profile_json))
BEGIN SELECT RAISE(ABORT,'shared_profile_revision_guard'); END;
CREATE TRIGGER native_directory_shared_command_guard BEFORE INSERT ON native_directory_shared_profile_commands
WHEN NEW.actor_kind<>'staff' OR NOT EXISTS(SELECT 1 FROM staff_users actor JOIN native_staff_admissions admission ON admission.staff_id=actor.id
 WHERE actor.id=NEW.actor_id AND actor.status='active' AND admission.active=1 AND actor.access_subject=admission.bound_access_subject)
 OR NOT EXISTS(SELECT 1 FROM native_directory_shared_profiles g WHERE g.id=NEW.group_id AND g.version=NEW.expected_version
 AND (g.kind<>'client' OR NEW.identity_safe_contact_profile=1 OR json_extract(g.profile_json,'$.email') IS json_extract(NEW.profile_json,'$.email'))
 AND (SELECT count(*) FROM native_directory_shared_profile_members m WHERE m.group_id=g.id)=json_array_length(g.membership_json)
 AND json_array_length(NEW.members_json)=json_array_length(g.membership_json)
 AND NOT EXISTS(SELECT 1 FROM native_directory_shared_profile_members m JOIN operations_directory_records r ON r.record_id=m.record_id
 WHERE m.group_id=g.id AND NOT EXISTS(SELECT 1 FROM json_each(NEW.members_json) v WHERE json_extract(v.value,'$.recordId')=m.record_id
 AND json_extract(v.value,'$.version')=r.current_version AND length(json_extract(v.value,'$.mutationId'))=36)))
BEGIN SELECT RAISE(ABORT,'shared_profile_command_guard'); END;
CREATE TRIGGER native_directory_shared_command_immutable BEFORE UPDATE ON native_directory_shared_profile_commands
BEGIN SELECT RAISE(ABORT,'shared_profile_command_immutable'); END;
CREATE TRIGGER native_directory_shared_command_no_delete BEFORE DELETE ON native_directory_shared_profile_commands
BEGIN SELECT RAISE(ABORT,'shared_profile_command_immutable'); END;
CREATE TRIGGER native_directory_shared_revision_immutable BEFORE UPDATE ON native_directory_shared_profile_revisions
BEGIN SELECT RAISE(ABORT,'shared_profile_revision_immutable'); END;
CREATE TRIGGER native_directory_shared_revision_no_delete BEFORE DELETE ON native_directory_shared_profile_revisions
BEGIN SELECT RAISE(ABORT,'shared_profile_revision_immutable'); END;
CREATE TRIGGER native_directory_shared_member_write_guard BEFORE INSERT ON operations_directory_write_fences
WHEN EXISTS(SELECT 1 FROM native_directory_shared_profile_members m WHERE m.record_id=NEW.record_id)
 AND NOT EXISTS(SELECT 1 FROM native_directory_shared_profile_members m
 JOIN native_directory_shared_profiles g ON g.id=m.group_id
 JOIN native_directory_shared_profile_commands c ON c.group_id=g.id AND c.expected_version=g.version-1
 JOIN json_each(c.members_json) v
 WHERE m.record_id=NEW.record_id AND NEW.operation_kind='update' AND c.actor_kind='staff' AND c.actor_id=NEW.actor_id
 AND json_extract(v.value,'$.recordId')=NEW.record_id AND json_extract(v.value,'$.version')=NEW.expected_version
 AND json_extract(v.value,'$.mutationId')=NEW.mutation_id AND json(c.profile_json)=json(NEW.profile_json))
BEGIN SELECT RAISE(ABORT,'shared_profile_requires_atomic_group_write'); END;
