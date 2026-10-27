// Workspace-only navigation evidence. No File objects, drafts or authority are persisted.
const count=value=>Number.isSafeInteger(value)&&value>0?value:0;
export function hasUnsavedGcpMark(gcpWorkspaces={},taskDetails={}){
  return Object.entries(gcpWorkspaces).some(([taskId,workspace])=>{
    const draft=workspace?.draftPixel;
    if(!workspace?.pointId||!workspace?.activeImage?.id||!draft
      ||!Number.isFinite(draft.pixelX)||!Number.isFinite(draft.pixelY))return false;
    const marks=taskDetails[taskId]?.gcp?.correspondences||[];
    const saved=marks.find(mark=>workspace.editingId&&mark.id===workspace.editingId&&mark.pointId===workspace.pointId&&mark.imageFileId===workspace.activeImage.id)
      ||marks.find(mark=>mark.pointId===workspace.pointId&&mark.imageFileId===workspace.activeImage.id);
    return !saved||saved.pixelX!==draft.pixelX||saved.pixelY!==draft.pixelY;
  });
}
export function createWorkspaceNavigationWork({windowRef=globalThis.window}={}){
  let gcpSaves=0;
  const uploads=new Map();
  const warnBeforeUnload=event=>{
    if(!uploads.size)return;
    event.preventDefault();event.returnValue='';
  };
  return {
    async trackGcpSave(run){gcpSaves++;try{return await run();}finally{gcpSaves--; }},
    async trackLegacyUpload(fileCount,run){
      const id=Symbol();uploads.set(id,count(fileCount));
      try{
        if(uploads.size===1)windowRef?.addEventListener('beforeunload',warnBeforeUnload);
        return await run();
      }finally{
        uploads.delete(id);
        if(!uploads.size)windowRef?.removeEventListener('beforeunload',warnBeforeUnload);
      }
    },
    snapshot(){return {pendingGcpSave:gcpSaves>0,pendingLegacyUpload:uploads.size>0,legacyUploadFileCount:[...uploads.values()].reduce((sum,n)=>sum+n,0)};},
  };
}
export function workspaceNavigationState({newTask={},gcpWorkspaces={},taskDetails={},work={},legacySelectedFileCount=0}={}){
  return {
    pendingUpload:Boolean(newTask.pendingUpload||work.pendingLegacyUpload),
    selectedFileCount:count(newTask.selectedFileCount)+Math.max(count(legacySelectedFileCount),count(work.legacyUploadFileCount)),
    unsavedTaskDraft:Boolean(newTask.unsavedTaskDraft),
    unsavedGcpMark:hasUnsavedGcpMark(gcpWorkspaces,taskDetails),
    pendingGcpSave:Boolean(work.pendingGcpSave),
  };
}
