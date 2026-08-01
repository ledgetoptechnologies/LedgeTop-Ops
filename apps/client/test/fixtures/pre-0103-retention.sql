INSERT INTO client_accounts (id,display_name,status)
VALUES ('migration-account','Migration Client','active');

INSERT INTO client_identity_links (id,account_id,issuer,subject,email)
VALUES ('migration-identity','migration-account','https://issuer.test','migration-subject','migration@example.test');

INSERT INTO client_account_members (account_id,identity_id,role)
VALUES ('migration-account','migration-identity','manager');

INSERT INTO projects (id,external_ref,client_name,project_name,r2_prefix)
VALUES ('migration-project','MIG-1','Migration Client','Retained Project','clients/migration/project/');

INSERT INTO client_project_grants (account_id,project_id,can_request_service)
VALUES ('migration-account','migration-project',1);

INSERT INTO client_service_requests
  (id,account_id,project_id,created_by_identity_id,request_type,title,details,
   idempotency_key,request_fingerprint,status)
VALUES
  ('migration-request','migration-account','migration-project','migration-identity',
   'service','Retained request','Keep this row through migration',
   'migration-key-0000000001','aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa','accepted');

INSERT INTO client_portal_notification_outbox
  (id,request_id,event_type,status_value,recipient_kind,payload_json)
VALUES
  ('migration-notification','migration-request','request_status_changed','accepted',
   'client_requester','{}');
