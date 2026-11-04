"""Actual Processing sender for the synthetic persistent-Viewer restart test."""
import json
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))
from reference_acceptance_cross_language import LoopbackOpener, make_client, make_job
from processing.viewer_acceptance_transfer import ViewerTransferUnavailable

opener = LoopbackOpener(os.environ['LTDS_VIEWER_LOOPBACK'])
job, acceptance, _, objects = make_job('receipt-paired-durable')
client = make_client(job, objects, None, opener)
if sys.argv[1] == 'lose':
    opener.drop_next_commit = True
    try:
        client.transfer(job, acceptance)
    except ViewerTransferUnavailable as error:
        assert str(error) == 'viewer_transport_unavailable'
    else:
        raise AssertionError('expected a lost commit response')
    print(json.dumps({'phase': 'lost'}))
elif sys.argv[1] == 'recover':
    recovered = client.transfer(job, acceptance)
    replayed = client.transfer(job, acceptance)
    assert recovered == replayed
    assert recovered['acceptance'] == acceptance
    print(json.dumps({'phase': 'recovered', 'viewerReceipt': recovered['viewerReceipt']}))
else:
    raise AssertionError('invalid phase')
