import { useCallback,useEffect,useState } from 'react';
import type { SharedProfilePortalResult,SharedProfilePortalView } from '../../../../packages/shared/src/shared-business-profile';

/** Business data only. Login identities and the address book remain independent. */
export function BusinessProfile({workspaceId}:{workspaceId:string}){
 const [profiles,setProfiles]=useState<readonly SharedProfilePortalView[]>([]),[status,setStatus]=useState(''),[refresh,setRefresh]=useState(0);
 useEffect(()=>{const controller=new AbortController();
  void fetch(`/api/client/v2/workspaces/${encodeURIComponent(workspaceId)}/business-profile`,{credentials:'same-origin',cache:'no-store',signal:controller.signal})
   .then(async response=>{if(!response.ok)throw new Error();return await response.json() as SharedProfilePortalResult;})
   .then(value=>{if(controller.signal.aborted)return;if(!value.ok){setStatus('Business profile is temporarily unavailable.');return;}setProfiles(value.profiles);setStatus('');})
   .catch(()=>{if(!controller.signal.aborted)setStatus('Business profile is temporarily unavailable.');});return()=>controller.abort();
 },[workspaceId,refresh]);
 const reload=useCallback(()=>setRefresh(value=>value+1),[]);
 // An owner must authorize a particular profile before it appears here.
 if(!profiles.length)return null;
 return <section className="portal-business-profile" aria-label="Business profile"><h2>Business profile</h2><p>Changes apply to every connected copy of this profile. Contact details are separate from your sign-in account.</p>
  {status&&<p role="status">{status}</p>}{profiles.map(profile=><BusinessProfileForm key={`${workspaceId}:${profile.grantId}:${profile.version}:${profile.editable}`} workspaceId={workspaceId} value={profile} reload={reload}/>)}</section>;
}
function BusinessProfileForm({workspaceId,value,reload}:{workspaceId:string;value:SharedProfilePortalView;reload:()=>void}){
 const [profile,setProfile]=useState({...value.profile}),[status,setStatus]=useState(''),[saving,setSaving]=useState(false),[saved,setSaved]=useState(false);
 const [pending,setPending]=useState<string|null>(null),[conflict,setConflict]=useState(false);
 const labels:Record<string,string>={name:'Name',email:'Contact email',generalEmail:'Business email',phone:'Phone',generalPhone:'Business phone',addressLine1:'Address',addressLine2:'Address line 2',city:'City',state:'State / region',postalCode:'Postal code',country:'Country'};
 async function save(){
  const body=pending??JSON.stringify({grantId:value.grantId,expectedVersion:value.version,mutationId:crypto.randomUUID(),profile});
  setPending(body);setSaving(true);setStatus('Saving…');
  try{
   const response=await fetch(`/api/client/v2/workspaces/${encodeURIComponent(workspaceId)}/business-profile`,{method:'PATCH',credentials:'same-origin',headers:{'Content-Type':'application/json'},body});
   const result=await response.json() as SharedProfilePortalResult;
   if(!response.ok||!result.ok){
    if(response.status===400){setPending(null);setStatus('Check the profile fields before saving again.');}
    else if(response.status===409||response.status===403){setConflict(true);setStatus('Your profile or access changed. Refresh before making another change.');}
    else setStatus('The save could not be confirmed. Retry this same change to check its result.');
    return;
   }
   setPending(null);setSaved(true);setStatus('Saved. Updates to connected systems are processing.');
  }catch{setStatus('The save could not be confirmed. Retry this same change to check its result.');}finally{setSaving(false);}
 }
 return <form onSubmit={event=>{event.preventDefault();void save();}}><h3>{value.kind==='organization'?'Organization details':'Your client details'}</h3>
  <fieldset disabled={!value.editable||saving||pending!==null||saved}>{Object.keys(profile).filter(key=>Object.hasOwn(labels,key)).map(key=><label key={key}>{labels[key]}<input value={profile[key]??''} maxLength={key==='name'?150:255} onChange={event=>setProfile({...profile,[key]:event.target.value})}/></label>)}</fieldset>
  {value.editable&&!saved?<button type="submit" disabled={saving||conflict}>{saving?'Saving…':pending?'Retry same change':'Save business profile'}</button>:<p>Profile editing is waiting for authorization or connected systems to finish updating.</p>}
  {(!pending||conflict)&&<button type="button" onClick={reload}>Refresh profile</button>}{status&&<p role="status">{status}</p>}</form>;
}
