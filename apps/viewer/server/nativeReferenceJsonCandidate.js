'use strict';
// Bounded, duplicate-key rejecting response parser; not a transport trust boundary.
function parseResponse(text){
  if(typeof text!=='string'||Buffer.byteLength(text,'utf8')>65536)throw new Error('native response hold');let i=0;const ws=()=>{while(i<text.length&&/[\x20\x09\x0a\x0d]/.test(text[i]))i++;},fail=()=>{throw new Error('native response hold');};
  function string(){if(text[i++]!=='"')fail();const start=i-1;while(i<text.length){const c=text[i++];if(c==='"'){try{return JSON.parse(text.slice(start,i));}catch{fail();}}if(c==='\\'){if(i>=text.length)fail();if(text[i++]==='u')i+=4;}else if(c.charCodeAt(0)<32)fail();}fail();}
  function value(depth,keyPath){if(depth>64)fail();ws();const c=text[i];if(c==='"'){string();return;}if(c==='{'){i++;ws();const seen=new Set();if(text[i]==='}'){i++;return;}for(;;){ws();if(text[i]!=='"')fail();const key=string();if(seen.has(key))fail();seen.add(key);ws();if(text[i++]!==':')fail();value(depth+1,[...keyPath,key]);ws();if(text[i]==='}'){i++;return;}if(text[i++]!==',')fail();}}if(c==='['){i++;ws();if(text[i]===']'){i++;return;}for(;;){value(depth+1,[...keyPath,null]);ws();if(text[i]===']'){i++;return;}if(text[i++]!==',')fail();}}const m=/^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(text.slice(i));if(!m)fail();if(keyPath.length===2&&keyPath[0]==='job'&&keyPath[1]==='generation'&&(!/^(?:0|[1-9]\d*)$/.test(m[0])||!Number.isSafeInteger(Number(m[0]))))fail();i+=m[0].length;}
  value(0,[]);ws();if(i!==text.length)fail();try{return JSON.parse(text);}catch{fail();}
}
module.exports={parseResponse};
