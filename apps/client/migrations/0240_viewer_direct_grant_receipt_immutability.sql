-- A create receipt is the immutable source for the recipient authority pin.
-- Rewriting or deleting it could transfer or erase that binding.
CREATE TRIGGER viewer_direct_client_grant_receipts_immutable_update
BEFORE UPDATE ON viewer_direct_client_grant_mutation_receipts
BEGIN
 SELECT RAISE(ABORT,'direct-viewer-grant-receipt-immutable');
END;

CREATE TRIGGER viewer_direct_client_grant_receipts_immutable_delete
BEFORE DELETE ON viewer_direct_client_grant_mutation_receipts
BEGIN
 SELECT RAISE(ABORT,'direct-viewer-grant-receipt-immutable');
END;
