export function isFrameableOperationsPdfRequest(method:string,path:string):boolean{
  return(method==="GET"||method==="HEAD")&&/^\/api\/delivery\/items\/[^/]+\/pdf$/.test(path);
}
