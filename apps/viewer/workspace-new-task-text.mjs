// Text for the New task screen, kept free of DOM and CSS imports so it can be unit tested.
/** Readable availability for the New task screen; the shared eligibility rules are unchanged. */
export function availabilityText(provider,availability){
  // Busy nodes still take work, so they read simply as Available: no queue wording and no job count.
  return availability?.status==='busy'?'Available':availability?.label||'';
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

// Server-side source preparation (dataset operations). This is preparation of the source photos only; the
// processing node has not started. Progress is the operation's own 0..1 value, shown as a finite percentage.
const PREPARATION_PHASE_TEXT={
  assembling_upload:'Assembling and verifying uploaded photos',
  copying_photos:'Copying photos from the server folder',
  inspecting:'Inspecting the server folder',
  adopting:'Adding photos from the server folder',
};
export function sourcePreparationState(operation){
  const raw=Number(operation?.progress),fraction=Number.isFinite(raw)?Math.min(1,Math.max(0,raw)):0,percent=Math.round(fraction*100);
  if(operation?.status==='queued')return{queued:true,percent:0,message:'Waiting for the server to start preparing your source photos. Processing has not started yet.'};
  const phase=PREPARATION_PHASE_TEXT[operation?.phase]||'Preparing your source photos on the server';
  return{queued:false,percent,message:`${phase}: ${percent}%. Processing starts after preparation finishes.`};
}
