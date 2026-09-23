import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { stageConfiguredProjectAlphaCatalogSnapshot, type ProjectAlphaCatalogStagingEnvironment,
  type ProjectAlphaCatalogStagingOutcome } from "./project-alpha-catalog-staging-coordinator";

const SOURCE_ID=/^project-alpha:[a-z0-9][a-z0-9_-]{0,63}$/;
const APPROVAL_ID=/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
const SNAPSHOT_ID=/^[0-9a-f]{64}$/;

export type ProjectAlphaCatalogPromotionWorkflowCommand=
  |Readonly<{protocolVersion:1;action:"stage";registryId:number;sourceId:string;approvalId:string}>
  |Readonly<{protocolVersion:1;action:"promote";registryId:number;sourceId:string;expectedSnapshotId:string;
    expectedSourceSequence:number;approvalId:string}>;
export type ProjectAlphaCatalogPromotionWorkflowResult=
  |Readonly<{status:"rejected";reason:"invalid_command"}>
  |Readonly<{status:"completed";approvalId:string;outcome:ProjectAlphaCatalogStagingOutcome}>;
export type ProjectAlphaCatalogPromotionWorkflowStep=Pick<WorkflowStep,"do">;
type Dependencies=Readonly<{stageAndPromote:typeof stageConfiguredProjectAlphaCatalogSnapshot}>;

function validCommand(value:unknown):value is ProjectAlphaCatalogPromotionWorkflowCommand{
  if(typeof value!=="object"||value===null||Array.isArray(value))return false;
  const command=value as Record<string,unknown>,keys=Object.keys(command);
  const common=command.protocolVersion===1&&Number.isSafeInteger(command.registryId)&&Number(command.registryId)>0
    &&typeof command.sourceId==="string"&&SOURCE_ID.test(command.sourceId)
    &&typeof command.approvalId==="string"&&APPROVAL_ID.test(command.approvalId);
  if(!common)return false;
  if(command.action==="stage")return keys.length===5&&["protocolVersion","action","registryId","sourceId","approvalId"].every(key=>Object.hasOwn(command,key));
  return command.action==="promote"&&keys.length===7
    &&["protocolVersion","action","registryId","sourceId","expectedSnapshotId","expectedSourceSequence","approvalId"].every(key=>Object.hasOwn(command,key))
    &&typeof command.expectedSnapshotId==="string"&&SNAPSHOT_ID.test(command.expectedSnapshotId)
    &&Number.isSafeInteger(command.expectedSourceSequence)&&Number(command.expectedSourceSequence)>=0;
}

/** Manual Wrangler-triggered boundary. No fetch route or scheduled handler invokes it. */
export async function runProjectAlphaCatalogPromotionWorkflow(env:ProjectAlphaCatalogStagingEnvironment,payload:unknown,
  step:ProjectAlphaCatalogPromotionWorkflowStep,dependencies:Partial<Dependencies>={}):Promise<ProjectAlphaCatalogPromotionWorkflowResult>{
  if(!validCommand(payload))return{status:"rejected",reason:"invalid_command"};
  const stageAndPromote=dependencies.stageAndPromote??stageConfiguredProjectAlphaCatalogSnapshot;
  const outcome=await step.do(`${payload.action}-project-alpha-catalog`,
    {retries:{limit:0,delay:"1 second",backoff:"constant"},timeout:"10 minutes"},()=>payload.action==="stage"
      ?stageAndPromote({...env,PROJECT_ALPHA_CATALOG_PROMOTION_COORDINATOR_ENABLED:"false"},
        {registryId:payload.registryId,sourceId:payload.sourceId})
      :stageAndPromote(env,{registryId:payload.registryId,sourceId:payload.sourceId,expectedSnapshotId:payload.expectedSnapshotId,
        expectedSourceSequence:payload.expectedSourceSequence}));
  return{status:"completed",approvalId:payload.approvalId,outcome};
}

export class ProjectAlphaCatalogPromotionWorkflow extends WorkflowEntrypoint<ProjectAlphaCatalogStagingEnvironment,
  ProjectAlphaCatalogPromotionWorkflowCommand>{
  run(event:Readonly<WorkflowEvent<ProjectAlphaCatalogPromotionWorkflowCommand>>,step:WorkflowStep){
    return runProjectAlphaCatalogPromotionWorkflow(this.env,event.payload,step);
  }
}
