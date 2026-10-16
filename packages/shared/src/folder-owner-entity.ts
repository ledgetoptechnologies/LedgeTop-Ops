/** A stored client scope may refer to the workspace's exact standalone root.
 * No alias directory record is created and no other client/root is matched. */
export function folderOwnerEntityType<T extends string>(ownerType:T,ownerPublicId:string,rootType:string,rootPublicId:string):T|'standalone_client'{
  return ownerType==='client'&&rootType==='standalone_client'&&ownerPublicId===rootPublicId?'standalone_client':ownerType;
}
export function folderOwnerEntityTypeSql(ownerType:string,ownerId:string,rootType:string,rootId:string):string{
  return `(CASE WHEN ${ownerType}='client' AND ${rootType}='standalone_client' AND ${ownerId}=${rootId} THEN 'standalone_client' ELSE ${ownerType} END)`;
}
export function addExactStandaloneClientScope(scopes:Set<string>,rootType:string,rootId:string,versions?:Map<string,string>):void{
  const root=`standalone_client:${rootId}`;
  if(rootType!=='standalone_client'||!scopes.has(root))return;
  scopes.add(`client:${rootId}`);
  const version=versions?.get(root);if(version!==undefined)versions!.set(`client:${rootId}`,version);
}
