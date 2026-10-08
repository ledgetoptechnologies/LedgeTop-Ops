import { applyBusinessAreaAuthorityPhase } from "./staging-project-business-area-authority-packet.mjs";
import { withStagingAuthorityBinding } from "./staging-native-authority-binding-runner.mjs";

const fail=message=>{throw new Error(`project-business-area-authority-binding-runner: ${message}`);};

/** Module-only entry point. The shared binding helper validates and re-reads
 * the exact minimal remote staging config before this callback receives D1. */
export async function applyReviewedBusinessAreaAuthorityPhase(configPath,packet,phase,dependencies={}){
 if(!packet||typeof packet!=="object"||Array.isArray(packet)||packet.schemaVersion!==1||packet.trustedApplyOnly!==true)fail("reviewed compiled pair required");
 if(!["provision","revoke"].includes(phase))fail("phase");
 const withBinding=dependencies.withBinding??withStagingAuthorityBinding;
 const applyPhase=dependencies.applyPhase??applyBusinessAreaAuthorityPhase;
 return withBinding(configPath,({db,target})=>applyPhase(db,packet,phase,{target,...(dependencies.root?{root:dependencies.root}:{})}),dependencies);
}
