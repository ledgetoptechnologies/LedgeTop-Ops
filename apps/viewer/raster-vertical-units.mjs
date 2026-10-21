const codes={9001:1,9002:0.3048,9003:1200/3937};
const unitFactors=new Map([
  ...['m','meter','meters','metre','metres'].map(unit=>[unit,1]),
  ...['ft','foot','feet','internationalfoot','internationalfeet'].map(unit=>[unit,.3048]),
  ...['usft','ftus','footus','ussurveyfoot','ussurveyfeet'].map(unit=>[unit,1200/3937]),
  ...['cm','centimeter','centimeters','centimetre','centimetres'].map(unit=>[unit,.01]),
  ...['mm','millimeter','millimeters','millimetre','millimetres'].map(unit=>[unit,.001]),
  ...['km','kilometer','kilometers','kilometre','kilometres'].map(unit=>[unit,1000]),
]);
function fail(code,message){throw Object.assign(new Error(message),{code});}
const metadataInvalid=()=>fail('measurement_source_vertical_metadata_invalid','Elevation band metadata is ambiguous or invalid. Verify the source before calculation.');
const identityTransform=(name,value)=>{
  const expected=name==='SCALE'?1:0;
  if((typeof value!=='string'&&typeof value!=='number')||!/^[-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[-+]?\d+)?$/i.test(String(value).trim())||!Number.isFinite(Number(value))||Number(value)!==expected)fail('measurement_source_value_transform_unsupported','The elevation band has a nonidentity or invalid scale/offset. Convert the source to physical elevations before calculation.');
};
function inspectRawBandMetadata(xml){
  if(typeof xml!=='string'||xml.length>1024*1024)metadataInvalid();
  const normalized=xml.replace(/\0+$/,'').trim().replace(/^<\?xml\s+version=(["'])1\.0\1(?:\s+encoding=(["'])(?:UTF-8|utf-8)\2)?\s*\?>\s*/,'');
  const root=normalized.match(/^<GDALMetadata>\s*([\s\S]*?)\s*<\/GDALMetadata>$/);
  if(!root)metadataInvalid();
  const content=root[1],declarations=Object.create(null);let items=0,end=0;
  // GDAL_METADATA is a bounded flat Item list, not a general XML document.
  // Inspect declarations before GeoTIFF's dictionary overwrites duplicate names.
  for(const match of content.matchAll(/<Item\b([^>]*)>([^<]*)<\/Item\s*>/g)){
    if(++items>4096)metadataInvalid();
    if(content.slice(end,match.index).trim())metadataInvalid();end=match.index+match[0].length;
    const attributes=Object.create(null);let attributeEnd=0;
    for(const a of match[1].matchAll(/([A-Za-z_:][\w:.-]*)\s*=\s*(["'])([^<]*?)\2/g)){
      if(match[1].slice(attributeEnd,a.index).trim()||Object.hasOwn(attributes,a[1]))metadataInvalid();attributeEnd=a.index+a[0].length;attributes[a[1]]=a[3];
    }
    if(match[1].slice(attributeEnd).trim())metadataInvalid();
    if(attributes.sample!==undefined&&!/^\d+$/.test(attributes.sample))metadataInvalid();
    if(attributes.sample===undefined||Number(attributes.sample)!==0)continue;
    const name=String(attributes.name||'').toUpperCase(),role=String(attributes.role||'').toLowerCase(),roleName=({unittype:'UNITTYPE',scale:'SCALE',offset:'OFFSET'})[role];
    const meaningful=['UNITTYPE','SCALE','OFFSET'].includes(name)?name:roleName;
    if(!meaningful)continue;
    if(roleName&&roleName!==meaningful)metadataInvalid();
    if(Object.hasOwn(declarations,meaningful))fail('measurement_source_vertical_units_conflict','Duplicate elevation band unit/scale declarations are ambiguous. Verify the source metadata.');
    declarations[meaningful]=match[2];
    if(meaningful==='SCALE'||meaningful==='OFFSET')identityTransform(meaningful,match[2]);
  }
  if(content.slice(end).trim())metadataInvalid();
  return declarations;
}
export async function readRasterBandMetadata(image){
  if(typeof image.getGDALMetadata!=='function')return null;
  try{
    const directory=image.getFileDirectory?.()||image.fileDirectory;
    const hasRaw=directory?.hasTag?.('GDAL_METADATA')||directory?.GDAL_METADATA!==undefined;
    const raw=hasRaw?(typeof directory.loadValue==='function'?await directory.loadValue('GDAL_METADATA'):directory.GDAL_METADATA):undefined;
    const declarations=raw===undefined?null:inspectRawBandMetadata(raw),flattened=await image.getGDALMetadata(0);
    // Role-tagged declarations are GDAL's physical band semantics. Preserve them
    // even if an item uses a different name from the conventional UNITTYPE.
    return declarations?{...flattened,...declarations}:flattened;
  }catch(error){if(error?.code)throw error;metadataInvalid();}
}

// GDAL's band-0 UNITTYPE is explicit value-unit metadata, independent of the
// horizontal CRS. Dataset-level metadata is deliberately never passed here.
export function resolveRasterVerticalUnits(image,{bandMetadata=null,confirmMeters=false,confirmationBasis='administrator-declared'}={}){
  for(const [name,value]of Object.entries(bandMetadata||{})){const key=name.toUpperCase();if(key==='SCALE'||key==='OFFSET')identityTransform(key,value);}
  const key=image.getGeoKeys?.()?.VerticalUnitsGeoKey;
  const encoded=key!==undefined&&key!==null;
  const keyFactor=encoded?codes[Number(key)]:null;
  if(encoded&&!keyFactor)fail('measurement_source_vertical_units_unsupported','The encoded vertical units are unsupported. Correct the source metadata before calculation.');
  const declared=Object.entries(bandMetadata||{}).filter(([name])=>name.toUpperCase()==='UNITTYPE').map(([,value])=>value);
  let bandFactor=null;
  for(const value of declared){
    if(typeof value!=='string'||value.length>80)fail('measurement_source_vertical_units_unsupported','The elevation band units are unsupported. Correct the source metadata before calculation.');
    const normalized=value.trim().toLowerCase().replace(/[\s_-]/g,'');
    // GDAL may store an empty UNITTYPE for unknown units. It is absence, not m.
    if(!normalized)continue;
    const factor=unitFactors.get(normalized);
    if(!factor)fail('measurement_source_vertical_units_unsupported','The elevation band units are unsupported. Correct the source metadata before calculation.');
    if(bandFactor!==null&&factor!==bandFactor)fail('measurement_source_vertical_units_conflict','Elevation band unit declarations conflict. Verify the source metadata.');
    bandFactor=factor;
  }
  if(bandFactor!==null&&Number(image.getSamplesPerPixel?.()||1)!==1)fail('measurement_source_vertical_units_unsupported','Elevation calculation requires a single-band DEM with explicit units.');
  if(keyFactor!==null&&bandFactor!==null&&keyFactor!==bandFactor)fail('measurement_source_vertical_units_conflict','Vertical CRS units and elevation band units conflict. Verify the source metadata.');
  if(keyFactor!==null)return{verticalFactor:keyFactor,verticalUnitBasis:'raster-metadata'};
  if(bandFactor!==null)return{verticalFactor:bandFactor,verticalUnitBasis:'gdal-band-unit'};
  if(confirmMeters){
    // Legacy browser callers translate administrator-declared to user-declared.
    // New server callers supply requester-declared unless separate staff
    // authority actually established who made the declaration. Neither is
    // equivalent to elevation units encoded or independently verified in data.
    if(!['administrator-declared','requester-declared'].includes(confirmationBasis))metadataInvalid();
    return{verticalFactor:1,verticalUnitBasis:confirmationBasis};
  }
  fail('measurement_source_vertical_units_required','Confirm source elevations are meters only after verifying them; the raster does not encode elevation units.');
}
