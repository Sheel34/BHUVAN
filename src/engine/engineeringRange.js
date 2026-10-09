import { normalizeAnalysisPayload } from './terrain.js';

export function engineeringRange(width=10000, size=513) {
  if(![1000,10000].includes(width)||size<65||size>1025)throw new Error('Use a bounded 1 km or 10 km test range.');
  const count=size*size,cell=width/(size-1),height=new Float64Array(count);
  const layers=Object.fromEntries(['slope','roughness','curvature','shadow','hazard','traversability'].map(k=>[k,new Float32Array(count)]));
  let min=Infinity,max=-Infinity;
  for(let i=0;i<size;i++)for(let j=0;j<size;j++) {
    const x=(i/(size-1)-.5)*width,z=(j/(size-1)-.5)*width;
    const h=width*.035*Math.sin(x/width*11)*Math.cos(z/width*8)
      +width*.02*Math.exp(-((x/width-.18)**2+(z/width+.1)**2)/.006);
    height[i*size+j]=h;min=Math.min(min,h);max=Math.max(max,h);
  }
  for(let i=0;i<size;i++)for(let j=0;j<size;j++) {
    const k=i*size+j,im=Math.max(0,i-1),ip=Math.min(size-1,i+1),jm=Math.max(0,j-1),jp=Math.min(size-1,j+1);
    const dx=(height[ip*size+j]-height[im*size+j])/((ip-im)*cell);
    const dz=(height[i*size+jp]-height[i*size+jm])/((jp-jm)*cell);
    const degrees=Math.atan(Math.hypot(dx,dz))*180/Math.PI;
    layers.slope[k]=degrees/60;
    layers.roughness[k]=Math.min(1,Math.abs(height[ip*size+j]+height[im*size+j]+height[i*size+jp]+height[i*size+jm]-4*height[k])/cell);
    layers.curvature[k]=layers.roughness[k];layers.shadow[k]=Math.max(0,Math.min(1,.5-dx*.5));
    layers.hazard[k]=Math.min(1,degrees/35*.75+layers.roughness[k]*.25);layers.traversability[k]=1-layers.hazard[k];
  }
  return normalizeAnalysisPayload({jobId:`engineering-${width}`,terrain:{size,scale:width,data:height,minH:min,maxH:max,heightScale:max-min},layers,
    metadata:{terrainName:`${width/1000} km engineering test range`,source:'synthetic engineering fixture',gridSize:size,worldScale:width,resolutionMPerPx:cell,
      analysisModel:{slope:{max:60,unit:'degrees'},roughness:{max:1,unit:'index'}},
      provenance:{status:'SYNTHETIC',metric:true,body:'moon',dataset_id:`engineering-${width}`,source:'Deterministic analytical hills',
        reference:'Local metre coordinates; no planetary registration',source_gsd:cell,analysis_gsd:cell,elevation_unit:'m',
        limitations:['Generated for software demonstrations. Not measured lunar terrain or observed hazards.']}}});
}
