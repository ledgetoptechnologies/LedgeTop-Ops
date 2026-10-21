const METERS_TO_FEET=3.280839895013123;
export function normalizeUnits(value){return value==='metric'?'metric':'imperial';}
export function formatLength(meters,units='imperial'){
  if(normalizeUnits(units)==='metric'){
    const n=Math.abs(meters)>=1000?`${(meters/1000).toFixed(2)} km`:`${meters.toFixed(Math.abs(meters)<10?2:1)} m`;
    return n;
  }
  const totalInches=meters*METERS_TO_FEET*12;
  const sign=totalInches<0?'-':'';
  const absolute=Math.abs(totalInches);
  let feet=Math.floor(absolute/12);
  let inches=Math.round((absolute-feet*12)*1000)/1000;
  if(inches>=12){feet+=1;inches=0;}
  return `${sign}${feet}' ${inches.toFixed(3)}"`;
}
export function formatArea(squareMeters,units='imperial'){if(normalizeUnits(units)==='metric')return squareMeters>=1_000_000?`${(squareMeters/1_000_000).toFixed(2)} km²`:`${squareMeters.toLocaleString(undefined,{maximumFractionDigits:2})} m²`;const squareFeet=squareMeters*METERS_TO_FEET**2;return squareFeet>=43559.5?`${(squareFeet/43560).toFixed(2)} acres`:`${Math.round(squareFeet).toLocaleString()} sq ft`;}
export function formatVolume(cubicMeters,units='imperial'){if(normalizeUnits(units)==='metric')return `${cubicMeters.toLocaleString(undefined,{maximumFractionDigits:2})} m³`;return `≈ ${Math.round(cubicMeters*METERS_TO_FEET**3/27).toLocaleString()} cu yd`;}
export function formatVolumeDetail(cubicMeters,baseSquareMeters,depthMeters,units='imperial'){if(normalizeUnits(units)==='metric')return `${formatVolume(cubicMeters,units)} · base ${formatArea(baseSquareMeters,units)} · depth ${formatLength(depthMeters,units)}`;return `${Math.round(cubicMeters*METERS_TO_FEET**3).toLocaleString()} cu ft · base ${formatArea(baseSquareMeters,units)} · depth ${formatLength(depthMeters,units)}`;}
export function formatElevation(meters,units='imperial'){return normalizeUnits(units)==='metric'?`${meters.toFixed(1)} m`:`${Math.round(meters*METERS_TO_FEET)} ft`;}
export function formatGsd(meters,units='imperial'){return normalizeUnits(units)==='metric'?`${(meters*100).toFixed(2)} cm/pixel`:`${(meters*METERS_TO_FEET*12).toFixed(2)} in/pixel`;}
