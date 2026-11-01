'use strict';
// Unwired credential-binding experiment; callers must supply real trusted stores and TLS transport.
const hold=()=>Object.assign(new Error('native provider authentication requires review'),{code:'native_provider_auth_hold'});
const closed=(value,keys)=>value&&Object.getPrototypeOf(value)===Object.prototype&&Object.keys(value).sort().join('|')===[...keys].sort().join('|');
function checked(value,environment){
  if(!closed(value,['environment','origin','secretRef','revision'])||value.environment!==environment||!['staging','production'].includes(environment)||typeof value.origin!=='string'||typeof value.secretRef!=='string'||!/^[A-Za-z0-9][A-Za-z0-9_./:-]{0,255}$/.test(value.secretRef)||!Number.isSafeInteger(value.revision)||value.revision<1)throw hold();let url;try{url=new URL(value.origin);}catch{throw hold();}if(url.protocol!=='https:'||url.username||url.password||url.pathname!=='/'||url.search||url.hash||url.origin!==value.origin)throw hold();return{environment,origin:url.origin,secretRef:value.secretRef,revision:value.revision};
}
async function withCredential({environment,loadConfiguration,authorizeConfiguration,resolveSecret,invoke,enabled=false}){
  if(enabled!==true||typeof loadConfiguration!=='function'||typeof authorizeConfiguration!=='function'||typeof resolveSecret!=='function'||typeof invoke!=='function')throw hold();const first=checked(await loadConfiguration(),environment),snapshot=JSON.stringify(first);const authorization=JSON.parse(snapshot);if(authorizeConfiguration(authorization)!==true||JSON.stringify(authorization)!==snapshot)throw hold();const resolved=await resolveSecret(first.secretRef,first.revision);if(!closed(resolved,['revision','token'])||resolved.revision!==first.revision||typeof resolved.token!=='string'||!/^[\x21-\x7e]{16,4096}$/.test(resolved.token))throw hold();const current=checked(await loadConfiguration(),environment);if(JSON.stringify(current)!==snapshot)throw hold();return invoke({origin:first.origin,environment,revision:first.revision,token:resolved.token});
}
module.exports={withCredential};
