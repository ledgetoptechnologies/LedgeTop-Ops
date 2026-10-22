// Memory-only checkpoint. Restoring a draft never grants access: the caller
// supplies the freshly authenticated session and the workspace rechecks geometry.
function identity(session){
  const values=[session?.subject,session?.audience,session?.model?.id,session?.model?.activeVersion?.id];
  return values.every(value=>typeof value==='string'&&value.length>0)?JSON.stringify(values):null;
}
export function createMeasurementDraftRecovery(){
  let checkpoint=null,restoring=null;
  return{
    capture(reason,session,workspace){
      if(reason!=='session-expired'){checkpoint=null;return;}
      const key=identity(session);if(!key){checkpoint=null;return;}
      if(checkpoint?.key===key)return;
      const draft=workspace?.exportDraft?.({recoverExpiredSession:true});checkpoint=draft?{key,draft}:null;
    },
    async restore(session,workspace){
      const saved=checkpoint;
      if(!saved)return false;
      if(saved.key!==identity(session)||session.permissions?.measure===false){checkpoint=null;return false;}
      if(restoring===saved||typeof workspace?.restoreDraft!=='function')return false;
      restoring=saved;
      try{
        const restored=await workspace.restoreDraft(saved.draft);
        if(checkpoint!==saved)return false;
        // False is an explicit geometry/revision/view conflict. A thrown load
        // error is retryable and must not silently discard the memory snapshot.
        checkpoint=null;return restored===true;
      }catch{return false;}
      finally{if(restoring===saved)restoring=null;}
    },
    hasPending(){return checkpoint!==null;},
    clear(){checkpoint=null;},
  };
}
