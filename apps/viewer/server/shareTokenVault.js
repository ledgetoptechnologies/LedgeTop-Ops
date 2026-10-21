'use strict';
const crypto=require('node:crypto');
const {config}=require('./config');
function key(){return crypto.hkdfSync('sha256',Buffer.from(config.sessionSecret),Buffer.alloc(0),Buffer.from('ltds-public-share-token-encryption-v1'),32);}
function seal(token,hash){const iv=crypto.randomBytes(12),cipher=crypto.createCipheriv('aes-256-gcm',key(),iv);cipher.setAAD(Buffer.from(hash));const encrypted=Buffer.concat([cipher.update(token,'utf8'),cipher.final()]);return ['v1',iv.toString('base64url'),cipher.getAuthTag().toString('base64url'),encrypted.toString('base64url')].join('.');}
function open(value,hash){try{const [version,iv,tag,body]=String(value).split('.');if(version!=='v1')return null;const decipher=crypto.createDecipheriv('aes-256-gcm',key(),Buffer.from(iv,'base64url'));decipher.setAAD(Buffer.from(hash));decipher.setAuthTag(Buffer.from(tag,'base64url'));const token=Buffer.concat([decipher.update(Buffer.from(body,'base64url')),decipher.final()]).toString('utf8');return crypto.createHash('sha256').update(token).digest('hex')===hash?token:null;}catch{return null;}}
module.exports={seal,open};
