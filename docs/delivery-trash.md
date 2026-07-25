# Delivery trash lifecycle

Operations source deletion is metadata-first. The confirmation flow creates a row in `delivery_tombstones`, immediately revokes delivery shares below that file or folder, and leaves the R2 source and preview objects in place.

Active tombstones are excluded from Operations listings, public delivery manifests, direct public media/download routes, and bulk-download snapshots. Administrators can use the Operations Trash panel to restore an item within seven days; restore only clears the tombstone and does not recreate revoked shares.

The Operations Worker purges due tombstones from its existing 15-minute scheduled trigger. Purge deletes the exact source key or all objects under a folder prefix, removes aliases, file-index rows, preview-artifact metadata and derivative objects, then records `delivery.source_purged` in the Operations audit stream. Delete, restore and purge are audited as `delivery.source_deleted`, `delivery.source_restored` and `delivery.source_purged` respectively.

The seven-day retention is stored per tombstone in `purge_after`; no large R2 object is copied during delete or restore. A destination replaced during copy, move, rename, or upload is the exception: the replaced object is retained under a hidden recovery prefix for seven days so an accidental replacement can be recovered.
