import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { stageConfiguredProjectAlphaCatalogSnapshot, type ProjectAlphaCatalogStagingEnvironment,
  type ProjectAlphaCatalogStagingOutcome } from "./project-alpha-catalog-staging-coordinator";

const SOURCE_ID=/^project-alpha:[a-z0-9][a-z0-9_-]{0,63}$/;
const APPROVAL_ID=/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;

export type ProjectAlphaCatalogPromotionWorkflowCommand=Readonly<{
  protocolVersion:1;registryId:number;sourceId:string;expectedSourceSequence:number;approvalId:string;
}>;
export type ProjectAlphaCatalogPromotionWorkflowResult=
  |Readonly<{status:"rejected";reason:"invalid_command"}>
  |Readonly<{status:"completed";approvalId:string;outcome:ProjectAlphaCatalogStagingOutcome}>;
export type ProjectAlphaCatalogPromotionWorkflowStep=Pick<WorkflowStep,"do">;
type Dependencies=Readonly<{stageAndPromote:typeof stageConfiguredProjectAlphaCatalogSnapshot}>;

function validCommand(value:unknown):value is ProjectAlphaCatalogPromotionWorkflowCommand{
  if(typeof value!=="object"||value===null||Array.isArray(value))return false;
  const command=value as Record<string,unknown>,keys=Object.keys(command);
  return keys.length===5&&["protocolVersion","registryId","sourceId","expectedSourceSequence","approvalId"].every(key=>Object.hasOwn(command,key))
    &&command.protocolVersion===1&&Number.isSafeInteger(command.registryId)&&Number(command.registryId)>0
    &&typeof command.sourceId==="string"&&SOURCE_ID.test(command.sourceId)
    &&Number.isSafeInteger(command.expectedSourceSequence)&&Number(command.expectedSourceSequence)>=0
    &&typeof command.approvalId==="string"&&APPROVAL_ID.test(command.approvalId);
}

/** Manual Wrangler-triggered boundary. No fetch route or scheduled handler invokes it. */
export async function runProjectAlphaCatalogPromotionWorkflow(env:ProjectAlphaCatalogStagingEnvironment,payload:unknown,
  step:ProjectAlphaCatalogPromotionWorkflowStep,dependencies:Partial<Dependencies>={}):Promise<ProjectAlphaCatalogPromotionWorkflowResult>{
  if(!validCommand(payload))return{status:"rejected",reason:"invalid_command"};
  const stageAndPromote=dependencies.stageAndPromote??stageConfiguredProjectAlphaCatalogSnapshot;
  const outcome=await step.do("stage-and-promote-project-alpha-catalog",
    {retries:{limit:0,delay:"1 second",backoff:"constant"},timeout:"10 minutes"},()=>
    stageAndPromote(env,{registryId:payload.registryId,sourceId:payload.sourceId,
      expectedSourceSequence:payload.expectedSourceSequence}));
  return{status:"completed",approvalId:payload.approvalId,outcome};
}

export class ProjectAlphaCatalogPromotionWorkflow extends WorkflowEntrypoint<ProjectAlphaCatalogStagingEnvironment,
  ProjectAlphaCatalogPromotionWorkflowCommand>{
  run(event:Readonly<WorkflowEvent<ProjectAlphaCatalogPromotionWorkflowCommand>>,step:WorkflowStep){
    return runProjectAlphaCatalogPromotionWorkflow(this.env,event.payload,step);
  }
}
