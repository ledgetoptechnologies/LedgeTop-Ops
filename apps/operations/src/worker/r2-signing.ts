const encoder = new TextEncoder();

function awsEncode(value:string):string{return encodeURIComponent(value).replace(/[!'()*]/g,character=>`%${character.charCodeAt(0).toString(16).toUpperCase()}`);}
function hex(bytes:ArrayBuffer):string{return[...new Uint8Array(bytes)].map(value=>value.toString(16).padStart(2,"0")).join("");}
async function digest(value:string):Promise<string>{return hex(await crypto.subtle.digest("SHA-256",encoder.encode(value)));}
async function hmac(secret:string|Uint8Array,value:string):Promise<ArrayBuffer>{const bytes=typeof secret==="string"?encoder.encode(secret):secret;const raw=bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength) as ArrayBuffer;const key=await crypto.subtle.importKey("raw",raw,{name:"HMAC",hash:"SHA-256"},false,["sign"]);return crypto.subtle.sign("HMAC",key,encoder.encode(value));}
async function signingKey(secret:string,date:string):Promise<Uint8Array>{const dateKey=new Uint8Array(await hmac(`AWS4${secret}`,date));const regionKey=new Uint8Array(await hmac(dateKey,"auto"));const serviceKey=new Uint8Array(await hmac(regionKey,"s3"));return new Uint8Array(await hmac(serviceKey,"aws4_request"));}

export async function presignOperationsR2Part(input:{accountId:string;bucket:string;key:string;uploadId:string;partNumber:number;accessKeyId:string;secretAccessKey:string;expiresSeconds?:number;now?:Date}):Promise<string>{
  if(!/^[a-f0-9]{32}$/i.test(input.accountId)||!input.bucket||!input.accessKeyId||!input.secretAccessKey)throw new Error("R2 upload signing is not configured");
  if(!Number.isInteger(input.partNumber)||input.partNumber<1||input.partNumber>10_000)throw new Error("Invalid multipart part number");
  const expires=Math.min(900,Math.max(30,input.expiresSeconds??300));const now=input.now??new Date();const timestamp=now.toISOString().replace(/[:-]|\.\d{3}/g,""),date=timestamp.slice(0,8);
  const host=`${input.accountId}.r2.cloudflarestorage.com`,path=`/${awsEncode(input.bucket)}/${input.key.split("/").map(awsEncode).join("/")}`,scope=`${date}/auto/s3/aws4_request`;
  const parameters=new Map<string,string>([["X-Amz-Algorithm","AWS4-HMAC-SHA256"],["X-Amz-Content-Sha256","UNSIGNED-PAYLOAD"],["X-Amz-Credential",`${input.accessKeyId}/${scope}`],["X-Amz-Date",timestamp],["X-Amz-Expires",String(expires)],["X-Amz-SignedHeaders","host"],["partNumber",String(input.partNumber)],["uploadId",input.uploadId]]);
  const query=[...parameters].map(([key,value])=>[awsEncode(key),awsEncode(value)] as const).sort(([ak,av],[bk,bv])=>ak<bk?-1:ak>bk?1:av<bv?-1:av>bv?1:0).map(([key,value])=>`${key}=${value}`).join("&");
  const canonical=`PUT\n${path}\n${query}\nhost:${host}\n\nhost\nUNSIGNED-PAYLOAD`,stringToSign=`AWS4-HMAC-SHA256\n${timestamp}\n${scope}\n${await digest(canonical)}`,signature=hex(await hmac(await signingKey(input.secretAccessKey,date),stringToSign));
  return`https://${host}${path}?${query}&X-Amz-Signature=${signature}`;
}
