// Text for the New task screen, kept free of DOM and CSS imports so it can be unit tested.
/** Readable availability for the New task screen; the shared eligibility rules are unchanged. */
export function availabilityText(provider,availability){
  if(availability?.status!=='busy')return availability?.label||'';
  const waiting=(Number(provider?.capabilities?.taskQueueCount)||0)+(Number(provider?.activeAttempts)||0);
  return `Ready — busy, your task will queue${waiting>0?` (${waiting} in progress or queued)`:''}`;
}

// Plain wording for import codes the server returns without details. These describe the stop; they never
// claim a count or that anything was skipped, because the server stops the whole import unchanged.
const TASK_ERROR_TEXT={
  invalid_image_size:'One or more photos are empty (0 bytes), so the import stopped before anything was created. Check the source folder for zero-byte photos, replace or remove them, and try again.',
  invalid_raw_image:'A selected item isn\u2019t a supported photo, so the import stopped before anything was created. Choose only photos or folders of photos, and try again.',
  no_raw_images:'No photos were found in the selection. Choose photos or folders that contain photos.',
  invalid_raw_selection:'The selection couldn\u2019t be used. Choose photos or folders again.',
  import_selection_too_large:'The selection is too large to import in one go. Choose fewer folders or photos.',
};
export function taskErrorMessage(error){
  const code=error?.code||error?.message;
  return TASK_ERROR_TEXT[code]||String(error?.message||'The task could not be started.');
}
