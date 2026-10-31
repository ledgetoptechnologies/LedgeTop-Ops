'use strict';
const {validCapability}=require('../../server/processingReservationProtocol');
function requirePrimeBinding({processing,identity,attempt,provider,endpoint,resolveCapability}){
 if(!identity||!attempt||attempt.id!==identity.attemptId||attempt.providerId!==identity.providerId||attempt.providerTaskId!==identity.providerTaskId||!provider||provider.id!==identity.providerId||provider.type!=='nodeodm'||provider.endpoint!==endpoint||!provider.enabled||!processing?.attemptRequiresReservation(identity.attemptId)||typeof resolveCapability!=='function')throw Error('archive prime provider binding unavailable');
 const capability=resolveCapability();if(!validCapability(capability))throw Error('archive prime reservation capability unavailable');return capability;
}
module.exports={requirePrimeBinding};
