// Image depth has no real-world scale. These units are explicit scenario
// assumptions; provenance.metric stays false even when the renderer uses metres.
export const DEFAULT_IMAGE_SCALE = Object.freeze({ width: 1000, relief: 80, invert: false });

export function hasRehearsalScale(analysis) {
  return analysis?.metadata?.provenance?.metric === true ||
    (analysis?.metadata?.provenance?.status === 'ESTIMATED' &&
      analysis?.metadata?.rehearsalScale?.kind === 'assumed' && analysis?.terrain?.metric === true);
}

export function terrainWindowExtrema(data, size, radius, maximum) {
  const horizontal = new Float64Array(data.length), result = new Float64Array(data.length);
  for (let i=0;i<size;i++) for (let j=0;j<size;j++) {
    let value=maximum?-Infinity:Infinity;
    for(let k=Math.max(0,j-radius);k<=Math.min(size-1,j+radius);k++)
      value=maximum?Math.max(value,data[i*size+k]):Math.min(value,data[i*size+k]);
    horizontal[i*size+j]=value;
  }
  for (let i=0;i<size;i++) for (let j=0;j<size;j++) {
    let value=maximum?-Infinity:Infinity;
    for(let k=Math.max(0,i-radius);k<=Math.min(size-1,i+radius);k++)
      value=maximum?Math.max(value,horizontal[k*size+j]):Math.min(value,horizontal[k*size+j]);
    result[i*size+j]=value;
  }
  return result;
}

export function imageTerrainLayers(data, size, width) {
  const cell=width/(size-1), layers=Object.fromEntries(
    ['slope','roughness','curvature','shadow','hazard','traversability'].map(key=>[key,new Float32Array(data.length)]));
  const radius=Math.min(12,Math.max(1,Math.round(3/cell)),Math.floor((size-1)/4));
  const closed=terrainWindowExtrema(terrainWindowExtrema(data,size,radius,true),size,radius,false);
  const h=(i,j)=>data[Math.max(0,Math.min(size-1,i))*size+Math.max(0,Math.min(size-1,j))];
  for(let i=0;i<size;i++)for(let j=0;j<size;j++) {
    const k=i*size+j,center=data[k];
    const dx=(h(i+1,j)-h(i-1,j))/((i===0||i===size-1?1:2)*cell);
    const dz=(h(i,j+1)-h(i,j-1))/((j===0||j===size-1?1:2)*cell);
    const grade=Math.atan(Math.hypot(dx,dz))*180/Math.PI;
    // Residual from a fitted local plane: a smooth incline is not roughness.
    let residual=0;
    for(let a=-1;a<=1;a++)for(let b=-1;b<=1;b++)
      residual+=(h(i+a,j+b)-center-dx*a*cell-dz*b*cell)**2;
    const roughness=Math.sqrt(residual/9),slope=Math.min(1,grade/35);
    const curvature=Math.min(1,Math.abs(h(i-1,j)+h(i+1,j)+h(i,j-1)+h(i,j+1)-4*center)/(cell*cell));
    const depression=i>=radius*2&&j>=radius*2&&i<size-radius*2&&j<size-radius*2?
      Math.max(0,closed[k]-center):0;
    const hazard=Math.min(1,Math.max(slope*.65+Math.min(1,roughness/.5)*.25+curvature*.1,depression/.5));
    layers.slope[k]=slope;layers.roughness[k]=Math.min(1,roughness/.5);
    layers.curvature[k]=curvature;layers.shadow[k]=0;
    layers.hazard[k]=hazard;layers.traversability[k]=1-hazard;
  }
  return layers;
}

export function applyImageScale(analysis, scale=DEFAULT_IMAGE_SCALE) {
  if(analysis?.metadata?.provenance?.metric===true||analysis?.terrain?.stream)
    throw new Error('Image scale applies only to estimated image surfaces.');
  const {width,relief,invert=false}=scale,original=analysis.imageDepth||analysis.terrain;
  if(!Number.isFinite(width)||width<20||width>30000||!Number.isFinite(relief)||relief<0||relief>width*.5)
    throw new Error('Choose 20–30,000 m width and relief up to half the width.');
  const {size,data}=original;
  if(size<3||size>1025||data?.length!==size**2||!data.every(Number.isFinite))
    throw new Error('Image depth grid is unavailable.');
  let lo=Infinity,hi=-Infinity;for(const h of data){lo=Math.min(lo,h);hi=Math.max(hi,h);}
  const range=hi-lo;
  const heights=Float64Array.from(data,h=>range>1e-9?(invert?hi-h:h-lo)/range*relief:0);
  const actualRelief=range>1e-9?relief:0,cell=width/(size-1);
  const baseId=analysis.imageDepth?.jobId||analysis.jobId||'image';
  return {...analysis,imageDepth:analysis.imageDepth||{...original,jobId:baseId},
    jobId:`${baseId}:assumed:${width}:${relief}:${invert}`,
    terrain:{...analysis.terrain,data:heights,scientificData:heights,scale:width,heightScale:actualRelief,
      minH:0,maxH:actualRelief,elevationOrigin:0,metric:true},
    layers:imageTerrainLayers(heights,size,width),landingZones:[],intelligence:null,report:null,
    metadata:{...analysis.metadata,worldScale:width,resolutionMPerPx:cell,heightScale:actualRelief,
      rehearsalScale:{kind:'assumed',width,relief,invert},
      analysisModel:{slope:{max:35,unit:'deg'},roughness:{max:.5,unit:'m'},curvature:{max:1,unit:'1/m'},
        hazard:'image geometry heuristic; local plane residual, grade and depression closing'},
      provenance:{...analysis.metadata?.provenance,status:'ESTIMATED',metric:false,
        reference:'Image-local rehearsal; width and relief assumed, global location unknown',
        analysis_gsd:cell,source_gsd:null,elevation_unit:'assumed m',horizontal_unit:'assumed m',
        limitations:[...(analysis.metadata?.provenance?.limitations||[]).filter(s=>!s.startsWith('Assumed scale:')),
          `Assumed scale: ${width} m width, ${relief} m relief. Image depth is not a measured DEM; hidden or sub-grid hazards remain unknown.`]}}};
}

export function depthRehearsalAnalysis(depth, {name,colorUrl,jobId}) {
  const size=depth.grid.length,data=Float64Array.from(depth.grid.flat());
  return applyImageScale({jobId,terrain:{size,scale:2,data,minH:0,maxH:1,body:'unknown'},layers:{},
    metadata:{terrainName:name,colorUrl,ownedColorUrl:colorUrl,source:'On-device monocular depth',
      provenance:{metric:false,status:'ESTIMATED',body:'unknown',source:depth.model,
        limitations:['Camera depth is reinterpreted as surface relief, not reconstructed georeferenced elevation.']}}});
}
