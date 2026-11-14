'use strict';
// Measured isolated PROOF runtime only. This is not a calibration approval,
// installed Viewer application revision, registry entry or readiness decision.
// E is mounted separately; the image retains its recorded base application.
const RECOVERY_RUNTIME=Object.freeze({
  sourceCommit:'0e18f938a157f882057fcbd3b040e5f0ed71ae10',
  imageId:'sha256:da9e7511f54142947a3cf72e0078d4409cf3f3c144308fa20d91207ddf449637',
  nodeVersion:'v24.22.3',nodeAbi:'137',pythonVersion:'3.11.2',gdalVersion:'3.6.2',
  converterBinarySha256:'f5b9987ea5339c4419af6298d2aee7137eea24f7d432945eed93c41fa28b5d46',
  basisJavascriptSha256:'8478b5b6d6b74e7d3082b89f6417321d8d1dc0307f2b30d4484bb11b441696a1',
  basisWasmSha256:'6cf17dc889352c42e9acf8897107978d127005fe3386c36a0e3845e27967630a',
});
module.exports={RECOVERY_RUNTIME};
