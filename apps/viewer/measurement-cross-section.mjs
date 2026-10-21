// Reduced calculation samples, not a native-resolution transect. Never connect
// samples: neither their spacing nor the absence of NoData between them is known.
export function buildSampledCrossSection(samples,{azimuth=0,offset=0,width=1}={}){
  if(!Array.isArray(samples)||samples.length>20_000)throw new Error('Section samples exceed the safe display limit.');
  if(![azimuth,offset,width].every(Number.isFinite)||width<=0)throw new Error('A finite section direction, offset and positive width are required.');
  if(!samples.every(p=>Array.isArray(p)&&p.length===4&&p.every(v=>typeof v==='number'&&Number.isFinite(v)&&Math.abs(v)<=1e9)))throw new Error('Invalid section samples.');
  if(!samples.length)return{points:[],extent:[0,0],crossExtent:[0,0],center:[0,0],width,offset};
  const min=[Infinity,Infinity],max=[-Infinity,-Infinity];
  for(const p of samples)for(let i=0;i<2;i++){min[i]=Math.min(min[i],p[i]);max[i]=Math.max(max[i],p[i]);}
  const center=min.map((v,i)=>(v+max[i])/2),angle=azimuth*Math.PI/180,c=Math.cos(angle),s=Math.sin(angle);
  let lo=Infinity,hi=-Infinity,crossLo=Infinity,crossHi=-Infinity;
  const projected=samples.map((p,index)=>{const x=p[0]-center[0],y=p[1]-center[1],station=x*c+y*s,cross=-x*s+y*c;lo=Math.min(lo,station);hi=Math.max(hi,station);crossLo=Math.min(crossLo,cross);crossHi=Math.max(crossHi,cross);return{index,x:p[0],y:p[1],station,cross,elevation:p[2],base:p[3],difference:p[2]-p[3]};});
  const points=projected.filter(p=>Math.abs(p.cross-offset)<=width/2+1e-9).sort((a,b)=>a.station-b.station||a.cross-b.cross||a.index-b.index);
  for(const p of projected)p.distance=p.station-lo;
  return{points,projected,extent:[lo,hi],crossExtent:[crossLo,crossHi],center,width,offset,azimuth};
}

export function nearestSectionSample(section,distance,{tolerance=Infinity,elevation=null,verticalTolerance=Infinity}={}){
  if(!Number.isFinite(distance)||tolerance<0)return null;
  let nearest=null,score=Infinity;
  for(const p of section.points){const dx=Math.abs(p.distance-distance),dy=Number.isFinite(elevation)?Math.abs(p.elevation-elevation):0;
    if(dx>tolerance||dy>verticalTolerance)continue;
    const candidate=(Number.isFinite(tolerance)?dx/Math.max(tolerance,1e-12):dx)**2+(Number.isFinite(verticalTolerance)?dy/Math.max(verticalTolerance,1e-12):0)**2;
    if(candidate<score){nearest=p;score=candidate;}
  }
  return nearest;
}

// The first view starts on an observed sample row rather than an empty gap
// between reduced rows. Only initialization uses this; user-selected empty
// corridors remain empty and visible as such.
export function initialSectionOffsetPercent(section){
  const [lo,hi]=section.crossExtent,mid=(lo+hi)/2,span=hi-lo;
  if(!section.projected?.length||span<=1e-9)return 0;
  let closest=section.projected[0];
  for(const point of section.projected)if(Math.abs(point.cross-mid)<Math.abs(closest.cross-mid))closest=point;
  return Math.max(-100,Math.min(100,(closest.cross-mid)*200/span));
}
