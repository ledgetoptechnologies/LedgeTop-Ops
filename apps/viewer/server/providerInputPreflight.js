'use strict';
// A conservative lower bound, not a reservation or a substitute for worker admission.
function photoLowerBoundError(capabilities,files){
  if(!Object.hasOwn(capabilities||{},'ledgetopMaxInputBytes'))return null;
  const limit=capabilities.ledgetopMaxInputBytes;if(!Number.isSafeInteger(limit)||limit<1)return'provider_capacity_invalid';
  let total=0;for(const file of files||[]){const role=file.processingRole||'auto';if(!/\.(?:jpe?g|png|tiff?|dng|raw|heic)$/i.test(file.relativePath)||!['auto','image'].includes(role))continue;if(!Number.isSafeInteger(file.byteSize)||file.byteSize<0||!Number.isSafeInteger(total+file.byteSize))return'provider_capacity_invalid';total+=file.byteSize;if(total>limit)return'provider_input_limit_exceeded';}
  return null;
}
module.exports={photoLowerBoundError};
