"""Opt-in synthetic adapter/journal exercise; no listener or real credentials."""
import base64
import io
import json
import os
from pathlib import Path
import sys

from processing.prototype import Queue
from processing.maintenance import Conflict
from processing.viewer_batch_fixture_adapter import BatchFixtureAdapter, decode_intent
from processing.viewer_tasks import TaskStore

root = Path(sys.argv[1])
if not root.is_absolute() or root.parent != Path('/tmp') or not root.name.startswith('viewer-batch-'):
    raise ValueError('dedicated container-local fixture root required')
mode = sys.argv[2]
if mode == 'validate':
    try:
        decode_intent(sys.stdin.buffer.read(65537))
    except (ValueError, Conflict):
        print('{"error":"invalid_fixture_intent"}', flush=True)
        sys.exit(42)
    print('{"valid":true}', flush=True)
    sys.exit(0)
if mode == 'crash':
    root.mkdir(mode=0o700)
elif mode not in ('recover', 'replay') or not root.is_dir():
    raise ValueError('fixture replay root required')
body = sys.stdin.buffer.read(65537)
if not body or len(body) > 65536:
    raise ValueError('bounded fixture intent required')
intent = json.loads(body)
task = intent['providerTaskId']
capability = base64.urlsafe_b64encode(b'a' * 32).decode().rstrip('=')
queue = Queue(root / 'queue', node_ids=('cluster', 'main'), viewer_enabled=True)
try:
    store = TaskStore(queue, root / 'inputs')
    if mode == 'crash':
        store.reserve(task, 'production', capability)
        store.initialize(task, 'synthetic', [], None, 'production', capability)
    adapter = BatchFixtureAdapter(store, fixture=True)
    if mode == 'crash':
        def crash_before_journal(*args, **kwargs):
            os._exit(76)
        adapter.journal._prepare_in_transaction = crash_before_journal
    if mode == 'recover':
        with queue._db() as db:
            for table in ('viewer_batch_fixture_bindings', 'viewer_batch_intents'):
                if db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", (table,)).fetchone():
                    raise RuntimeError('partial transaction was not rolled back')
    try:
        result = adapter.prepare(task, 'production', capability, generation=1,
            attempt_id=intent['attemptId'], intent_bytes=body)
    except Conflict as error:
        if mode == 'replay' and str(error) == 'fixture_binding_conflict':
            print('{"error":"fixture_binding_conflict"}', flush=True)
            sys.exit(42)
        raise
    if mode == 'recover':
        os._exit(77)
    snapshots = []
    for entry, data in zip(intent['entries'], (b'photo!', b'points'), strict=True):
        name = base64.urlsafe_b64decode(entry['wireNameUtf8Base64url'] + '===').decode('ascii')
        store.upload(task, name, io.BytesIO(data), len(data), 'production', capability,
            batch_journal=adapter.journal, batch_id=intent['batchId'])
        with queue._db() as db:
            rows = db.execute('''SELECT a.ordinal,f.name,f.bytes,f.sha256,i.manifest
                FROM viewer_batch_associations a JOIN viewer_files f
                  ON f.uuid=? AND f.name_key=a.name_key
                JOIN viewer_batch_intents i ON i.batch_id=a.batch_id
                WHERE a.batch_id=? ORDER BY a.ordinal''', (task, intent['batchId'])).fetchall()
            snapshot = []
            for row in rows:
                role = json.loads(row['manifest'])[row['ordinal']]['role']
                snapshot.append({'wireNameUtf8Base64url':base64.urlsafe_b64encode(row['name'].encode('ascii')).decode().rstrip('='),
                    'role':role,'sizeBytes':str(row['bytes']),'sha256':row['sha256']})
            snapshots.append(snapshot)
    print(json.dumps({'digest':result['fixtureIntentSha256'],'observationOnly':result['observationOnly'],
        'snapshots':snapshots}, separators=(',', ':')), flush=True)
finally:
    queue.close()
