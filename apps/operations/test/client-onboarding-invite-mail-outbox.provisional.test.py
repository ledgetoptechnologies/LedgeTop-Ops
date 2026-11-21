"""Synthetic SQLite invariants only; not a D1 or provider acceptance test."""
import pathlib, sqlite3, unittest
FIXTURE = pathlib.Path(__file__).with_name('fixtures') / 'client-onboarding-invite-mail-outbox.provisional.sql'
NOW = '2099-01-01T00:00:00.000Z'
OLD = '2000-01-01T00:00:00.000Z'
HASH = 'a'*64
TOKEN = '11111111-1111-4111-8111-111111111111'
ATTEMPT = '22222222-2222-4222-8222-222222222222'

class Outbox(unittest.TestCase):
 def setUp(self):
  self.db=sqlite3.connect(':memory:')
  self.db.executescript('''PRAGMA foreign_keys=ON;
  CREATE TABLE client_onboarding_invitations(invitation_id TEXT PRIMARY KEY,target_client_record_id TEXT,state TEXT,expires_at TEXT,issued_by TEXT,bound_access_subject TEXT);
  CREATE TABLE client_onboarding_issuance_commands(invitation_id TEXT PRIMARY KEY,command_id TEXT UNIQUE,request_sha256 TEXT,target_intent_json TEXT);
  CREATE TABLE client_onboarding_handoffs(command_id TEXT PRIMARY KEY,invitation_id TEXT,request_sha256 TEXT,actor_staff_id TEXT,actor_access_subject TEXT);
  CREATE TABLE client_onboarding_reveal_consumptions(command_id TEXT PRIMARY KEY);
  CREATE TABLE client_onboarding_reveal_audit(command_id TEXT PRIMARY KEY);
  CREATE TABLE live_ids(invitation_id TEXT PRIMARY KEY);
  CREATE VIEW client_onboarding_live_issuances AS SELECT invitation_id FROM live_ids;''')
  self.db.executescript(FIXTURE.read_text(encoding='utf8'))
  self.db.execute('INSERT INTO client_onboarding_invitations VALUES(?,?,?,?,?,?)',('invite',None,'pending',NOW,'staff','subject'))
  self.db.execute('INSERT INTO client_onboarding_issuance_commands VALUES(?,?,?,?)',('invite','command',HASH,None))
  self.db.execute('INSERT INTO client_onboarding_handoffs VALUES(?,?,?,?,?)',('command','invite',HASH,'staff','subject'))
  self.db.execute('INSERT INTO live_ids VALUES(?)',('invite',))
 def insert(self):
  self.db.execute('''INSERT INTO client_onboarding_invite_mail_outbox(command_id,invitation_id,request_sha256,
   recipient_fingerprint_key_id,recipient_fingerprint,key_id,nonce_hex,ciphertext_hex,aad_sha256,expires_at)
   VALUES(?,?,?,?,?,?,?,?,?,?)''',('command','invite',HASH,'mac-key',HASH,'enc-key','b'*24,'c'*34,HASH,NOW))
 def claim(self,until=NOW):
  self.db.execute("UPDATE client_onboarding_invite_mail_outbox SET state='claimed',version=version+1,lease_token=?,lease_until=?",(TOKEN,until))
 def attempt(self):
  self.db.execute("UPDATE client_onboarding_invite_mail_outbox SET state='attempted',version=version+1,lease_token=NULL,lease_until=NULL,attempted_at=?,attempt_id=?",(OLD,ATTEMPT))
 def test_one_attempt_and_unknown_are_terminal(self):
  self.insert();self.claim();self.attempt()
  with self.assertRaises(sqlite3.IntegrityError):self.db.execute("UPDATE client_onboarding_invite_mail_outbox SET state='pending',version=version+1,attempted_at=NULL,attempt_id=NULL")
  self.db.execute("UPDATE client_onboarding_invite_mail_outbox SET state='unknown',version=version+1")
  with self.assertRaises(sqlite3.IntegrityError):self.db.execute("UPDATE client_onboarding_invite_mail_outbox SET state='claimed',version=version+1,lease_token=?,lease_until=?",(TOKEN,NOW))
 def test_live_recheck_and_no_target_mail(self):
  self.db.execute("UPDATE client_onboarding_issuance_commands SET target_intent_json='[]'")
  with self.assertRaises(sqlite3.IntegrityError):self.insert()
  self.db.execute('UPDATE client_onboarding_issuance_commands SET target_intent_json=NULL');self.insert();self.claim();self.db.execute('DELETE FROM live_ids')
  with self.assertRaises(sqlite3.IntegrityError):self.attempt()
 def test_only_expired_unattempted_claim_reclaims(self):
  self.insert();self.claim()
  with self.assertRaises(sqlite3.IntegrityError):self.db.execute("UPDATE client_onboarding_invite_mail_outbox SET state='pending',version=version+1,lease_token=NULL,lease_until=NULL")
  self.db.execute("UPDATE client_onboarding_invite_mail_outbox SET state='suppressed',version=version+1,lease_token=NULL,lease_until=NULL")
  with self.assertRaises(sqlite3.IntegrityError):self.db.execute('DELETE FROM client_onboarding_invite_mail_outbox')
 def test_expired_unattempted_claim_can_reclaim_but_cannot_attempt(self):
  self.insert();self.claim(OLD)
  with self.assertRaises(sqlite3.IntegrityError):self.attempt()
  self.db.execute("UPDATE client_onboarding_invite_mail_outbox SET state='pending',version=version+1,lease_token=NULL,lease_until=NULL")
  self.claim();self.attempt()
  with self.assertRaises(sqlite3.IntegrityError):self.db.execute("UPDATE client_onboarding_invite_mail_outbox SET state='pending',version=version+1,attempted_at=NULL,attempt_id=NULL")
 def test_immutable_and_cas(self):
  self.insert()
  with self.assertRaises(sqlite3.IntegrityError):self.db.execute("UPDATE client_onboarding_invite_mail_outbox SET recipient_fingerprint=?,state='suppressed',version=version+1",('d'*64,))
  with self.assertRaises(sqlite3.IntegrityError):self.db.execute("UPDATE client_onboarding_invite_mail_outbox SET state='suppressed'")
 def test_existing_reveal_writer_fails_for_mail_intent(self):
  self.db.execute('INSERT INTO client_onboarding_reveal_consumptions VALUES(?)',('legacy',))
  self.db.execute('INSERT INTO client_onboarding_reveal_audit VALUES(?)',('legacy',))
  self.insert()
  with self.assertRaises(sqlite3.IntegrityError):self.db.execute('INSERT INTO client_onboarding_reveal_consumptions VALUES(?)',('command',))
  with self.assertRaises(sqlite3.IntegrityError):self.db.execute('INSERT INTO client_onboarding_reveal_audit VALUES(?)',('command',))
 def test_previously_revealed_command_cannot_be_converted_to_mail(self):
  for table in ('client_onboarding_reveal_consumptions','client_onboarding_reveal_audit'):
   self.db.execute(f'INSERT INTO {table} VALUES(?)',('command',))
   with self.assertRaises(sqlite3.IntegrityError):self.insert()
   self.db.execute(f'DELETE FROM {table} WHERE command_id=?',('command',))
 def test_exact_lease_token_and_version_cas_allow_only_one_attempt(self):
  self.insert();self.claim()
  sql="""UPDATE client_onboarding_invite_mail_outbox SET state='attempted',version=version+1,
   lease_token=NULL,lease_until=NULL,attempted_at=?,attempt_id=?
   WHERE command_id=? AND state='claimed' AND version=? AND lease_token=? AND lease_until>strftime('%Y-%m-%dT%H:%M:%fZ','now')"""
  args=(OLD,ATTEMPT,'command',2,TOKEN)
  self.assertEqual(self.db.execute(sql,(OLD,ATTEMPT,'command',2,'33333333-3333-4333-8333-333333333333')).rowcount,0)
  self.assertEqual(self.db.execute(sql,(OLD,ATTEMPT,'command',1,TOKEN)).rowcount,0)
  self.assertEqual(self.db.execute(sql,args).rowcount,1)
  self.assertEqual(self.db.execute(sql,args).rowcount,0)
  self.db.execute("UPDATE client_onboarding_invite_mail_outbox SET state='unknown',version=version+1 WHERE command_id=? AND state='attempted' AND version=? AND attempt_id=?",('command',3,ATTEMPT))
  self.assertEqual(self.db.execute("UPDATE client_onboarding_invite_mail_outbox SET state='sent',version=version+1 WHERE command_id=? AND state='attempted' AND version=? AND attempt_id=?",('command',3,ATTEMPT)).rowcount,0)
if __name__=='__main__':unittest.main()
