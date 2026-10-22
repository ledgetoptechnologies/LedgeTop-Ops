import {integrateSurfaceVolume,createReference} from './measurement-volume.mjs';
import {pointInPolygon} from './map-volume.mjs';
self.onmessage=event=>{
  try{
    const options=event.data,{vertices,reference,values,width,height,bounds,nodata}=options;
    const result=integrateSurfaceVolume(options),base=createReference(vertices,reference),samples=[];
    const px=(bounds.maxE-bounds.minE)/width,py=(bounds.maxN-bounds.minN)/height,stride=Math.max(1,Math.ceil(Math.sqrt(width*height/1500)));
    for(let y=0;y<height;y+=stride)for(let x=0;x<width;x+=stride){const e=bounds.minE+(x+.5)*px,n=bounds.maxN-(y+.5)*py,z=values[y*width+x],b=base.sample(e,n);if(pointInPolygon(e,n,vertices)&&Number.isFinite(z)&&z!==nodata&&Number.isFinite(b))samples.push([e,n,z,b]);}
    const referencePatches=base.patches.map(p=>p.polygon.map(v=>[v[0],v[1],p.sample(v[0],v[1])]));
    self.postMessage({ok:true,result:{...result,preview:{samples,referencePatches}}});
  }catch(error){self.postMessage({ok:false,error:String(error.message||'Surface calculation failed.')});}
};
