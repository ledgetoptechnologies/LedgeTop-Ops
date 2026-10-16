import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { expect,it } from 'vitest';
it('preserves staff SQL and enforces portal native authority at expression depth100 against full209',()=>{
 const result=spawnSync(process.env.PYTHON??(process.platform==='win32'?'python':'python3'),[
  fileURLToPath(new URL('./helpers/shared-profile-portal-native-sql.py',import.meta.url)),fileURLToPath(new URL('../migrations/',import.meta.url)),
 ],{encoding:'utf8',timeout:60_000});
 expect(result.error).toBeUndefined();expect(result.status,`${result.stdout}\n${result.stderr}`).toBe(0);
 expect(JSON.parse(result.stdout)).toMatchObject({migrations:209,expressionDepth:100,staffViewUnchanged:true,same20Columns:true,negativeCasesRejected:18,portalLedgerAndCounterLifecyclePassed:true,noFakeStaff:true,portalAckWitnessAndJobPassed:true,postAckRevocationRetainsCompletionAuthority:true});
});
