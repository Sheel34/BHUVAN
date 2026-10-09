import { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import { Canvas, useFrame } from '@react-three/fiber';
import TerrainAnnotations, { AnnotationProjection } from './TerrainAnnotations';
import SurfaceEffects from './SurfaceEffects';
import SceneCapture from './SceneCapture';
import LiquidOptics from './LiquidOptics';
import * as THREE from 'three';
import TerrainChunked from './TerrainChunked';
import PerfStats from './PerfStats';
import TerrainNavigation from './TerrainNavigation';
import LocalEnvironment from './LocalEnvironment';
import ScenarioObjects from './ScenarioObjects';
import SpaceEnvironment from './SpaceEnvironment';
import EnvironmentalFeatures from './EnvironmentalFeatures';
import RoverRehearsal from './RoverRehearsal';
import { ENVIRONMENT_PROFILES } from '../engine/environment';
import { useMobileQuality, WebGLContextStatus, QUALITY_PROFILES, resolveQuality, FrameBudget } from './rendering';


// Neutral walls exist only at the dataset perimeter; no interior tile skirts
// and no invented terrain outside the measured domain.
export function buildDatasetBase(terrain) {
  const { size, scale, data, minH } = terrain;
  const bottom = minH - scale * .025;
  const positions = [], indices = [];
  const perimeter = [];
  for (let j = 0; j < size; j++) perimeter.push([0, j]);
  for (let i = 1; i < size; i++) perimeter.push([i, size - 1]);
  for (let j = size - 2; j >= 0; j--) perimeter.push([size - 1, j]);
  for (let i = size - 2; i > 0; i--) perimeter.push([i, 0]);
  perimeter.forEach(([i, j], k) => {
    const x = (i / (size - 1) - .5) * scale, z = (j / (size - 1) - .5) * scale;
    positions.push(x, data[i * size + j], z, x, bottom, z);
    const a = k * 2, b = ((k + 1) % perimeter.length) * 2;
    indices.push(a, a + 1, b, b, a + 1, b + 1);
  });
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setIndex(indices);
  geometry.computeBoundingSphere();
  return geometry;
}

function DatasetBase({ terrain }) {
  const geometry = useMemo(() => buildDatasetBase(terrain), [terrain]);
  const material = useMemo(() => new THREE.MeshBasicMaterial({
    color: '#363e48', side: THREE.DoubleSide, toneMapped: false,
  }), []);
  useEffect(() => () => geometry.dispose(), [geometry]);
  useEffect(() => () => material.dispose(), [material]);
  return (
    <mesh geometry={geometry} material={material} name="Dataset boundary" dispose={null} />
  );
}

function Lighting({ terrain, quality, verticalExaggeration, environment,roverView,roverRoute,roverRuntime }) {
  const light=useRef();const following=Boolean(roverRoute&&roverView!=='orbit');
  const s = terrain.scale;
  const center = (terrain.minH + terrain.maxH) / 2 * verticalExaggeration;
  const profile = ENVIRONMENT_PROFILES[terrain.body] || ENVIRONMENT_PROFILES.moon;
  const azimuth=(environment.sunAzimuth||0)*Math.PI/180,elevation=(environment.sunElevation||38)*Math.PI/180;
  const relief=(terrain.maxH-terrain.minH)*verticalExaggeration;
  const sunDistance=following?Math.max(80,Math.min(s*1.8,relief*2+60)):s*1.8;
  const halfShadow=following?30:s;
  useEffect(()=>{if(light.current){light.current.shadow.camera.updateProjectionMatrix();light.current.shadow.needsUpdate=true;}},[halfShadow,sunDistance,relief,quality.shadowMap]);
  useFrame(()=> {
    if(!light.current)return;
    const p=following?roverRuntime.current:null;
    const x=p?.position[0]??0,y=p?(p.support?.centerHeight??p.position[1])*verticalExaggeration:center,z=p?.position[2]??0;
    light.current.position.set(x+Math.sin(azimuth)*Math.cos(elevation)*sunDistance,y+Math.sin(elevation)*sunDistance,z+Math.cos(azimuth)*Math.cos(elevation)*sunDistance);
    light.current.target.position.set(x,y,z);light.current.target.updateMatrixWorld();
  });
  return (
    <>
      <ambientLight intensity={profile.ambient} />
      <directionalLight ref={light} key={quality.shadowMap} position={[Math.sin(azimuth)*Math.cos(elevation)*s*1.8, center+Math.sin(elevation)*s*1.8, Math.cos(azimuth)*Math.cos(elevation)*s*1.8]} intensity={profile.sun} color={profile.sunColor}
        castShadow shadow-mapSize-width={quality.shadowMap}
        shadow-mapSize-height={quality.shadowMap}
        shadow-camera-near={Math.max(.01, s / 10000)}
        shadow-camera-far={following?sunDistance*2+relief:s*4+relief}
        shadow-camera-left={-halfShadow} shadow-camera-right={halfShadow}
        shadow-camera-top={halfShadow} shadow-camera-bottom={-halfShadow}
        shadow-bias={-.000005} shadow-normalBias={following ? .015 : 0}>
        <object3D attach="target" position={[0, center, 0]} />
      </directionalLight>
    </>
  );
}

export default function SceneCanvas({
  analysis, viewMode, landingTarget, landingTargetHazard, inspectedPoint,
  focusPoint, interestRegions = [], onInspectPoint, onFocusPoint, onFocusInterestRegion, debugMode = false, onGlReady,
  analysisStatus = 'idle', analysisError = '',
  onStats,performanceOpen,
  onTerrainReady,
  onTerrainError,
  benchmarkMode='tiled', qualityTier, verticalExaggeration = 1, ambience = false, clock,
  scenarioObjects = [], selectedObjectId, placement, onPlaceObject, onSelectObject, onMoveObject, scenarioError, scenarioBusy,
  environment={}, roverRoute, roverRuntime, roverProfileId, roverView='orbit', onRoverView,
  keepMetricZoom,onMetricZoom,cameraMemory,simulationPlaying=false,
}) {
  const terrain = analysis?.terrain;
  const [armMode,setArmMode]=useState(false);
  useEffect(()=>setArmMode(false),[terrain,simulationPlaying]);
  const terrainInstance=useRef({terrain:null,key:0});
  if(terrainInstance.current.terrain!==terrain)terrainInstance.current={terrain,key:terrainInstance.current.key+1};
  const mobile = useMobileQuality();
  const qualityName = resolveQuality(qualityTier, mobile), quality = QUALITY_PROFILES[qualityName];
  const navigationRef = useRef(null), cursorHit = useRef(null);
  const annotationRegistry = useRef(new Map());
  const [selectedAnnotation, setSelectedAnnotation] = useState(null);
  const [showAnnotations, setShowAnnotations] = useState(true);
  useEffect(() => { setSelectedAnnotation(null); }, [terrain]);
  const selectAnnotation = poi => {
    setSelectedAnnotation(poi.id); onFocusInterestRegion?.(poi);
    window.dispatchEvent(new Event('bhuvan-open-inspection'));
  };
  const [dragging, setDragging] = useState(false);
  const [contextStatus, setContextStatus] = useState('');
  const [readyTerrain, setReadyTerrain] = useState(null);
  const [renderError, setRenderError] = useState('');
  const [imagery, setImagery] = useState({ url: null, map: null, status: 'idle' });
  const colorUrl = analysis?.metadata?.colorUrl || null;
  const invalid = useMemo(() => {
    if (!terrain) return '';
    if (!Number.isInteger(terrain.size) || terrain.size < 2 || !(terrain.scale > 0)
      || (!terrain.stream && terrain.data?.length !== terrain.size ** 2) || !Number.isFinite(terrain.minH)
      || !Number.isFinite(terrain.maxH) || terrain.maxH < terrain.minH
      || (!terrain.stream && !terrain.data.every(Number.isFinite))) return 'DEM is empty or contains invalid elevations.';
    return '';
  }, [terrain]);

  useEffect(() => {
    setRenderError('');
    if (invalid) console.error('[terrain] DEM validation failed', { error: invalid, size: terrain?.size });
    if (!terrain || invalid) return undefined;
    console.info('[terrain] Dataset received', { size: terrain.size, scale: terrain.scale,
      minH: terrain.minH, maxH: terrain.maxH });
    const readinessDeadline=terrain.stream ? 70000 : 10000;
    const timer = setTimeout(() => {
      setReadyTerrain(current => {
        if (current !== terrain) {
          console.error('[terrain] No visible tile rendered within deadline',{seconds:readinessDeadline/1000});
          setRenderError('Terrain did not render. Select the dataset again to retry.');
        }
        return current;
      });
    }, readinessDeadline);
    return () => clearTimeout(timer);
  }, [terrain, invalid]);

  useEffect(() => {
    let active = true, texture;
    setImagery({ url: colorUrl, map: null, status: colorUrl ? 'loading' : 'idle' });
    if (colorUrl) {
      new THREE.TextureLoader().setCrossOrigin('anonymous').load(colorUrl, map => {
        texture = map;
        if (!active) { map.dispose(); return; }
        map.colorSpace = THREE.SRGBColorSpace;
        map.anisotropy = quality.anisotropy;
        setImagery({ url: colorUrl, map, status: 'ready' });
      }, undefined, error => {
        console.error('[terrain] Surface imagery load failed', { url: colorUrl, error });
        if (active) setImagery({ url: colorUrl, map: null, status: 'error' });
      });
    }
    return () => { active = false; texture?.dispose(); };
  }, [colorUrl, quality.anisotropy]);

  const down = useRef(null), lastClick = useRef(null), touches = useRef(new Set());
  const handleDown = useCallback(e => {
    if (e.nativeEvent.button !== 0 || !e.object.geometry?.userData.tileId || touches.current.size > 1) { down.current = null; return; }
    down.current = [e.nativeEvent.clientX, e.nativeEvent.clientY];
  }, []);
  const hitPoint = e => ({ x: e.point.x, y: e.point.y / verticalExaggeration, z: e.point.z });
  const handleSelect = useCallback(e => {
    const start = down.current; down.current = null;
    if (!start || Math.hypot(e.nativeEvent.clientX - start[0], e.nativeEvent.clientY - start[1]) > 7 || !e.object.geometry?.userData.tileId) return;
    e.stopPropagation(); const point = hitPoint(e);
    cursorHit.current = point;
    if (placement) { onPlaceObject?.(point); return; }
    const now = performance.now(), previous = lastClick.current;
    const double = e.nativeEvent.pointerType === 'touch' && previous && now - previous.time < 350
      && Math.hypot(e.nativeEvent.clientX - previous.x, e.nativeEvent.clientY - previous.y) < 24;
    onFocusPoint?.({ ...point, mode: double ? 'focus' : 'pivot' });
    onInspectPoint?.(point.x, point.z);
    lastClick.current = double ? null : { time: now, x: e.nativeEvent.clientX, y: e.nativeEvent.clientY };
  }, [onFocusPoint, onInspectPoint, verticalExaggeration, placement, onPlaceObject]);
  const handleDoubleClick = useCallback(e => {
    if (placement || !e.object.geometry?.userData.tileId) return;
    e.stopPropagation(); onFocusPoint?.({ ...hitPoint(e), mode: 'focus' });
  }, [onFocusPoint, verticalExaggeration, placement]);
  const handleMove = useCallback(e => {
    if (e.object.geometry?.userData.tileId) cursorHit.current = hitPoint(e);
    if (down.current && Math.hypot(e.nativeEvent.clientX - down.current[0], e.nativeEvent.clientY - down.current[1]) > 7) down.current = null;
  }, [verticalExaggeration]);
  const handleReady = useCallback(() => {
    setReadyTerrain(terrain);
    onTerrainReady?.(analysis?.jobId);
  }, [terrain, analysis?.jobId, onTerrainReady]);
  const handleRenderError = useCallback(error => {
    setRenderError(error);
    if (error) onTerrainError?.(analysis?.jobId, error);
  }, [analysis?.jobId, onTerrainError]);

  const message = contextStatus
    || (analysisStatus === 'loading' ? 'Analyzing terrain…' : '')
    || analysisError || invalid || renderError || (!terrain ? 'Choose a dataset from Datasets to begin.'
      : readyTerrain !== terrain ? 'Preparing DEM terrain…' : '');
  const colorMap = imagery.url === colorUrl ? imagery.map : null;

  return (
    <div className="terrain-viewport"
      onPointerDownCapture={e => { touches.current.add(e.pointerId); if (touches.current.size > 1) down.current = null; }}
      onPointerUpCapture={e => { if (touches.current.size > 1) down.current = null; touches.current.delete(e.pointerId); }}
      onPointerCancelCapture={e => { touches.current.delete(e.pointerId); down.current = null; setDragging(false); }}
      onPointerLeave={() => { cursorHit.current = null; }}>

      <Canvas shadows dpr={quality.dpr} frameloop="never"
        camera={{ position: [0, 200, 200], fov: 50, near: .01, far: 10000 }}
        gl={{ antialias: quality.antialias, powerPreference: 'high-performance',
          toneMapping: THREE.ACESFilmicToneMapping }}
        fallback={<span>Interactive terrain view. Dataset, analysis and scenario controls are available alongside the scene.</span>}
        onCreated={({ gl }) => {
          gl.shadowMap.type = THREE.PCFSoftShadowMap;
          onGlReady?.(gl);
        }}>
        <color attach="background" args={['#181e26']} />
        <WebGLContextStatus onStatus={setContextStatus} label="terrain" />
        <FrameBudget fps={qualityName==='ULTRA'?45:30}/>
        {!terrain && <SpaceEnvironment mobile={mobile} starCount={quality.stars} decorativeStars />}

        {terrain && !invalid && (
          <>
            <Lighting roverView={roverView} roverRoute={roverRoute} roverRuntime={roverRuntime} terrain={terrain} quality={quality} verticalExaggeration={verticalExaggeration} environment={environment}/>
            <LocalEnvironment terrain={terrain} quality={quality} ambience={ambience} clock={clock} verticalExaggeration={verticalExaggeration} />

            <group scale={[1, verticalExaggeration, 1]}>
            {!terrain.stream && <DatasetBase terrain={terrain} />}
            <group onPointerDown={handleDown} onPointerUp={handleSelect} onDoubleClick={handleDoubleClick} onPointerMove={handleMove}>
              <TerrainChunked key={`${terrainInstance.current.key}:${benchmarkMode}`} terrain={terrain} layers={analysis.layers} viewMode={viewMode}
                colorMap={colorMap} onReady={handleReady} onError={handleRenderError}
                debugMode={debugMode} onStats={onStats} benchmarkMode={benchmarkMode} verticalExaggeration={verticalExaggeration} quality={quality} environment={environment}/>
            </group>
            <EnvironmentalFeatures terrain={terrain} environment={environment}/>
            </group>
            <RoverRehearsal route={roverRoute} runtime={roverRuntime} clock={clock} terrain={terrain} objects={scenarioObjects} verticalExaggeration={verticalExaggeration}/>
            <AnnotationProjection points={interestRegions} terrain={terrain} enabled={showAnnotations && !placement}
              verticalExaggeration={verticalExaggeration} registry={annotationRegistry} />
            <ScenarioObjects roverProfileId={roverProfileId} terrain={terrain} objects={scenarioObjects} selectedId={selectedObjectId}
              verticalExaggeration={verticalExaggeration} onSelect={onSelectObject} onMove={onMoveObject} onDragging={setDragging} roverRoute={roverRoute} roverRuntime={roverRuntime} roverView={roverView} armMode={armMode&&!simulationPlaying}/>
            <TerrainNavigation terrain={terrain} ready={readyTerrain === terrain} focusPoint={focusPoint} verticalExaggeration={verticalExaggeration}
              cursorHit={cursorHit} navigationRef={navigationRef} dragging={dragging} onStats={onStats} roverRoute={roverRoute} roverRuntime={roverRuntime} roverView={roverView}
              keepMetricZoom={keepMetricZoom&&analysis.metadata?.provenance?.metric===true} cameraMemory={cameraMemory}/>
            {quality.ao && viewMode === 'surface' && <SurfaceEffects terrain={terrain} />}
          </>
        )}
        <PerfStats enabled={performanceOpen || (import.meta.env.DEV && debugMode)} onStats={onStats} />
        <SceneCapture sceneId="terrain" verticalExaggeration={verticalExaggeration} analysis={analysis} runtime={roverRuntime}/>
        <LiquidOptics renderMain={!(terrain && !invalid && quality.ao && viewMode === 'surface')} />
      </Canvas>
      {terrain && !invalid && !placement && <TerrainAnnotations points={interestRegions} metric={analysis.metadata?.provenance?.metric === true}
        registry={annotationRegistry} onSelect={selectAnnotation} selected={selectedAnnotation} />}
      {message && <div className={`scene-status ${!terrain&&!analysisError?'empty-scene-status':''}`} role={analysisStatus !== 'loading' && (invalid || analysisError || renderError) ? 'alert' : 'status'}>{message}</div>}
      {terrain && viewMode === 'surface' && imagery.status === 'loading'
        && <div className="scene-texture-note" role="status">Loading surface imagery; DEM available.</div>}
      {terrain && viewMode === 'surface' && imagery.status === 'error'
        && <div className="scene-texture-note" role="status">Surface imagery unavailable; showing shaded DEM.</div>}
      {terrain && <div className="terrain-view-controls">
        {roverRoute&&roverProfileId==='perseverance'&&<button className="terrain-focus-control" aria-pressed={armMode} disabled={simulationPlaying||roverView==='rover'} onClick={()=>setArmMode(v=>!v)} title="Pause, enable Arm inspect, then move the cursor over the scene. Visual joint motion; not collision or actuator validation.">{armMode?'ARM · TRACKING':'ARM INSPECT'}</button>}
        {roverRoute&&<button className="terrain-focus-control" onClick={()=>window.dispatchEvent(new CustomEvent('bhuvan-capture-frame',{detail:'terrain'}))} title="Save this simulated view with camera and DEM metadata; a colour frame alone cannot reconstruct exact terrain.">CAPTURE VIEW</button>}
        {roverView==='orbit' && <button data-liquid-control="metric-zoom" className="terrain-focus-control" aria-pressed={keepMetricZoom} onClick={()=>onMetricZoom(!keepMetricZoom)} title="Retain camera range across measured patches on the same body. Frame All still fits the entire patch.">METRIC ZOOM · {keepMetricZoom?'ON':'OFF'}</button>}
        {roverRoute && <div className="rover-view-switch" role="group" aria-label="Active rover viewpoint">{['orbit','chase','rover'].map(view=><button key={view} data-liquid-control={`camera-${view}`} className="terrain-focus-control" aria-pressed={roverView===view} onClick={()=>onRoverView?.(view)}>{view==='rover'?'ROVER POV':view.toUpperCase()}</button>)}</div>}
        {interestRegions.length > 0 && <button data-liquid-control="annotations" className="terrain-focus-control"
          aria-label="Terrain feature labels" aria-pressed={showAnnotations} onClick={() => setShowAnnotations(value => !value)}>
          Labels: {showAnnotations ? 'on' : 'off'}</button>}
        <button hidden={roverView!=='orbit'} data-liquid-control="frame-all" className="terrain-focus-control" disabled={roverView!=='orbit'} onClick={() => navigationRef.current?.frameAll()}
          aria-label="Frame entire terrain" title="Click to pivot · double-click / F to focus · right or middle drag to pan">⌖ FRAME ALL</button>
        {roverRoute && roverView!=='orbit' && <div className="follow-look-controls" role="group" aria-label="Rover viewing direction">
          {['rear','side','front'].map(angle=><button key={angle} className="terrain-focus-control" onClick={()=>window.dispatchEvent(new CustomEvent('bhuvan-rover-angle',{detail:angle}))}>{roverView==='rover'?({rear:'AHEAD',side:'LEFT',front:'BACK'}[angle]):angle.toUpperCase()}</button>)}
          <span className="camera-gesture-hint">{roverView==='chase'?'Drag to orbit rover · scroll for distance':'Drag to look around from mast'}</span>
        </div>}

      </div>}
      {terrain && interestRegions.length > 0 && showAnnotations && !placement && <div className="terrain-annotation-hint">Tap a marker to inspect · All points in Analysis</div>}
      {(placement || scenarioBusy || scenarioError) && <div className="placement-note" role={scenarioError ? 'alert' : 'status'}>
        {scenarioError || (scenarioBusy ? 'Reading native terrain height…' : `Click terrain to ${placement.id ? 'move object' : `place ${placement.type.toLowerCase()}`}. Escape cancels.`)}</div>}
    </div>
  );
}
