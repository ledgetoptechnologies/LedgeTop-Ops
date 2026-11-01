'use strict';
const path=require('node:path'),{DatabaseSync}=require('node:sqlite');
const {ProcessingRepository}=require('../../server/processingRepository'),{ViewerRepository}=require('../../server/repository'),{StorageManager}=require('../../server/storageManager'),{processOne}=require('../../server/processingWorker');
const root=process.argv[2],config={datasetsMount:path.join(root,'datasets'),modelsMount:path.join(root,'models'),cacheMount:path.join(root,'cache'),trashMount:path.join(root,'trash'),storageReserveBytes:0,storageReservePercent:0,meshDerivativesEnabled:false,processingProviderTransferTimeoutMs:5000,opsBaseUrl:'https://ops.example.test'};
const db=new DatabaseSync(path.join(root,'state.sqlite'));db.exec('PRAGMA foreign_keys=ON');const processing=new ProcessingRepository(db),repository=new ViewerRepository(db),storage=new StorageManager(config);storage.initialize();
processOne({processing,repository,storage,config,providerCredentials:{resolve:()=>''}},`worker-${process.pid}`).then(()=>db.close()).catch(error=>{console.error(error);db.close();process.exitCode=1;});
