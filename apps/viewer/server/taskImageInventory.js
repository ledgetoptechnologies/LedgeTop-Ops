'use strict';

// These are registered input inventories, not arbitrary image assets. Archive
// imports may have no dataset image rows but retain their camera originals on
// the result version. COUNT queries avoid loading photos or walking disk on a
// dashboard request, and the attempt join prevents cross-task attribution.
function taskImageInventory(database, taskId, versionId = null) {
  const datasetCount = Number(database.prepare(`
    SELECT COUNT(*) AS count FROM dataset_files files
    JOIN processing_tasks task ON task.dataset_id=files.dataset_id
    WHERE task.id=? AND (files.processing_role='image'
      OR (COALESCE(files.processing_role,'auto')='auto' AND COALESCE(files.mime_type,files.content_type) LIKE 'image/%'))
  `).get(taskId).count);
  if (datasetCount > 0) return { sourceImageCount: datasetCount, sourceImageCountSource: 'dataset_inputs' };
  const originalCount = versionId ? Number(database.prepare(`
    SELECT COUNT(*) AS count FROM model_camera_photos photos
    WHERE photos.version_id=? AND EXISTS (
      SELECT 1 FROM processing_attempts attempt
      WHERE attempt.task_id=? AND attempt.result_model_version_id=photos.version_id
    )
  `).get(versionId, taskId).count) : 0;
  if (originalCount > 0) return { sourceImageCount: originalCount, sourceImageCountSource: 'registered_camera_originals' };
  // No inventory is not evidence of a zero-image reconstruction.
  return { sourceImageCount: null, sourceImageCountSource: null };
}

module.exports = { taskImageInventory };
