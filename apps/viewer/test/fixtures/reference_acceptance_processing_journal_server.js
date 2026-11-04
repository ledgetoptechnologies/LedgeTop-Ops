'use strict';
const path = require('node:path');
const express = require('express');
const { ReferenceAcceptanceLedger } = require('../../server/referenceAcceptance');
const { createReferenceAcceptanceApi, referenceAcceptanceJsonBodyType } = require('../../server/referenceAcceptanceApi');
const { createViewerReceiptSigner } = require('../../server/referenceReceipt');

const root = process.env.LTDS_LEDGER_ROOT;
const ledger = new ReferenceAcceptanceLedger({ managedRoot: path.join(root, 'accepted'), databasePath: path.join(root, 'acceptance.sqlite') });
const nonces = new Set();
const repository = { consumeServiceNonce(id, nonce) { const key = `${id}\0${nonce}`; if (nonces.has(key)) return false; nonces.add(key); return true; } };
const signer = createViewerReceiptSigner({ issuerId: process.env.LTDS_VIEWER_RECEIPT_ISSUER_ID, keyId: process.env.LTDS_VIEWER_RECEIPT_KEY_ID, privateKeyPem: process.env.LTDS_VIEWER_RECEIPT_PRIVATE_KEY_PEM });
const app = express();
const calls = [];
app.use((req, _res, next) => { calls.push({method: req.method, path: req.path}); next(); });
app.use(express.json({ type: referenceAcceptanceJsonBodyType, verify(req, _res, bytes) { req.rawBody = Buffer.from(bytes); } }));
app.use(createReferenceAcceptanceApi({ repository, ledger, serviceKeyId: process.env.LTDS_VIEWER_SERVICE_KEY_ID,
  serviceAuthKeys: { [process.env.LTDS_VIEWER_SERVICE_KEY_ID]: process.env.LTDS_VIEWER_SERVICE_SECRET },
  receiptSigner: signer, environment: 'staging', chunkBytes: 1024 }));
const server = app.listen(0, '127.0.0.1', () => process.send({ type: 'ready', port: server.address().port }));
process.on('message', message => {
  if (message === 'metrics') process.send({ type: 'metrics', calls });
  if (message === 'inspect') {
    const row = ledger.db.prepare('SELECT receipt_id FROM acceptances LIMIT 1').get();
    const record = row ? ledger.getVerified(row.receipt_id) : null;
    process.send({ type: 'inspection', record, counts: {
      accepted: ledger.db.prepare('SELECT COUNT(*) AS n FROM acceptances').get().n,
      intents: ledger.db.prepare('SELECT COUNT(*) AS n FROM transfer_intents').get().n,
      objects: ledger.db.prepare('SELECT COUNT(*) AS n FROM transfer_objects').get().n,
    } });
  }
});

