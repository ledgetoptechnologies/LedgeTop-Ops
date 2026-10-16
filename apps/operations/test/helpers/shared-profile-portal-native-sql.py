"""Full-schema SQL guard test; synthetic mapping/enrollment read contracts only.

Composer tests separately exercise real native acquisition receipts and PA
outboxes. Here fixture seeding temporarily suspends triggers, restores every
one, then exercises the production 0209 ledger guards without trusted TS code.
"""
import datetime,json,pathlib,sqlite3,sys

db=sqlite3.connect(':memory:')
migrations=pathlib.Path(sys.argv[1]);count=0
for migration in sorted(migrations.glob('[0-9][0-9][0-9][0-9]_*.sql')):
 if migration.name[:4]>'0209':continue
 db.executescript(migration.read_text(encoding='utf-8-sig'));count+=1
assert count==209
staff_view=db.execute("SELECT sql FROM sqlite_master WHERE name='operations_directory_live_staff_write_fences'").fetchone()[0]
original=(migrations/'0203_effective_native_directory_enrollment_consumers.sql').read_text()
original=original[original.index('CREATE VIEW operations_directory_live_write_fences AS'):original.index('\nCREATE VIEW operations_directory_live_relationship_fences AS')].strip().rstrip(';')
assert staff_view.replace('operations_directory_live_staff_write_fences','operations_directory_live_write_fences',1)==original
assert [r[1] for r in db.execute('PRAGMA table_info(operations_directory_write_fences)')]==[r[1] for r in db.execute('PRAGMA table_info(operations_directory_portal_write_fences)')]
# The additive parent lane must retain every historical 0203 predicate.
# Undo only the mechanical depth-limit factoring and the explicit portal lane.
original_dependency=(migrations/'0203_effective_native_directory_enrollment_consumers.sql').read_text()
start=original_dependency.index('CREATE TRIGGER operations_directory_intent_relationship_dependencies_insert_guard')
end=original_dependency.index("BEGIN SELECT RAISE(ABORT,'directory intent relationship dependency requires live canonical evidence'); END;",start)
original_dependency=original_dependency[start:end]
current_dependency=db.execute("SELECT sql FROM sqlite_master WHERE name='operations_directory_intent_relationship_dependencies_insert_guard'").fetchone()[0]
current_dependency=current_dependency[:current_dependency.index("BEGIN SELECT RAISE(ABORT,")]
import re
pattern=r"\(WITH predicates\(allowed\) AS \(VALUES\n(.*?)\n *\) SELECT MIN\(coalesce\(allowed,0\)\) FROM predicates\)=1"
def undo_factor(match):
 rows=match.group(1).split(',\n')
 return ' AND '.join(row.strip()[1:-1] for row in rows)
current_dependency=re.sub(pattern,undo_factor,current_dependency,flags=re.S)
portal_lane="""(audit.actor_type='staff' OR (audit.actor_type='system' AND EXISTS(
            SELECT 1 FROM shared_profile_portal_ack_witnesses witness
            WHERE witness.command_id=outbox.command_id AND witness.mutation_id=updated.mutation_id
              AND witness.record_id=updated.record_id AND witness.record_version=updated.record_version
              AND witness.actor_id=audit.actor_id AND witness.subject=audit.original_verified_access_subject)))"""
assert portal_lane in current_dependency
current_dependency=current_dependency.replace(portal_lane,"audit.actor_type='staff'")
assert re.sub(r'\s+',' ',current_dependency).strip()==re.sub(r'\s+',' ',original_dependency).strip(),'Historical dependency predicates changed'

db.setlimit(sqlite3.SQLITE_LIMIT_EXPR_DEPTH,100)
paths=['operations_directory_portal_write_fences','operations_directory_write_fences','operations_directory_records','operations_directory_revisions',
 'operations_directory_audit','operations_directory_intents','operations_directory_intent_relationship_dependencies','native_directory_shared_profile_commands','shared_profile_portal_audit','native_directory_profile_binding_jobs','shared_profile_authority_recoveries','shared_profile_authority_recovery_steps','shared_profile_authority_recovery_audit','shared_profile_portal_authority_heads']
for table in paths:
 columns=[r[1] for r in db.execute('PRAGMA table_xinfo('+table+')') if not r[6]]
 db.execute('EXPLAIN INSERT INTO '+table+'('+','.join(columns)+') VALUES('+','.join('?'*len(columns))+')',['fixture']*len(columns)).fetchall()
for view in ['operations_directory_live_staff_write_fences','operations_directory_live_portal_write_fences','operations_directory_live_write_fences']:
 db.execute('EXPLAIN SELECT * FROM '+view).fetchall()
db.execute("EXPLAIN UPDATE project_alpha_directory_outbox SET state='acknowledged',outcome_json='{}',lease_token=NULL,lease_expires_at=NULL WHERE command_id='fixture'").fetchall()

# Replace only the expensive read-contract producers with synthetic rows. Every
# write trigger, including original staff/adoption alternatives, remains intact.
triggers=db.execute("SELECT name,sql FROM sqlite_master WHERE type='trigger'").fetchall()
for name,sql in triggers:db.execute('DROP TRIGGER '+name)
for name in ['project_alpha_active_directory_mappings','effective_native_directory_enrollments']:
 columns=db.execute('PRAGMA table_info('+name+')').fetchall();db.execute('DROP VIEW '+name)
 db.execute('CREATE TABLE '+name+'('+','.join('"'+r[1]+'" '+(r[2] or 'TEXT') for r in columns)+')')

def uid(n):return '00000000-0000-4000-8000-'+str(n).zfill(12)
group,grant,shared,native1,native2=map(uid,range(1,6))
members=['member-primary','member-secondary'];source='project-alpha:primary'
old={'name':'Old name','generalEmail':'org@example.test','generalPhone':'','addressLine1':'','addressLine2':'','city':'','state':'','postalCode':'','country':'US'}
profile={**old,'name':'Updated name'}
destinations={member:[{'sourceId':'project-alpha:'+('primary' if i==0 else 'secondary'),'sourceInstanceUUID':uid(100+i),'applicationUUID':uid(110+i),
 'historyEpoch':uid(120+i),'origin':'https://pa'+str(i)+'.example.test','externalCanonicalId':member}] for i,member in enumerate(members)}
db.execute("INSERT INTO staff_users(id,email,display_name,access_subject) VALUES('owner','owner@example.test','Owner','owner-subject')")
for i,member in enumerate(members):
 db.execute("INSERT INTO operations_directory_records(record_id,record_kind,current_version) VALUES(?,'organization',1)",(member,))
 db.execute('INSERT INTO operations_directory_revisions(record_id,version,mutation_id,profile_json) VALUES(?,1,?,?)',(member,uid(30+i),json.dumps(old)))
 db.execute('INSERT INTO effective_native_directory_enrollments(record_id,destinations_json) VALUES(?,?)',(member,json.dumps(destinations[member])))
db.execute("INSERT INTO project_alpha_active_directory_mappings(record_id,source_id,resource_type,project_alpha_public_id,source_instance_id,application_id,history_epoch_id) VALUES(?,?,'organization',?,'00000000-0000-4000-8000-000000000100','00000000-0000-4000-8000-000000000110','00000000-0000-4000-8000-000000000120')",(members[0],source,'a'*32))
db.execute("INSERT INTO native_directory_shared_profiles(id,kind,profile_json,membership_json,created_by) VALUES(?,'organization',?,?,'owner')",(group,json.dumps(old),json.dumps(members)))
for member in members:db.execute('INSERT INTO native_directory_shared_profile_members(record_id,group_id,initial_version) VALUES(?,?,1)',(member,group))
db.execute("INSERT INTO shared_profile_portal_authority_heads(workspace_id,source_id,revision,state,operation_id) VALUES('workspace',?,1,'active',?)",(source,uid(6)))
db.execute("INSERT INTO shared_profile_portal_grants(id,workspace_id,source_id,source_instance_id,application_id,history_epoch_id,issuer,subject,principal_public_id,target_type,target_public_id,record_id,group_id,group_membership_json,revision,state,issued_by) VALUES(?,'workspace',?,'00000000-0000-4000-8000-000000000100','00000000-0000-4000-8000-000000000110','00000000-0000-4000-8000-000000000120','issuer','subject','principal','organization',?,?,?,?,1,'active','owner')",(grant,source,'a'*32,members[0],group,json.dumps(members)))
for name,sql in triggers:db.execute(sql)

until=(datetime.datetime.now(datetime.timezone.utc)+datetime.timedelta(seconds=30)).isoformat().replace('+00:00','Z')
db.execute('INSERT INTO shared_profile_portal_write_fences(mutation_id,grant_id,grant_revision,authority_revision,group_id,expected_group_version,issuer,subject,context_version,verified_until,request_sha256) VALUES(?,?,1,1,?,1,?,?,?, ?,?)',(shared,grant,group,'issuer','subject','b'*64,until,'c'*64))
member_commands=[{'recordId':member,'version':1,'mutationId':mutation} for member,mutation in zip(members,[native1,native2])]
command_sql="INSERT INTO native_directory_shared_profile_commands(mutation_id,group_id,expected_version,request_sha256,profile_json,members_json,actor_kind,actor_id) VALUES(?,?,1,?,?,?,'portal',?)"
command_values=(shared,group,'c'*64,json.dumps(profile),json.dumps(member_commands),'portal:'+grant)

rejected=0
def reject(action,contains=None):
 global rejected
 db.execute('SAVEPOINT negative')
 try:
  action()
 except sqlite3.DatabaseError as error:
  if contains:assert contains in str(error),(contains,str(error))
  rejected+=1
 else:raise AssertionError('Unauthorized SQL accepted')
 finally:db.execute('ROLLBACK TO negative');db.execute('RELEASE negative')

reject(lambda:db.execute(command_sql,(uid(88),*command_values[1:])),'shared_profile_command_portal_authority')
reject(lambda:db.execute(command_sql,(*command_values[:3],json.dumps({**profile,'accessGrant':'allow'}),*command_values[4:])),'shared_profile_portal_command_shape')
db.execute(command_sql,command_values)
db.execute('UPDATE native_directory_shared_profiles SET version=2,profile_json=? WHERE id=?',(json.dumps(profile),group))
db.execute('INSERT INTO native_directory_shared_profile_revisions(group_id,version,mutation_id,profile_json) VALUES(?,2,?,?)',(group,shared,json.dumps(profile)))

actor={'kind':'portal','actorId':'portal:'+grant,'issuer':'issuer','subject':'subject','grantId':grant,'grantRevision':1,
 'workspaceId':'workspace','sourceId':source,'groupId':group,'groupVersion':1,'sharedMutationId':shared,'authorityRevision':1,'contextVersion':'b'*64,'verifiedUntil':until}
command={'operation':'update','mutationId':native1,'resourceType':'organization','recordId':members[0],'expectedLocalVersion':1,
 'actor':actor,'fields':profile,'scopes':None,'destinations':destinations[members[0]],'createAdmissionId':None,'relationship':None}
fence_sql="INSERT INTO operations_directory_portal_write_fences(mutation_id,operation_kind,actor_id,bound_access_subject,actor_admission_version,permission,record_id,record_kind,expected_version,selected_grant_id,scopes_json,profile_json,command_json,destinations_json,intent_writes) VALUES(?,'update',?,?,0,'directory.profile.edit',?,'organization',1,?,'[]',?,?,?,1)"
fence_values=(native1,'portal:'+grant,'subject',members[0],grant,json.dumps(profile),json.dumps(command),json.dumps(destinations[members[0]]))
reject(lambda:db.execute(fence_sql,(*fence_values[:6],json.dumps({**command,'actor':{**actor,'subject':'forged'}}),fence_values[7])),'portal directory write requires current scoped authority')
reject(lambda:db.execute(fence_sql,(*fence_values[:6],json.dumps({**command,'actor':{k:v for k,v in actor.items() if k!='verifiedUntil'}}),fence_values[7])),'portal directory write requires current scoped authority')
def revoke_then_insert():
 db.execute("UPDATE shared_profile_portal_grants SET state='revoked',revision=2 WHERE id=?",(grant,));db.execute(fence_sql,fence_values)
reject(revoke_then_insert,'portal directory write requires current scoped authority')
def pause_then_insert():
 db.execute("UPDATE shared_profile_portal_authority_heads SET state='blocked',revision=2 WHERE workspace_id='workspace'");db.execute(fence_sql,fence_values)
reject(pause_then_insert,'portal directory write requires current scoped authority')
def epoch_then_insert():
 db.execute("UPDATE project_alpha_active_directory_mappings SET history_epoch_id='replacement' WHERE record_id=?",(members[0],));db.execute(fence_sql,fence_values)
reject(epoch_then_insert,'portal directory write requires current scoped authority')

db.execute(fence_sql,fence_values)
reject(lambda:db.execute('DELETE FROM operations_directory_portal_write_fences WHERE mutation_id=?',(native1,)),'not exhausted')
reject(lambda:db.execute('UPDATE operations_directory_portal_write_fences SET record_writes=0 WHERE mutation_id=?',(native1,)),'immutable')
reject(lambda:db.execute('UPDATE operations_directory_portal_write_fences SET command_json=? WHERE mutation_id=?',('{}',native1)),'immutable')
db.execute('UPDATE operations_directory_records SET current_version=2 WHERE record_id=?',(members[0],))
db.execute('INSERT INTO operations_directory_revisions(record_id,version,mutation_id,profile_json) VALUES(?,2,?,?)',(members[0],native1,json.dumps(profile)))
audit_sql='INSERT INTO operations_directory_audit(audit_id,mutation_id,record_id,record_version,actor_type,actor_id,command_json,original_verified_access_subject) VALUES(?,?,?,2,?,?,?,?)'
reject(lambda:db.execute(audit_sql,(native1+':bad',native1,members[0],'staff','portal:'+grant,json.dumps(command),'subject')),'directory audit requires current native authority')
db.execute(audit_sql,(native1+':audit',native1,members[0],'system','portal:'+grant,json.dumps(command),'subject'))
db.execute("INSERT INTO operations_directory_intents(intent_id,mutation_id,record_id,record_version,source_id,source_instance_uuid,application_uuid,destination_origin,external_canonical_id,desired_payload_json,expected_history_epoch_id,state) VALUES(?,?,?,2,?,'00000000-0000-4000-8000-000000000100','00000000-0000-4000-8000-000000000110','https://pa0.example.test',?,?,'00000000-0000-4000-8000-000000000120','waiting')",(native1+':intent',native1,members[0],source,members[0],json.dumps(profile)))
assert db.execute('SELECT record_writes,revision_writes,audit_writes,intent_writes FROM operations_directory_portal_write_fences WHERE mutation_id=?',(native1,)).fetchone()==(0,0,0,0)
db.execute('DELETE FROM operations_directory_portal_write_fences WHERE mutation_id=?',(native1,))
assert db.execute('SELECT actor_type,actor_id FROM operations_directory_audit WHERE mutation_id=?',(native1,)).fetchone()==('system','portal:'+grant)
assert db.execute("SELECT count(*) FROM staff_users WHERE id=?",('portal:'+grant,)).fetchone()[0]==0

# ACK stage: seed only the materialization transport inputs while suspended,
# then restore all production triggers before observing authority and ACKs.
for name,sql in triggers:db.execute('DROP TRIGGER '+name)
compact=lambda value:json.dumps(value,separators=(',',':'))
wire_id=uid(210)
wire={'operation':'update','commandId':wire_id,'resourceType':'organization','externalId':members[0],
 'expectedProjectAlphaPublicId':'a'*32,'expectedRevision':'1','expectedAuthorizationGeneration':'2','fields':profile}
outcome={'status':'acknowledged','response':{'sourceInstanceId':uid(100),'applicationId':uid(110),'historyEpoch':uid(120),
 'result':{'resource':{'type':'organization','id':members[0],'publicId':'a'*32,'revision':'2'},'authorizationGeneration':'2','data':{'publicId':'a'*32}}}}
wire_json,outcome_json=compact(wire),compact(outcome)
origin=compact({'actorId':'portal:'+grant,'actorSubject':'subject','authorityRevision':'2'})
db.execute('UPDATE operations_directory_revisions SET profile_json=? WHERE record_id=? AND version=2',(compact(profile),members[0]))
db.execute('UPDATE operations_directory_audit SET command_json=? WHERE mutation_id=?',(compact(command),native1))
db.execute("UPDATE project_alpha_active_directory_mappings SET external_id=?,mapping_kind='acquired',provenance_id=? WHERE record_id=?",(members[0],uid(220),members[0]))
db.execute("UPDATE operations_directory_intents SET state='materialized' WHERE intent_id=?",(native1+':intent',))
db.execute('INSERT INTO operations_directory_materializations(intent_id,command_id,command_json,origin_snapshot_json,disposition_json,next_attempt_at,history_epoch_id) VALUES(?,?,?,?,?,0,?)',
 (native1+':intent',wire_id,wire_json,origin,'{}',uid(120)))
now_ms=int(datetime.datetime.now(datetime.timezone.utc).timestamp()*1000)
db.execute("INSERT INTO project_alpha_directory_outbox(command_id,source_id,application_id,resource_type,external_id,command_json,destination_base_url,expected_source_instance_id,origin_snapshot_json,state,next_attempt_at,lease_token,lease_expires_at,expected_history_epoch_id) VALUES(?,?,?,'organization',?,?,?,?,?,'leased',0,?,?,?)",
 (wire_id,source,uid(110),members[0],wire_json,'https://pa0.example.test',uid(100),origin,uid(221),now_ms+60000,uid(120)))
for name,sql in triggers:db.execute(sql)
ack=lambda:db.execute("UPDATE project_alpha_directory_outbox SET state='acknowledged',outcome_json=?,lease_token=NULL,lease_expires_at=NULL WHERE command_id=?",(outcome_json,wire_id))
reject(ack)
until=(datetime.datetime.now(datetime.timezone.utc)+datetime.timedelta(seconds=30)).isoformat().replace('+00:00','Z')
detail={'commandId':wire_id,'groupId':group,'sharedMutationId':shared,'requestSha256':'c'*64,'grantRevision':1,
 'authorityRevision':1,'contextVersion':'d'*64,'verifiedUntil':until,'sourceId':source,'sourceInstanceId':uid(100),
 'applicationId':uid(110),'historyEpoch':uid(120),'destinationOrigin':'https://pa0.example.test','recordId':members[0],
 'localVersion':2,'commandJson':wire_json,'outcomeJson':outcome_json}
def witness(value):
 db.execute("INSERT INTO shared_profile_portal_audit(operation_id,grant_id,workspace_id,action,actor_kind,actor_id,detail_json) VALUES(?,?,'workspace','profile.delivery_authority','system',?,?)",(uid(222),grant,'portal:'+grant,compact(value)))
reject(lambda:witness({**detail,'verifiedUntil':'2000-01-01T00:00:00Z'}),'exact fresh authority')
reject(lambda:witness({**detail,'commandJson':'{}'}),'exact fresh authority')
reject(lambda:witness({**detail,'sourceInstanceId':uid(999)}),'exact fresh authority')
reject(lambda:witness({k:v for k,v in detail.items() if k!='contextVersion'}),'exact fresh authority')
witness(detail)
def revoked_before_ack():
 db.execute("UPDATE shared_profile_portal_grants SET state='revoked',revision=2 WHERE id=?",(grant,));ack()
reject(revoked_before_ack)
def head_advanced_before_ack():
 db.execute("UPDATE shared_profile_portal_authority_heads SET revision=2 WHERE workspace_id='workspace'");ack()
reject(head_advanced_before_ack)
ack()
job=db.execute('SELECT actor_id,access_subject,actor_json,mapping_provenance_id FROM native_directory_profile_binding_jobs WHERE command_id=?',(wire_id,)).fetchone()
assert job is not None,'Fresh exact portal ACK must create a binding continuation job'
assert job[0:2]==('portal:'+grant,'subject') and json.loads(job[2])==actor and job[3]==uid(220)
assert db.execute("SELECT state FROM native_directory_profile_binding_dispatch WHERE command_id=?",(wire_id,)).fetchone()==('pending',)
db.execute("UPDATE operations_directory_intents SET state='acknowledged' WHERE intent_id=?",(native1+':intent',))
# Revocation fences future profile POSTs, not exact already accepted mapping repair.
db.execute("UPDATE shared_profile_portal_grants SET state='revoked',revision=2 WHERE id=?",(grant,))
db.execute("UPDATE shared_profile_portal_authority_heads SET state='blocked',revision=2 WHERE workspace_id='workspace'")
assert db.execute('SELECT command_id FROM shared_profile_portal_ack_witnesses WHERE command_id=?',(wire_id,)).fetchone()==(wire_id,)
# Execute the continuation runtime's exact immutable-evidence predicate. The
# cross-surface conflict subpredicate is tested by its own full-D1 fixture; here
# there is no canonical conflict evidence and read producers are synthetic.
runtime=(migrations.parent/'src/worker/native-directory-profile-binding-continuation.ts').read_text()
current=runtime.split('const current=`',1)[1].split('  AND NOT EXISTS(SELECT 1 FROM client_hub_native_project_effective_directory_conflicts',1)[0]
assert db.execute('SELECT command_id FROM native_directory_profile_binding_jobs c WHERE '+current+' AND command_id=?',(wire_id,)).fetchone()==(wire_id,)
print(json.dumps({'migrations':count,'expressionDepth':100,'staffViewUnchanged':True,'same20Columns':True,'negativeCasesRejected':rejected,'portalLedgerAndCounterLifecyclePassed':True,'noFakeStaff':True,'portalAckWitnessAndJobPassed':True,'postAckRevocationRetainsCompletionAuthority':True}))
