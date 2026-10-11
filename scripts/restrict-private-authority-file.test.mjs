import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const script=path.resolve(import.meta.dirname,"restrict-private-authority-file.ps1");
const encoded = command => Buffer.from(command,"utf16le").toString("base64");
const psQuote = value => `'${value.replaceAll("'","''")}'`;
const powershell = command => spawnSync("powershell.exe",["-NoProfile","-ExecutionPolicy","RemoteSigned","-EncodedCommand",encoded(command)],{windowsHide:true,encoding:"utf8",stdio:["ignore","pipe","pipe"]});

test("an exact private ACL returns before Set-Acl while a non-private ACL does not",{skip:process.platform!=="win32"},()=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),"private-acl-idempotence-")),privateFile=path.join(directory,"private.txt"),ordinaryFile=path.join(directory,"ordinary.txt");
  try{
    fs.writeFileSync(privateFile,"");fs.writeFileSync(ordinaryFile,"");
    const initial=powershell(`& ${psQuote(script)} -LiteralFile ${psQuote(privateFile)}`);
    assert.equal(initial.status,0,"test setup must establish the reviewed private ACL");
    const guarded=`function Set-Acl { throw 'SET_ACL_CALLED' }; & ${psQuote(script)} -LiteralFile ${psQuote(privateFile)}`;
    const repeated=powershell(guarded);
    assert.equal(repeated.status,0,"an exact private ACL must not be mutated");
    assert(!`${repeated.stdout}${repeated.stderr}`.includes("SET_ACL_CALLED"));
    const rejected=powershell(`function Set-Acl { throw 'SET_ACL_CALLED' }; & ${psQuote(script)} -LiteralFile ${psQuote(ordinaryFile)}`);
    assert.notEqual(rejected.status,0,"a non-private ACL must continue through restrictive setup");
    assert(`${rejected.stdout}${rejected.stderr}`.includes("SET_ACL_CALLED"));
  }finally{fs.rmSync(directory,{recursive:true,force:true});}
});
