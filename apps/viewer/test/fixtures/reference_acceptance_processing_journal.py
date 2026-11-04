"""Synthetic real Processing store/worker for paired crash test."""
import json, os, sys, time
from pathlib import Path
sys.path.insert(0, os.path.dirname(__file__))
from reference_acceptance_cross_language import LoopbackOpener, make_client
from processing.prototype import Queue
from processing.reference_store import ReferenceStore, PROFILE
from processing.reference_viewer_transfer_worker import ReferenceViewerTransferWorker
from tests.test_reference_api import ReferenceAPITests
from tests.viewer_receipt_signer import SyntheticViewerSigner

root = Path(os.environ['LTDS_PROCESSING_STATE'])
mode = sys.argv[1]
queue = Queue(str(root)); queue.allowed_profiles.add(PROFILE)
if mode == 'seed':
    fixture = ReferenceAPITests('runTest')
    fixture.queue = queue
    fixture.fixture = json.loads((Path(os.environ['LTDS_PROCESSING_REPO']) / 'contracts/reference-v1.contract.json').read_text())
    fixture.viewer_signer = SyntheticViewerSigner()
    fixture.store = ReferenceStore(queue)
    fixture.api = fixture.make_api()
    job, _, _ = fixture.ready()
    (root / 'synthetic-job.json').write_text(json.dumps({'jobId': job['jobId']}))
    queue.close()
    print(json.dumps({'phase': 'seeded'}), flush=True)
    sys.exit(0)

job_id = json.loads((root / 'synthetic-job.json').read_text())['jobId']
store = ReferenceStore(queue)
if mode == 'recover':
    # The killed worker never recorded acceptance locally, despite Viewer
    # already holding a committed receipt. Recovery must reconcile that gap.
    assert store.get(job_id)['phase'] != 'completed'
    assert not store.acceptance_receipts(job_id)['receipts']
class CrashAtCommitOpener(LoopbackOpener):
    def open(self, request, timeout=30):
        response = super().open(request, timeout=timeout)
        if mode == 'lose' and request.get_method() == 'POST' and request.full_url.split('?')[0].endswith('/commit'):
            response.read(); response.close()
            # Viewer has durably committed, but the worker has not processed
            # the reply or completed its journal. Parent kills this process.
            print(json.dumps({'phase': 'lost', 'jobId': job_id}), flush=True)
            time.sleep(60)
            raise OSError('synthetic lost commit reply')
        return response

opener = CrashAtCommitOpener(os.environ['LTDS_VIEWER_LOOPBACK'])
objects = {'result-1': b'abc', 'result-2': b''}
sender = make_client(None, objects, None, opener)
keys = {os.environ['LTDS_VIEWER_RECEIPT_KEY_ID']: {'issuerId': os.environ['LTDS_VIEWER_RECEIPT_ISSUER_ID'],
        'publicKeyPem': os.environ['LTDS_VIEWER_RECEIPT_PUBLIC_KEY_PEM']}}
worker = ReferenceViewerTransferWorker(store, sender, trusted_receipt_keys=keys,
                                       clock=lambda: 100.0 if mode == 'lose' else 1000.0)
result = worker.run_once()
if mode == 'lose':
    raise AssertionError('expected parent kill before lost reply is processed')
elif mode == 'recover':
    assert result['state'] == 'accepted', result
    assert store.get(job_id)['phase'] == 'completed'
    receipts = store.acceptance_receipts(job_id)['receipts']
    assert len(receipts) == 1
    print(json.dumps({'phase': 'recovered', 'viewerReceipt': receipts[0]['viewerReceipt']}), flush=True)
    queue.close()
else:
    raise AssertionError('unknown phase')
