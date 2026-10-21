// Clip in homogeneous camera space before dividing by w. Clipping projected
// screen endpoints across the eye plane would mirror or explode the boundary.
const planes = [p=>p[3]+p[0],p=>p[3]-p[0],p=>p[3]+p[1],p=>p[3]-p[1],p=>p[3]+p[2],p=>p[3]-p[2],p=>p[3]-1e-9];
const finite = p => Array.isArray(p)&&p.length===4&&p.every(Number.isFinite);
const interpolate = (a,b,t) => a.map((value,i)=>value+(b[i]-value)*t);
function clipSegment(a,b){
  let lower=0,upper=1;
  for(const plane of planes){
    const start=plane(a),end=plane(b);
    if(start<0&&end<0)return null;
    if(start<0)lower=Math.max(lower,start/(start-end));
    else if(end<0)upper=Math.min(upper,start/(start-end));
    if(lower>upper)return null;
  }
  return [interpolate(a,b,lower),interpolate(a,b,upper)];
}
function clipFill(vertices){
  let polygon=vertices;
  for(const plane of planes){
    const next=[];
    for(let i=0;i<polygon.length;i++){
      const a=polygon[i],b=polygon[(i+1)%polygon.length],da=plane(a),db=plane(b);
      if(da>=0)next.push(a);
      if((da<0)!==(db<0))next.push(interpolate(a,b,da/(da-db)));
    }
    polygon=next;if(!polygon.length)break;
  }
  return polygon;
}
export function projectMeasurementBoundary(vertices,{width,height},{closed=false}={}){
  const empty={positions:vertices.map(()=>null),segments:[],fill:[]};
  if(!Number.isFinite(width)||!Number.isFinite(height)||width<=0||height<=0||!vertices.every(finite))return empty;
  const screen=p=>[(p[0]/p[3]+1)*width/2,(1-p[1]/p[3])*height/2];
  // Handles and labels refer only to original vertices, never clip intersections.
  const positions=vertices.map(p=>planes.every(plane=>plane(p)>=0)?screen(p):null),segments=[];
  const polygon=closed&&vertices.length>=3,edgeCount=polygon?vertices.length:Math.max(0,vertices.length-1);
  for(let index=0;index<edgeCount;index++){
    const edge=clipSegment(vertices[index],vertices[(index+1)%vertices.length]);
    if(edge)segments.push({index,start:screen(edge[0]),end:screen(edge[1])});
  }
  // This loop is fill-only and rendered even-odd: disconnected pieces of a
  // concave polygon may retrace a clip boundary, but never invent a stroked edge.
  const fill=polygon?clipFill(vertices).map(screen):[];
  return {positions,segments,fill};
}
