// Boundary-inclusive membership for source selection and isolated previews.
export function insideSelection(e,n,polygon) {
  let inside=false;
  for(let i=0,j=polygon.length-1;i<polygon.length;j=i++) {
    const a=polygon[j],b=polygon[i],dx=b[0]-a[0],dy=b[1]-a[1],cross=(e-a[0])*dy-(n-a[1])*dx;
    if(Math.abs(cross)<=1e-9*Math.max(1,Math.hypot(dx,dy))&&e>=Math.min(a[0],b[0])-1e-9&&e<=Math.max(a[0],b[0])+1e-9&&n>=Math.min(a[1],b[1])-1e-9&&n<=Math.max(a[1],b[1])+1e-9)return true;
    if((a[1]>n)!==(b[1]>n)&&e<(b[0]-a[0])*(n-a[1])/(b[1]-a[1])+a[0])inside=!inside;
  }
  return inside;
}
