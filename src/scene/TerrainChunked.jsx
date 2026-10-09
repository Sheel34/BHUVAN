import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { useThree, useFrame } from '@react-three/fiber';
import { Html } from '@react-three/drei';
import * as THREE from 'three';
import { analysisColor } from '../engine/terrain';
import { MemoryTileSource, windowValue, TILE_CELLS } from '../engine/tileSource';
import { terrainRenderBounds } from '../engine/terrainNavigation';

export { buildTerrainTile, createTerrainTiles, selectVisibleTiles } from './terrainGeometry';
export const CHUNK_SIZE = TILE_CELLS;
import { buildTerrainTile, selectVisibleTiles, selectStreamedTiles, buildTileBoundary, trimGeometryCache } from './terrainGeometry';

function colorTile(terrain,layers,viewMode,tile,imagery) {
  const color=new THREE.Color(), attr=tile.geometry.attributes.color;
  const samples=tile.geometry.userData.samples;
  for(let k=0;k<attr.count;k++) {
    const i=samples[k*2],j=samples[k*2+1];
    const ni=Math.round(i),nj=Math.round(j), index=ni*terrain.size+nj;
    const value=tile.window ? windowValue(tile.window,viewMode,ni,nj) : layers?.[viewMode]?.[index];
    color.setRGB(...(imagery ? [1,1,1] : analysisColor(viewMode,value,terrain,tile.geometry.attributes.position.getY(k))),THREE.SRGBColorSpace);
    attr.setXYZ(k,color.r,color.g,color.b);
  }
  attr.needsUpdate=true;
}

export default memo(function TerrainChunked({ terrain,layers,viewMode,colorMap,onReady,onError,debugMode=false,onStats,benchmarkMode='tiled',verticalExaggeration=1,quality={dpr:1},environment={} }) {
  const { camera,size,controls }=useThree();
  const bounds=useMemo(()=>terrainRenderBounds(terrain,verticalExaggeration),[terrain,verticalExaggeration]);
  const viewport=useRef();viewport.current={height:size.height*quality.dpr,controls,bounds};
  const source=useMemo(()=>terrain.tileSource || new MemoryTileSource(terrain,layers),[terrain,layers]);
  const remote=Boolean(terrain.stream), cache=useRef(new Map()), drawn=useRef(false);
  const [tiles,setTiles]=useState([]),[desired,setDesired]=useState([]),[loading,setLoading]=useState(false);
  const [fallback,setFallback]=useState(null);
  const fineGroup=useRef(),fallbackGroup=useRef(),loadingRef=useRef(false);
  loadingRef.current=loading;
  const active=useRef([]),modeRef=useRef({viewMode,colorMap});modeRef.current={viewMode,colorMap};
  const dispose=entry=> {entry.geometry.dispose();entry.boundary?.dispose();};
  useEffect(()=> {
    const ownedCache=new Map();cache.current=ownedCache;
    let generation=0,signature='',closed=false;
    const overviewKey=remote ? `${terrain.stream.max_level}/0/0` : null;
    const trimOwned=()=>trimGeometryCache(ownedCache,new Set([...active.current.map(t=>t.cacheKey),...requiredNow,...(overviewKey ? [overviewKey] : [])]));
    const abort=new AbortController();drawn.current=false;active.current=[];setTiles([]);setFallback(null);
    if(import.meta.env.DEV)globalThis.__BHUVAN_STREAMING_STATS__={};
    const update=()=> {
      if(closed)return;
      camera.updateMatrixWorld();
      let next=remote ? selectStreamedTiles(viewport.current.bounds,camera,viewport.current.height,viewport.current.controls?.target)
        : selectVisibleTiles(viewport.current.bounds,camera,viewport.current.height);
      if(!remote && import.meta.env.DEV && benchmarkMode==='monolithic' && terrain.size<=1025 && next.length) {
        const step=next[0].step;
        next=[{i0:0,j0:0,i1:terrain.size-1,j1:terrain.size-1,key:'monolithic',step,cacheKey:`monolithic:${step}`}];
      }
      if(!next.length) {
        // Retain the last valid surface. An empty frustum selection is explicit,
        // never a reason to erase the scene or change authoritative data.
        onError?.('No terrain tiles intersect the camera. Recenter the dataset.');return;
      }
      const sig=next.map(t=>t.cacheKey).join('|');if(sig===signature)return;
      signature=sig;const current=++generation;setLoading(true);setDesired(next);
      const required=new Set([...next.map(t=>t.cacheKey),...(overviewKey ? [overviewKey] : [])]);source.cancelExcept?.(required);
      Promise.all(next.map(async tile=> {
        let entry=ownedCache.get(tile.cacheKey);
        if(!entry) {
          const window=await source.readTile(tile,{signal:abort.signal});
          if(closed || (current!==generation && !requiredNow.has(tile.cacheKey)))return null;
          entry=ownedCache.get(tile.cacheKey);
          if(!entry) {
            entry={...tile,window,geometry:buildTerrainTile(terrain,tile,window)};
            if(remote)entry.boundary=buildTileBoundary(terrain,entry,window);
            ownedCache.set(tile.cacheKey,entry);
            trimOwned();
          }
        } else {ownedCache.delete(tile.cacheKey);ownedCache.set(tile.cacheKey,entry);}
        colorTile(terrain,layers,modeRef.current.viewMode,entry,modeRef.current.viewMode==='surface' && modeRef.current.colorMap);
        return entry;
      })).then(loaded=> {
        if(closed || current!==generation || loaded.some(value=>!value))return;
        // Replace only complete, consistently sampled sets. This is also the
        // guarantee against mixed display LOD boundaries during transitions.
        active.current=loaded;setTiles(loaded);onError?.('');
      }).catch(error=> {
        if(!closed && current===generation && error.name!=='AbortError') {
          console.error('[terrain] Tile load failed',error);onError?.(`Terrain tile load failed: ${error.message}`);
        }
      }).finally(()=> {if(!closed && current===generation)setLoading(false);});
      requiredNow=required;
    };
    let requiredNow=new Set();
    if(remote) {
      const level=terrain.stream.max_level,step=2**level,key=`${level}/0/0`;
      const root={i0:0,j0:0,i1:terrain.size-1,j1:terrain.size-1,step,level,x:0,y:0,key,cacheKey:key};
      source.getTile(level,0,0,{signal:abort.signal}).then(window=> {
        if(closed)return;
        let entry=ownedCache.get(key);
        if(!entry) {
          entry={...root,window,geometry:buildTerrainTile(terrain,root,window)};
          entry.boundary=buildTileBoundary(terrain,entry,window);ownedCache.set(key,entry);
          trimOwned();
        }
        colorTile(terrain,layers,modeRef.current.viewMode,entry,modeRef.current.viewMode==='surface' && modeRef.current.colorMap);
        setFallback(entry);
      }).catch(error=> {if(!closed && error.name!=='AbortError')onError?.(`Dataset overview unavailable: ${error.message}`);});
    }
    update();const timer=setInterval(update,200);
    return()=> {closed=true;abort.abort();clearInterval(timer);source.dispose?.();for(const entry of ownedCache.values())dispose(entry);ownedCache.clear();};
  },[camera,terrain,source,onError,benchmarkMode,remote]);
  useEffect(()=> {
    for(const tile of tiles)colorTile(terrain,layers,viewMode,tile,viewMode==='surface' && colorMap);
    if(fallback)colorTile(terrain,layers,viewMode,fallback,viewMode==='surface' && colorMap);
  },[tiles,fallback,terrain,layers,viewMode,colorMap]);
  useEffect(()=> {
    const visible=new Set(tiles.map(t=>t.cacheKey));
    // A tile returned by an unfinished Promise.all must not be evicted before
    // commit: rendering a disposed orphan would re-upload geometry that is no
    // longer owned by the cache. Retain both drawn and pending complete sets.
    const retained=new Set([...visible,...desired.map(t=>t.cacheKey),...(remote ? [`${terrain.stream.max_level}/0/0`] : [])]);
    trimGeometryCache(cache.current,retained);
    const displayed=loading && fallback ? [fallback] : tiles;
    const statistics={renderingMode:remote ? 'remote tiles' : benchmarkMode,loadedTiles:tiles.length,cachedGeometryTiles:cache.current.size,
      logicalDimensions:[terrain.size,terrain.size],activeTiles:displayed.length,activeVertices:displayed.reduce((n,t)=>n+t.geometry.attributes.position.count,0),
      triangles:displayed.reduce((n,t)=>n+t.geometry.index.count/3,0),lod:displayed[0]?.geometry.userData.lod ?? null,
      tileReads:source.metrics.reads,tileLoadMs:source.metrics.totalLoadMs,tileWindowBytes:source.metrics.bytes,
      visualGsd:terrain.scale/(terrain.size-1)*(loading && fallback ? fallback.step : tiles[0]?.step||1),analysisGsd:remote ? terrain.stream.analysis?.gsd_m ?? null : terrain.scale/(terrain.size-1),
      fullRasterResidentBytes:remote ? 0 : (terrain.data?.byteLength||0)+(terrain.scientificData?.byteLength||0)+Object.values(layers||{}).reduce((n,f)=>n+(f?.byteLength||0),0),
      loading,sourceLimitation:source.limitation,...source.statistics};
    onStats?.(statistics);
    const windows=new Set([...Array.from(cache.current.values(),t=>t.window),...Array.from(source.cache?.values?.() || [])]);
    if(import.meta.env.DEV)globalThis.__BHUVAN_STREAMING_STATS__={...globalThis.__BHUVAN_STREAMING_STATS__,...statistics,
      tileStates:desired.map(t=>({id:t.key,lod:t.level ?? Math.log2(t.step),state:visible.has(t.cacheKey) ? 'resident' : source.errors?.has(t.key) ? 'error' : source.inFlight?.has(t.key) ? 'loading' : source.cache?.has(t.key) ? 'cached' : 'unloaded'})),
      geometryBufferBytes:Array.from(cache.current.values()).reduce((sum,t)=>sum+Object.values(t.geometry.attributes).reduce((n,a)=>n+a.array.byteLength,0)+t.geometry.index.array.byteLength,0),
      ownedTerrainGeometries:Array.from(cache.current.values()).reduce((sum,t)=>sum+1+(t.boundary ? 1 : 0),0),
      residentCpuTileBytes:Array.from(windows).reduce((sum,w)=>sum+(w.byteLength || Object.values(w.fields).reduce((n,f)=>n+f.byteLength,0)),0),
      serverRssBytes:displayed[0]?.window.server_rss_bytes ?? null};
  },[tiles,desired,fallback,layers,viewMode,colorMap,loading,onStats,source,terrain,benchmarkMode]);
  useFrame(()=> {
    if(!remote || !fineGroup.current || !fallbackGroup.current)return;
    const target=viewport.current.controls?.target;
    const i=target ? (target.x/terrain.scale+.5)*(terrain.size-1) : terrain.size/2;
    const j=target ? (target.z/terrain.scale+.5)*(terrain.size-1) : terrain.size/2;
    const covered=active.current.some(t=>i>=t.i0 && i<=t.i1 && j>=t.j0 && j<=t.j1);
    const useOverview=Boolean(fallback) && (loadingRef.current || !covered || !active.current.length);
    fallbackGroup.current.visible=useOverview;fineGroup.current.visible=!useOverview;
    if(import.meta.env.DEV && globalThis.__BHUVAN_STREAMING_STATS__) {
      globalThis.__BHUVAN_STREAMING_STATS__.fallbackActive=useOverview;
      globalThis.__BHUVAN_STREAMING_STATS__.effectiveDisplayGsd=terrain.scale/(terrain.size-1)*(useOverview ? fallback.step : active.current[0]?.step||1);
      const displayed=useOverview ? [fallback] : active.current;
      globalThis.__BHUVAN_STREAMING_STATS__.activeTiles=displayed.length;
      globalThis.__BHUVAN_STREAMING_STATS__.activeVertices=displayed.reduce((n,t)=>n+t.geometry.attributes.position.count,0);
      globalThis.__BHUVAN_STREAMING_STATS__.triangles=displayed.reduce((n,t)=>n+t.geometry.index.count/3,0);
    }
  });
  const physical=viewMode==='surface',imagery=physical ? colorMap : null;
  const material=useMemo(()=> {
    if (!physical) return new THREE.MeshBasicMaterial({ vertexColors:true,toneMapped:false });
    const m = new THREE.MeshStandardMaterial({ vertexColors:true,map:imagery,roughness:.92,metalness:0 });
    {
      // Subtle world-space material grain. Continuous across tile borders and
      // distance-filtered; presentation only, no displacement or new DEM detail.
      m.onBeforeCompile = shader => {
        shader.vertexShader = shader.vertexShader.replace('#include <common>', '#include <common>\nvarying vec3 grainPosition;')
          .replace('#include <worldpos_vertex>', '#include <worldpos_vertex>\ngrainPosition = (modelMatrix * vec4(transformed, 1.0)).xyz; grainPosition.y=transformed.y;');
        shader.fragmentShader = shader.fragmentShader.replace('#include <common>', '#include <common>\nvarying vec3 grainPosition;')
          .replace('#include <color_fragment>', `#include <color_fragment>
            ${!imagery ? `vec3 g = grainPosition * ${Math.max(.02, 20 / terrain.scale).toFixed(8)};
            vec3 weights = abs(normalize(vNormal)); weights /= max(dot(weights, vec3(1.0)), .001);
            float detail = dot(vec3(sin(g.y*7.1)*sin(g.z*9.3),sin(g.x*7.1)*sin(g.z*9.3),sin(g.x*7.1)*sin(g.y*9.3)), weights);
            float fade = 1.0 / (1.0 + length(fwidth(g)) * 12.0);
            diffuseColor.rgb *= 1.0 + detail * .14 * fade;` : ''}
            ${environment.snow && terrain.body==='earth' ? `float snow=smoothstep(${((environment.snowLine||0)-(terrain.elevationOrigin||0)).toFixed(3)},${((environment.snowLine||0)-(terrain.elevationOrigin||0)+Math.max(1,terrain.scale*.002)).toFixed(3)},grainPosition.y)*smoothstep(.35,.8,abs(normalize(vNormal).y));diffuseColor.rgb=mix(diffuseColor.rgb,vec3(.82,.9,.95),snow);` : ''}`);
      };
      const baseCompile=m.onBeforeCompile;
      m.onBeforeCompile=shader=> {
        baseCompile(shader);
        if(environment.microtexture===false)return;
        shader.fragmentShader=shader.fragmentShader.replace('#include <common>',`#include <common>
          float regolithHash(vec3 p){return fract(sin(dot(p,vec3(127.1,311.7,74.7)))*43758.5453);}
          float regolithNoise(vec3 p){vec3 i=floor(p),f=fract(p);f=f*f*(3.0-2.0*f);
            return mix(mix(mix(regolithHash(i),regolithHash(i+vec3(1,0,0)),f.x),mix(regolithHash(i+vec3(0,1,0)),regolithHash(i+vec3(1,1,0)),f.x),f.y),mix(mix(regolithHash(i+vec3(0,0,1)),regolithHash(i+vec3(1,0,1)),f.x),mix(regolithHash(i+vec3(0,1,1)),regolithHash(i+vec3(1,1,1)),f.x),f.y),f.z);}
        `).replace('#include <normal_fragment_maps>',`#include <normal_fragment_maps>
          vec3 finePosition=grainPosition*20.0;
          float footprint=length(fwidth(finePosition));
          float grain=regolithNoise(finePosition)*0.004/(1.0+footprint*footprint);
          vec3 sx=dFdx(-vViewPosition),sy=dFdy(-vViewPosition);
          vec3 rx=cross(sy,normal),ry=cross(normal,sx);
          float determinant=dot(sx,rx)*faceDirection;
          normal=normalize(max(abs(determinant),1e-8)*normal-sign(determinant)*(dFdx(grain)*rx+dFdy(grain)*ry));
        `);
      };
      m.customProgramCacheKey = () => `terrain-grain-${environment.microtexture}-${Boolean(imagery)}-${terrain.scale}-${environment.snow}-${environment.snowLine}`;
    }
    return m;
  },[environment.microtexture,physical,imagery,terrain.scale,terrain.body,terrain.elevationOrigin,environment.snow,environment.snowLine]);
  const boundaryMaterial=useMemo(()=>new THREE.MeshBasicMaterial({color:'#363e48',side:THREE.DoubleSide,toneMapped:false}),[]);
  const wireMaterial=useMemo(()=>new THREE.MeshBasicMaterial({wireframe:true,color:'#72dbeb',transparent:true,opacity:.2,toneMapped:false}),[]);
  useEffect(()=>()=>material.dispose(),[material]);
  useEffect(()=>()=> {boundaryMaterial.dispose();wireMaterial.dispose();},[boundaryMaterial,wireMaterial]);
  const handleDraw=()=> { if(!drawn.current) { drawn.current=true;
    if(import.meta.env.DEV && globalThis.__BHUVAN_STREAMING_STATS__)globalThis.__BHUVAN_STREAMING_STATS__.firstDrawMs=performance.now();
    console.info('[terrain] First working set drawn',{ tiles:tiles.length });onReady?.(); } };
  return <group dispose={null} name="DEM" userData={{ terrainTiles:tiles.length, cachedTiles:cache.current.size, source:remote ? 'remote' : 'memory' }}>
    <group ref={fallbackGroup} name="Dataset loading overview" visible={false}>
      {fallback && <group position={[fallback.geometry.userData.centerX,0,fallback.geometry.userData.centerZ]}>
        <mesh geometry={fallback.geometry} material={material} receiveShadow={physical} castShadow={physical} onAfterRender={handleDraw} />
        {fallback.boundary && <mesh geometry={fallback.boundary} material={boundaryMaterial} />}
      </group>}
    </group>
    <group ref={fineGroup} name="Detailed working set">
    {import.meta.env.DEV && debugMode && desired.filter(t=>!tiles.some(v=>v.cacheKey===t.cacheKey)).map(t=><Html key={`pending-${t.key}`}
      position={[((t.i0+t.i1)/2/(terrain.size-1)-.5)*terrain.scale,terrain.maxH,((t.j0+t.j1)/2/(terrain.size-1)-.5)*terrain.scale]}
      center style={{pointerEvents:'none',fontSize:10,color:'#f4c16a',whiteSpace:'nowrap'}}>{t.key} · {source.errors?.has(t.key) ? 'ERROR' : 'LOADING'}</Html>)}
    {tiles.map(tile=><group key={tile.cacheKey} position={[tile.geometry.userData.centerX,0,tile.geometry.userData.centerZ]}>
      <mesh geometry={tile.geometry} material={material} receiveShadow={physical} castShadow={physical} onAfterRender={handleDraw} />
      {tile.boundary && <mesh geometry={tile.boundary} material={boundaryMaterial} />}
      {import.meta.env.DEV && debugMode && <>
        <mesh geometry={tile.geometry} material={wireMaterial} position={[0,terrain.scale*.0002,0]} />
        <Html position={[0,terrain.maxH,0]} center style={{ pointerEvents:'none',fontSize:10,whiteSpace:'nowrap',color:'#b3eaff' }}>
          {tile.key} · LOD {tile.geometry.userData.lod} · RESIDENT
        </Html>
      </>}
    </group>)}
    </group>
  </group>;
});
