'use strict';
const {DatabaseSync}=require('node:sqlite'),path=require('node:path'),db=new DatabaseSync(path.join(process.argv[2],'viewer.sqlite'));
try{db.prepare("UPDATE processing_attempts SET status='cancelled' WHERE id=?").run(process.argv[3]);db.close();process.exitCode=0;}catch(error){db.close();process.exitCode=/native operation unresolved/.test(error.message)?73:1;}
