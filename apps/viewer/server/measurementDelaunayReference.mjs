import Delaunator from 'delaunator';
import { validatePolygon, triangulatePolygon, polygonArea, clipHalfPlane } from '../measurement-volume.mjs';

const cross = (a,b,p) => (b[0]-a[0])*(p[1]-a[1])-(b[1]-a[1])*(p[0]-a[0]);
const fail = () => { throw Object.assign(new Error('Reference triangulation exceeds supported geometry.'), {code:'measurement_reference_invalid'}); };

// Server native-raster reference only. Delaunay interpolates the original
// boundary elevations in projected coordinates, not rounded pixel indices.
// Intersecting with the polygon excludes concave notches without extrapolating
// a new plane or letting convex-hull area leak into reported quantities.
export function createDelaunayReference(vertices, settings = {}) {
  const points=validatePolygon(vertices), offsetM=settings.offsetM??0;
  if (points.some(p=>!Number.isFinite(p[2])) || !Number.isFinite(offsetM)) fail();
  const convex=points.every((p,i)=>cross(p,points[(i+1)%points.length],points[(i+2)%points.length])>=0);
  const boundaryParts=convex?null:triangulatePolygon(points);
  const indices=Delaunator.from(points).triangles, patches=[];
  for(let i=0;i<indices.length;i+=3){
    let triangle=[points[indices[i]],points[indices[i+1]],points[indices[i+2]]];
    if(polygonArea(triangle)<0)triangle.reverse();
    const [a,b,c]=triangle, determinant=cross(a,b,c);
    if(!(determinant>1e-10))continue;
    const gx=((b[2]-a[2])*(c[1]-a[1])-(c[2]-a[2])*(b[1]-a[1]))/determinant;
    const gy=((b[0]-a[0])*(c[2]-a[2])-(c[0]-a[0])*(b[2]-a[2]))/determinant;
    const sample=(x,y)=>a[2]+gx*(x-a[0])+gy*(y-a[1])+offsetM;
    const pieces=boundaryParts?boundaryParts.map(part=>{
      let clipped=triangle;
      for(let j=0;j<3&&clipped.length;j++)clipped=clipHalfPlane(clipped,p=>cross(part[j],part[(j+1)%3],p));
      return clipped;
    }):[triangle];
    for(const piece of pieces)for(let j=1;j+1<piece.length;j++){
      const polygon=[piece[0],piece[j],piece[j+1]];
      if(polygonArea(polygon)>1e-10)patches.push({polygon:polygon.map(p=>[p[0],p[1],sample(p[0],p[1])-offsetM]),sample});
      if(patches.length>254)fail();
    }
  }
  if(!patches.length)fail();
  return {type:'boundary-triangulated',offsetM,patches,
    numericalModel:'native-cell-constant surface; fractional boundary cells; Delaunay piecewise-linear boundary reference',
    sample:(x,y)=>{const p=[x,y],patch=patches.find(({polygon})=>polygon.every((a,i)=>cross(a,polygon[(i+1)%3],p)>=-1e-10));return patch?patch.sample(x,y):NaN;}
  };
}
