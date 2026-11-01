'use strict';
// Bounded test-candidate response parser; this is not a general JSON contract.
const invalid=()=>{throw Object.assign(new Error('native binding response is invalid'),{code:'native_binding_hold'});};
function validUnicode(value){for(let i=0;i<value.length;i++){const c=value.charCodeAt(i);if(c>=0xd800&&c<=0xdbff){const next=value.charCodeAt(++i);if(!(next>=0xdc00&&next<=0xdfff))return false;}else if(c>=0xdc00&&c<=0xdfff)return false;}return true;}
function parse(bytes){try{
  if(!Buffer.isBuffer(bytes)||bytes.length>65536)invalid();
  const text=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes);let i=0;
  const token=/(?:true|false|null|-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?)/y;
  const ws=()=>{while(i<text.length&&/[ \t\r\n]/.test(text[i]))i++;};
  function string(){if(text[i++]!=='"')invalid();const start=i-1;let escaped=false;while(i<text.length){const c=text[i++];if(escaped){escaped=false;continue;}if(c==='\\'){escaped=true;continue;}if(c==='"'){const decoded=JSON.parse(text.slice(start,i));if(!validUnicode(decoded))invalid();return decoded;}if(c.charCodeAt(0)<32)invalid();}invalid();}
  function value(depth){if(depth>32)invalid();ws();if(text[i]==='"'){string();return;}if(text[i]==='{'){i++;ws();const keys=new Set();if(text[i]==='}'){i++;return;}for(;;){ws();const key=string();if(keys.has(key))invalid();keys.add(key);ws();if(text[i++]!==':')invalid();value(depth+1);ws();const delimiter=text[i++];if(delimiter==='}')return;if(delimiter!==',')invalid();}}if(text[i]==='['){i++;ws();if(text[i]===']'){i++;return;}for(;;){value(depth+1);ws();const delimiter=text[i++];if(delimiter===']')return;if(delimiter!==',')invalid();}}token.lastIndex=i;const match=token.exec(text);if(!match)invalid();if(!['true','false','null'].includes(match[0])){if(!/^(?:0|[1-9][0-9]*)$/.test(match[0])||!Number.isSafeInteger(Number(match[0])))invalid();}i=token.lastIndex;}
  value(0);ws();if(i!==text.length)invalid();return JSON.parse(text);
}catch{invalid();}}
module.exports={parse};
