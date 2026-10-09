import { terrainAttachment } from './scenario.js';
import { RemoteTileSource } from './tileSource.js';

export const ENVIRONMENT_PROFILES = Object.freeze({
  earth: { body: 'earth', sky: 'local visual sky', ambient: .52, sun: 2.5, sunColor: '#fff5df', birds: true,
    upper: '#143958', horizon: '#a7c6d0', lower: '#263440' },
  moon: { body: 'moon', sky: 'space', ambient: .12, sun: 3.4, sunColor: '#ffffff', birds: false },
  mars: { body: 'mars', sky: 'thin visual dust sky', ambient: .3, sun: 2.2, sunColor: '#ffe4c5', birds: false,
    upper: '#362c3b', horizon: '#ad8471', lower: '#453c3b' },
});

export const ENVIRONMENT_LAYER_KINDS = Object.freeze(['satellite imagery', 'water', 'rivers', 'roads', 'buildings', 'land-cover', 'vegetation', 'snow/ice', 'clouds']);

export function parseEnvironmentFeatures(document,terrain,datasetId) {
  if(!document.source || document.coordinateSpace!=='dataset-local' || document.datasetId!==datasetId || !Array.isArray(document.features))throw new Error('Feature JSON needs source, coordinateSpace: dataset-local, the current datasetId, and features.');
  if(document.features.length>2000)throw new Error('Import at most 2,000 local features per file.');
  const allowed=['rocks','buildings','vegetation','snow/ice','land-cover','water','roads','rivers'];
  return document.features.map(feature=> {
    if(!allowed.includes(feature.kind) || ![feature.x,feature.z].every(Number.isFinite) || Math.max(Math.abs(feature.x),Math.abs(feature.z))>terrain.scale/2 || !(feature.size>0) || feature.size>terrain.scale*.1 || (feature.height!==undefined && (!(feature.height>0)||feature.height>terrain.scale*.1)))throw new Error('Each feature needs a supported kind, in-bounds local X/Z and a positive bounded size.');
    return {...feature,source:document.source,reference:'dataset-local; supplied coordinates and dimensions; registration not independently validated'};
  });
}

export async function attachEnvironmentFeatures(features,terrain,signal) {
  const source=terrain.stream ? new RemoteTileSource(terrain.stream,{maxTiles:96,maxBytes:64*1024*1024}) : null;
  try {
    if(source) {
      const tiles=new Set(features.map(f=>`${Math.floor(Math.min(terrain.size-2,(f.z/terrain.scale+.5)*(terrain.size-1))/128)}:${Math.floor(Math.min(terrain.size-2,(f.x/terrain.scale+.5)*(terrain.size-1))/128)}`));
      if(tiles.size>64)throw new Error('Feature import spans too many native tiles. Import a smaller local area.');
    }
    const native=source ? {...terrain,tileSource:source} : terrain,attached=[];
    for(let i=0;i<features.length;i+=16) {
      signal?.throwIfAborted();
      attached.push(...await Promise.all(features.slice(i,i+16).map(async feature=> ({...feature,groundHeight:(await terrainAttachment(native,feature.x,feature.z,signal)).localHeight}))));
    }
    return attached;
  } finally {source?.dispose();}
}

// This registry never infers geography from height or generates pretend vectors.
export function environmentLayers(metadata = {}) {
  const imagery = metadata.provenance?.acquisition?.imagery || metadata.provenance?.surface_imagery;
  const satellite = Boolean(metadata.colorUrl && imagery?.dataset_id && imagery?.source);
  return ENVIRONMENT_LAYER_KINDS.map(kind => ({ kind, available: kind === 'satellite imagery' && satellite,
    source: kind === 'satellite imagery' && satellite ? imagery.dataset_id : null,
    url: kind === 'satellite imagery' && satellite ? metadata.colorUrl : null,
    reference: metadata.provenance?.reference || null,
    status: kind === 'satellite imagery' && satellite ? imagery.registration || 'sourced / aligned to DEM' : 'no supporting dataset loaded' }));
}
