// Deliberately recognizes only the WGS84 UTM horizontal frames already supported
// by point-surface calculation. This is not a general WKT transformer, and its
// metre checks concern X/Y only: callers must verify Z units independently.
const fail=()=>{throw Object.assign(new Error('measurement_source_crs_mismatch'),{code:'measurement_source_crs_mismatch'});};
const norm=value=>typeof value==='string'?value.toLowerCase().replace(/[\s_-]/g,''):'';
const near=(value,expected)=>typeof value==='number'&&Number.isFinite(value)&&Math.abs(value-expected)<=Math.max(1,Math.abs(expected))*1e-12;
const node=value=>value&&typeof value==='object'&&typeof value.tag==='string';

function parseWkt(text){
  if(typeof text!=='string'||!text.trim()||text.length>32768)fail();
  let at=0,count=0;
  const space=()=>{while(/\s/.test(text[at]||'')&&at<text.length)at++;};
  function value(depth=0){
    if(depth>24||++count>2048)fail();space();
    if(text[at]==='"'){
      at++;let result='';while(at<text.length){if(text[at]==='"'){at++;if(text[at]==='"'){result+='"';at++;}else return result;}else result+=text[at++];}fail();
    }
    const number=text.slice(at).match(/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?/);
    if(number){at+=number[0].length;const result=Number(number[0]);if(!Number.isFinite(result))fail();return result;}
    const identifier=text.slice(at).match(/^[A-Za-z_][A-Za-z_0-9]*/);if(!identifier)fail();at+=identifier[0].length;space();
    if(text[at]!=='[')return{symbol:identifier[0].toUpperCase()};
    at++;const args=[];space();if(text[at]===']')fail();
    for(;;){args.push(value(depth+1));space();if(text[at]===']'){at++;break;}if(text[at++]!==',')fail();}
    return{tag:identifier[0].toUpperCase(),args};
  }
  const result=value();space();if(at!==text.length||!node(result))fail();return result;
}
const children=(parent,tag)=>parent.args.filter(v=>node(v)&&v.tag===tag);
function one(parent,tag,required=true){const found=children(parent,tag);if(found.length>1||(!found.length&&required))fail();return found[0];}
function shape(parent,scalarCount,allowed){if(parent.args.length<scalarCount||parent.args.slice(0,scalarCount).some(node)||parent.args.slice(scalarCount).some(v=>!node(v)||!allowed.includes(v.tag)))fail();}
function authority(parent,expected){const codes=(Array.isArray(expected)?expected:[expected]).map(String);for(const tag of ['AUTHORITY','ID']){const item=one(parent,tag,false);if(item){if(item.args.length!==2||norm(item.args[0])!=='epsg'||!codes.includes(String(item.args[1])))fail();}}}
function unit(value,type){
  if(!value)fail();shape(value,2,['AUTHORITY','ID']);
  // EPSG uses 9102 for angular parameters and 9122 for axis degrees; both
  // require the same decimal-degree factor, never an authority-only shortcut.
  const spec=type==='angle'?{names:['degree','degrees'],factor:Math.PI/180,code:[9102,9122]}:type==='scale'?{names:['unity'],factor:1,code:9201}:{names:['metre','meter','metres','meters'],factor:1,code:9001};
  if(!spec.names.includes(norm(value.args[0]))||!near(value.args[1],spec.factor))fail();authority(value,spec.code);
}
function geographic(root,wkt2){
  shape(root,1,wkt2?['DATUM','ENSEMBLE','PRIMEM','ID','ANGLEUNIT']:['DATUM','PRIMEM','UNIT','AXIS','AUTHORITY']);authority(root,4326);
  const datum=one(root,'DATUM',false),ensemble=wkt2?one(root,'ENSEMBLE',false):null;if(Boolean(datum)===Boolean(ensemble))fail();
  if(datum){
    shape(datum,1,[wkt2?'ELLIPSOID':'SPHEROID','AUTHORITY','ID',...(!wkt2?['TOWGS84']:[])]);
    if(!['wgs1984','worldgeodeticsystem1984'].includes(norm(datum.args[0])))fail();authority(datum,6326);
    const shift=one(datum,'TOWGS84',false);if(shift&&(![3,7].includes(shift.args.length)||shift.args.some(v=>typeof v!=='number'||!Number.isFinite(v)||v!==0)))fail();
  }else validateEnsemble(ensemble);
  const ellipsoid=one(datum||ensemble,wkt2?'ELLIPSOID':'SPHEROID');shape(ellipsoid,3,['AUTHORITY','ID',...(wkt2?['LENGTHUNIT']:[])]);
  if(norm(ellipsoid.args[0])!=='wgs84'||!near(ellipsoid.args[1],6378137)||!near(ellipsoid.args[2],298.257223563))fail();authority(ellipsoid,7030);
  if(wkt2)unit(one(ellipsoid,'LENGTHUNIT'),'length');
  // WKT2 permits omitted international reference meridian (OGC 12-063r5
  // section 8.2.2). Only reach this default after establishing WGS84 above.
  const prime=one(root,'PRIMEM',!wkt2);
  if(prime){shape(prime,2,['AUTHORITY','ID',...(wkt2?['ANGLEUNIT']:[])]);if(norm(prime.args[0])!=='greenwich'||!near(prime.args[1],0))fail();authority(prime,8901);if(wkt2)unit(one(prime,'ANGLEUNIT'),'angle');}
  if(wkt2){const angular=one(root,'ANGLEUNIT',false);if(angular)unit(angular,'angle');}
  else unit(one(root,'UNIT'),'angle');
}
// Canonical seven-member GDAL/PROJ output and EPSG's newer eight-member
// ensemble only. Source definitions: GDAL gdalsrsinfo Example 3 and
// https://epsg.org/crs/wkt/id/32721 (member names/IDs, accuracy and ellipsoid).
const wgsMembers=[['Transit',1166],['G730',1152],['G873',1153],['G1150',1154],['G1674',1155],['G1762',1156],['G2139',1309],['G2296',1383]];
function validateEnsemble(ensemble){
  shape(ensemble,1,['MEMBER','ELLIPSOID','ENSEMBLEACCURACY','ID']);
  if(norm(ensemble.args[0])!=='worldgeodeticsystem1984ensemble')fail();authority(ensemble,6326);
  const members=children(ensemble,'MEMBER');if(![7,8].includes(members.length))fail();
  const seen=new Set();for(const member of members){shape(member,1,['ID']);const spec=wgsMembers.find(([name])=>norm(member.args[0])===norm(`World Geodetic System 1984 (${name})`));if(!spec||seen.has(spec[1]))fail();authority(member,spec[1]);seen.add(spec[1]);}
  if(wgsMembers.slice(0,members.length).some(([,code])=>!seen.has(code)))fail();
  const accuracy=one(ensemble,'ENSEMBLEACCURACY');if(accuracy.args.length!==1||accuracy.args[0]!==2)fail();
}
function descriptiveMetadata(root){
  const text=value=>value.args.length===1&&typeof value.args[0]==='string'&&value.args[0].length>0&&value.args[0].length<=4096;
  const remark=one(root,'REMARK',false);if(remark&&!text(remark))fail();
  const usage=one(root,'USAGE',false);if(!usage)return;shape(usage,0,['SCOPE','AREA','BBOX']);
  if(!text(one(usage,'SCOPE'))||!text(one(usage,'AREA')))fail();
  const bbox=one(usage,'BBOX');if(bbox.args.length!==4||bbox.args.some(v=>typeof v!=='number'||!Number.isFinite(v)))fail();
  const [south,west,north,east]=bbox.args;if(south < -90||north>90||south>north||west < -180||west>180||east < -180||east>180)fail();
}
function projectionParameters(root,wkt2){
  const conversion=wkt2?one(root,'CONVERSION'):root;
  if(wkt2)shape(conversion,1,['METHOD','PARAMETER','ID']);
  const method=one(conversion,wkt2?'METHOD':'PROJECTION');shape(method,1,['AUTHORITY','ID']);if(norm(method.args[0])!=='transversemercator')fail();authority(method,9807);
  const expected=wkt2?[
    ['latitudeofnaturalorigin',0,'ANGLEUNIT',8801],['longitudeofnaturalorigin',null,'ANGLEUNIT',8802],['scalefactoratnaturalorigin',.9996,'SCALEUNIT',8805],['falseeasting',500000,'LENGTHUNIT',8806],['falsenorthing',null,'LENGTHUNIT',8807],
  ]:[['latitudeoforigin',0],['centralmeridian',null],['scalefactor',.9996],['falseeasting',500000],['falsenorthing',null]];
  const parameters=children(conversion,'PARAMETER');if(parameters.length!==expected.length)fail();
  const found=new Map();
  for(const parameter of parameters){const key=norm(parameter.args[0]),spec=expected.find(e=>e[0]===key);if(!spec||found.has(key))fail();shape(parameter,2,wkt2?[spec[2],'ID']:[]);if(typeof parameter.args[1]!=='number'||(spec[1]!==null&&!near(parameter.args[1],spec[1])))fail();
    if(wkt2){unit(one(parameter,spec[2]),spec[2]==='ANGLEUNIT'?'angle':spec[2]==='SCALEUNIT'?'scale':'length');authority(parameter,spec[3]);}found.set(key,parameter.args[1]);
  }
  const longitude=found.get(wkt2?'longitudeofnaturalorigin':'centralmeridian'),zone=Math.round((longitude+183)/6),northing=found.get('falsenorthing');
  if(zone<1||zone>60||!near(longitude,zone*6-183)||(!near(northing,0)&&!near(northing,10000000)))fail();
  const south=near(northing,10000000);if(wkt2)authority(conversion,(south?16100:16000)+zone);
  return(south?32700:32600)+zone;
}
function wktUtmCode(text){
  const parsed=parseWkt(text);let parts;try{parts=compoundParts(parsed);}catch{fail();}
  const root=parts?.horizontal||parsed,wkt2=root.tag==='PROJCRS';if(!wkt2&&root.tag!=='PROJCS')fail();
  shape(root,1,wkt2?['BASEGEOGCRS','CONVERSION','CS','AXIS','LENGTHUNIT','ID','USAGE','REMARK']:['GEOGCS','PROJECTION','PARAMETER','UNIT','AXIS','AUTHORITY']);
  if(wkt2)descriptiveMetadata(root);
  geographic(one(root,wkt2?'BASEGEOGCRS':'GEOGCS'),wkt2);
  const code=projectionParameters(root,wkt2);authority(root,code);
  const axes=children(root,'AXIS');if(axes.length!==2)fail();
  if(wkt2){const cs=one(root,'CS');shape(cs,2,['ID']);if(cs.args[0]?.symbol!=='CARTESIAN'||cs.args[1]!==2)fail();authority(cs,4400);}
  const rootUnit=one(root,wkt2?'LENGTHUNIT':'UNIT',!wkt2);if(rootUnit)unit(rootUnit,'length');
  axes.forEach((axis,index)=>{shape(axis,2,wkt2?['ORDER','LENGTHUNIT']:[]);if(typeof axis.args[0]!=='string'||axis.args[1]?.symbol!==['EAST','NORTH'][index])fail();if(wkt2){const order=one(axis,'ORDER',false);if(order&&(order.args.length!==1||order.args[0]!==index+1))fail();const axisUnit=one(axis,'LENGTHUNIT',false);if(axisUnit)unit(axisUnit,'length');else if(!rootUnit)fail();}});
  return code;
}

// Discover the native supported horizontal code, then run the same full
// cross-declaration validation as calculations (including WKT-only sources).
export function inspectEptUtmCrs(srs){
  if(!srs||typeof srs!=='object'||Array.isArray(srs))fail();
  const candidate=Object.hasOwn(srs,'horizontal')?Number(srs.horizontal):Object.hasOwn(srs,'code')?Number(srs.code):
    Object.hasOwn(srs,'wkt')?wktUtmCode(srs.wkt):Object.hasOwn(srs,'wkt2')?wktUtmCode(srs.wkt2):null;
  return resolveEptUtmCrs(srs,candidate);
}

export function resolveEptUtmCrs(srs,expected){
  if(!Number.isInteger(expected)||!((expected>=32601&&expected<=32660)||(expected>=32701&&expected<=32760))||!srs||typeof srs!=='object'||Array.isArray(srs))fail();
  const codes=[];
  for(const key of ['horizontal','code'])if(Object.hasOwn(srs,key)){
    const value=srs[key];if(!['number','string'].includes(typeof value)||!/^\d{5}$/.test(String(value)))fail();codes.push(Number(value));
  }
  if(Object.hasOwn(srs,'authority')&&(norm(srs.authority)!=='epsg'||!codes.length))fail();
  for(const key of ['wkt','wkt2'])if(Object.hasOwn(srs,key))codes.push(wktUtmCode(srs[key]));
  if(!codes.length||codes.some(code=>code!==expected))fail();
  return expected;
}

const verticalFail=code=>{throw Object.assign(new Error(code),{code});};
const verticalInvalid=()=>verticalFail('measurement_source_vertical_metadata_invalid');
const verticalText=value=>typeof value==='string'&&value.trim().length>0;
// An EPSG identifier labels the encoded definition; it never supplies missing
// units. No registry lookup or vertical datum transformation is performed here.
function verticalIdentifier(parent,tag){
  const item=one(parent,tag,false);if(!item)return null;
  if(item.args.length!==2||norm(item.args[0])!=='epsg'||!/^\d{4,6}$/.test(String(item.args[1])))verticalInvalid();
  return Number(item.args[1]);
}
function verticalUnit(value){
  shape(value,2,['AUTHORITY','ID']);
  const specs=[{names:['metre','meter','metres','meters'],factor:1,id:9001},{names:['foot','feet','internationalfoot','internationalfeet'],factor:.3048,id:9002},{names:['ussurveyfoot','ussurveyfeet','footus'],factor:1200/3937,id:9003}];
  const spec=specs.find(item=>item.names.includes(norm(value.args[0])));
  if(!spec||!near(value.args[1],spec.factor))verticalFail('measurement_source_vertical_units_unsupported');
  for(const tag of ['AUTHORITY','ID']){const id=verticalIdentifier(value,tag);if(id!==null&&id!==spec.id)verticalFail('measurement_source_vertical_units_conflict');}
  return spec.factor;
}
function compoundParts(root){
  const wkt2=root.tag==='COMPOUNDCRS';if(!wkt2&&root.tag!=='COMPD_CS')return null;
  try{
    shape(root,1,wkt2?['PROJCRS','VERTCRS','ID','USAGE','REMARK']:['PROJCS','VERT_CS','AUTHORITY']);
    if(!verticalText(root.args[0]))verticalInvalid();
    const horizontal=one(root,wkt2?'PROJCRS':'PROJCS'),vertical=one(root,wkt2?'VERTCRS':'VERT_CS');
    // Compound coordinates must be horizontal first, then upward height.
    if(root.args[1]!==horizontal||root.args[2]!==vertical)verticalInvalid();
    verticalIdentifier(root,wkt2?'ID':'AUTHORITY');if(wkt2)descriptiveMetadata(root);
    shape(vertical,1,wkt2?['VDATUM','CS','AXIS','LENGTHUNIT','ID','USAGE','REMARK']:['VERT_DATUM','UNIT','AXIS','AUTHORITY']);
    if(!verticalText(vertical.args[0]))verticalInvalid();
    const datum=one(vertical,wkt2?'VDATUM':'VERT_DATUM');shape(datum,wkt2?1:2,[wkt2?'ID':'AUTHORITY']);
    if(!verticalText(datum.args[0])||(!wkt2&&datum.args[1]!==2005))verticalInvalid();
    verticalIdentifier(datum,wkt2?'ID':'AUTHORITY');
    const id=verticalIdentifier(vertical,wkt2?'ID':'AUTHORITY');
    if(wkt2){descriptiveMetadata(vertical);const cs=one(vertical,'CS');if(cs.args.length!==2||cs.args[0]?.symbol!=='VERTICAL'||cs.args[1]!==1)verticalInvalid();}
    const axis=one(vertical,'AXIS');shape(axis,2,wkt2?['ORDER','LENGTHUNIT']:[]);
    if(!verticalText(axis.args[0])||axis.args[1]?.symbol!=='UP')verticalInvalid();
    if(wkt2){const order=one(axis,'ORDER',false);if(order&&(order.args.length!==1||order.args[0]!==1))verticalInvalid();}
    const rootUnit=one(vertical,wkt2?'LENGTHUNIT':'UNIT',!wkt2),axisUnit=wkt2?one(axis,'LENGTHUNIT',false):null;
    if(!rootUnit&&!axisUnit)verticalFail('measurement_source_vertical_units_required');
    const factor=rootUnit?verticalUnit(rootUnit):verticalUnit(axisUnit);
    if(axisUnit&&verticalUnit(axisUnit)!==factor)verticalFail('measurement_source_vertical_units_conflict');
    return{horizontal,factor,id};
  }catch(error){if(error.code==='measurement_source_crs_mismatch')verticalInvalid();throw error;}
}

export function resolveEptVerticalUnits(srs,expected){
  if(!srs||typeof srs!=='object'||Array.isArray(srs))fail();
  const evidence=[];
  for(const key of ['wkt','wkt2'])if(Object.hasOwn(srs,key)){const parts=compoundParts(parseWkt(srs[key]));if(parts)evidence.push(parts);}
  resolveEptUtmCrs(srs,expected);
  if(!evidence.length){
    // An encoded vertical CRS is not absent metadata. Without an independently
    // supported vertical WKT we cannot interpret its units, and must not allow
    // a reviewed/default metre fallback to bypass that declaration.
    if(Object.hasOwn(srs,'vertical')){
      if(!['number','string'].includes(typeof srs.vertical)||!/^\d{4,6}$/.test(String(srs.vertical)))verticalInvalid();
      verticalFail('measurement_source_vertical_units_unsupported');
    }
    verticalFail('measurement_source_vertical_units_required');
  }
  if(evidence.some(item=>item.factor!==evidence[0].factor))verticalFail('measurement_source_vertical_units_conflict');
  const identifiers=evidence.map(item=>item.id).filter(id=>id!==null);
  if(Object.hasOwn(srs,'vertical')){
    if(!['number','string'].includes(typeof srs.vertical)||!/^\d{4,6}$/.test(String(srs.vertical)))verticalInvalid();
    // A second numeric declaration is accepted only when the explicit vertical
    // WKT also identifies that CRS, never by interpreting a horizontal unit.
    if(!identifiers.length)verticalFail('measurement_source_vertical_units_unsupported');
    identifiers.push(Number(srs.vertical));
  }
  if(identifiers.some(id=>id!==identifiers[0]))verticalFail('measurement_source_vertical_units_conflict');
  return{verticalFactor:evidence[0].factor,verticalUnitBasis:'ept-vertical-crs',verticalUnit:'m',verticalDatum:'unknown'};
}
