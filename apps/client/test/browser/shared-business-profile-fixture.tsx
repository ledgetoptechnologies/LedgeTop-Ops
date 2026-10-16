import { createRoot } from 'react-dom/client';
import { BusinessProfile } from '../../src/client/BusinessProfile';
import '../../src/client/styles.css';
export type Scenario='enabled'|'unknown'|'conflict'|'read-only'|'not-authorized';
declare global{interface Window{businessScenario:Scenario;businessCalls:string[];}}
const scenario=window.businessScenario;window.businessCalls=[];let attempts=0;
Object.defineProperty(window.crypto,'randomUUID',{configurable:true,value:()=> '00000000-0000-4000-8000-000000000099'});
const profile={name:'Reviewed Client',email:'contact@example.test',phone:'',addressLine1:'',addressLine2:'',city:'',state:'WI',postalCode:'',country:'US'};
window.fetch=async(_input,options)=>{
 if(options?.method==='PATCH'){
  window.businessCalls.push(String(options.body));attempts++;
  if(scenario==='unknown'&&attempts===1)throw new TypeError('Response lost');
  if(scenario==='conflict')return Response.json({ok:false,code:'conflict'},{status:409});
  return Response.json({ok:true,profiles:[{grantId:'00000000-0000-4000-8000-000000000001',kind:'client',version:2,profile:JSON.parse(String(options.body)).profile,editable:false}]});
 }
 return Response.json({ok:true,profiles:scenario==='not-authorized'?[]:[{grantId:'00000000-0000-4000-8000-000000000001',kind:'client',version:1,profile,editable:scenario!=='read-only'}]});
};
createRoot(document.getElementById('root')!).render(<BusinessProfile workspaceId="workspace"/>);
