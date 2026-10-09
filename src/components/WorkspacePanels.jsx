import { VEHICLE_PROFILES, vehicleProfile } from '../engine/vehicleProfiles';
import { useEffect, useRef, useState } from 'react';
import { SCENARIO_TYPES } from '../engine/scenario';
import { ENVIRONMENT_PROFILES, environmentLayers, parseEnvironmentFeatures, attachEnvironmentFeatures } from '../engine/environment';
import { QUALITY_PROFILES, resolveQuality } from '../scene/rendering';
import { useLiquidPreferences } from './LiquidPreferences';
import { traverseCSV } from '../engine/rover';
import { hasRehearsalScale } from '../engine/imageRehearsal';
import { boundedRoverSpeed, scenarioLabel, SCENARIO_ROLES, observationsCSV } from '../engine/rehearsal';

export function EnvironmentPanel({ analysis, mobile, qualityTier, onQualityChange, verticalExaggeration,
  onExaggerationChange, ambience, onAmbienceChange, close, environment, onEnvironmentChange, clientGpu }) {
  const [importError,setImportError]=useState('');
  const importController=useRef(null),[importing,setImporting]=useState(false);
  useEffect(()=>()=>importController.current?.abort(),[analysis]);
  const update=(name,value)=>onEnvironmentChange(previous=>({...previous,[name]:value}));
  const profile = ENVIRONMENT_PROFILES[analysis?.terrain?.body] || ENVIRONMENT_PROFILES.moon;
  const quality = resolveQuality(qualityTier, mobile);
  const { depth, setDepth } = useLiquidPreferences();
  return <div id="environment-panel" className="hud-right-panel" data-liquid-surface="panel">
    <div className="hud-panel-header">ENVIRONMENT <button onClick={close} aria-label="Close environment">×</button></div>
    <div className="hud-section"><div className="hud-section-label">ACTIVE GRAPHICS DEVICE</div><p className="gpu-readout" data-client-gpu={clientGpu?.renderer}>{clientGpu?.renderer||'Reading browser renderer…'}</p><p className="assumption">Browser-selected GPU · 30 FPS target (Ultra: 45). Rendering uses the user's device.</p></div>
    <div className="hud-section"><div className="hud-section-label">{profile.body.toUpperCase()} · {profile.sky.toUpperCase()}</div>
      <p className="assumption">Scenario lighting; not observed weather.</p>
      <label className="workspace-field">SUN AZIMUTH · {environment.sunAzimuth}°<input aria-label="Sun azimuth" type="range" min="0" max="360" value={environment.sunAzimuth} onChange={e=>update('sunAzimuth',Number(e.target.value))}/></label>
      <label className="workspace-field">SUN ELEVATION · {environment.sunElevation}°<input aria-label="Sun elevation" type="range" min="5" max="85" value={environment.sunElevation} onChange={e=>update('sunElevation',Number(e.target.value))}/></label>
      <p className="assumption">Terrain shadows follow this light. The analytical hazard field is unchanged.</p>
    </div>
    <div className="hud-section"><label className="workspace-field">WATER CONTROL DEPTH · {depth}%
      <input aria-label="Water control depth" type="range" min="0" max="100" value={depth}
        onChange={event => setDepth(Number(event.target.value))} /></label>
      <p className="assumption">Changes refraction through the water buttons. Terrain values are unaffected.</p>
    </div>
    <div className="hud-section"><div className="hud-section-label">LOCAL RENDER QUALITY · {quality}</div>
      <div className="glass-segments" role="group" aria-label="Render quality">
        <button aria-pressed={!qualityTier} onClick={() => onQualityChange(null)}>AUTO</button>
        {Object.keys(QUALITY_PROFILES).map(tier => <button key={tier} aria-pressed={qualityTier === tier} onClick={() => onQualityChange(tier)}>{tier}</button>)}
      </div>
      <p className="assumption">Display quality only. DEM resolution stays unchanged.</p>
    </div>
    <div className="hud-section"><label className="workspace-field">VERTICAL EXAGGERATION · {verticalExaggeration.toFixed(1)}×
      <input aria-label="Visual vertical exaggeration" type="range" min="1" max="4" step=".5" value={verticalExaggeration}
        onChange={e => onExaggerationChange(Number(e.target.value))} /></label>
      <p className="assumption">Display height only. Measured values stay unchanged.</p>
    </div>
    <div className="hud-section"><button className="hud-action-btn" aria-pressed={ambience} disabled={!profile.birds || !analysis}
      onClick={() => onAmbienceChange(!ambience)}>CINEMATIC AMBIENCE · {ambience && profile.birds ? 'ON' : 'OFF'}</button>
      <p className="assumption">{profile.birds ? 'Optional animated decorative bird demo; not observed wildlife. No effect on routes or analysis.' : 'No bird demo for this planetary body.'}</p>
    </div>
    <div className="hud-section"><div className="hud-section-label">SOURCED ENVIRONMENTAL LAYERS</div>
      {environmentLayers(analysis?.metadata).filter(layer=>layer.available).map(layer => <div className="environment-source" key={layer.kind}>
        <b>{layer.kind.toUpperCase()}</b><span className={layer.available ? 'available-source' : ''}>{layer.available ? layer.source : 'UNAVAILABLE'}</span>
      </div>)}
      <label className="workspace-field">{importing?'READING NATIVE FEATURE HEIGHTS…':'LOAD LOCAL FEATURE JSON'}<input type="file" accept=".json" aria-label="Import environmental features" disabled={!analysis||importing} onChange={async e=> {
        const file=e.target.files?.[0];if(!file)return;
        importController.current?.abort();const controller=new AbortController();importController.current=controller;setImporting(true);
        try {if(file.size>2*1024*1024)throw new Error('Feature file must be under 2 MB.');const document=JSON.parse(await file.text());const features=parseEnvironmentFeatures(document,analysis.terrain,analysis.jobId||analysis.metadata?.provenance?.dataset_id);const attached=await attachEnvironmentFeatures(features,analysis.terrain,controller.signal);if(!controller.signal.aborted){update('features',attached);setImportError('');}}catch(error){if(!controller.signal.aborted)setImportError(error.message);}finally{if(!controller.signal.aborted)setImporting(false);}
      }}/></label>
      <p className="assumption">{environment.features?.length||0} supplied features. Rocks, buildings, roads, rivers, vegetation, land-cover and snow/ice patches use dataset-local coordinates. Source and dataset identity are required.</p>
      <details><summary>Feature file format</summary><pre className="benchmark-output">{JSON.stringify({source:'Your mapped or surveyed source',coordinateSpace:'dataset-local',datasetId:analysis?.jobId||analysis?.metadata?.provenance?.dataset_id,features:[{kind:'rocks',x:0,z:0,size:1}]},null,2)}</pre></details>
      {importError && <p role="alert">{importError}</p>}
    </div>
    <div className="hud-section"><div className="hud-section-label">SURFACE PRESENTATION</div>
      <button className="hud-action-btn" aria-pressed={environment.microtexture!==false} onClick={()=>update('microtexture',environment.microtexture===false)}>MATERIAL MICROTEXTURE · {environment.microtexture!==false?'ON':'OFF'}</button>
      <p className="assumption">Visual grain; adds no measured rock geometry.</p>
    </div>
    <div className="hud-section"><div className="hud-section-label">SURFACE WHAT-IF CONDITIONS</div>
      {profile.body==='earth' && <>
        <button className="hud-action-btn" aria-pressed={environment.water} onClick={()=>update('water',!environment.water)}>WATER LEVEL · {environment.water?'ON':'OFF'}</button>
        <label className="workspace-field">WATER ELEVATION · m<input aria-label="Scenario water elevation" type="number" value={environment.waterLevel} onChange={e=>update('waterLevel',Number(e.target.value))}/></label>
        {analysis && <><input aria-label="Water height within terrain range" type="range" min={(analysis.terrain.elevationOrigin||0)+analysis.terrain.minH} max={(analysis.terrain.elevationOrigin||0)+analysis.terrain.maxH} value={environment.waterLevel} onChange={e=>update('waterLevel',Number(e.target.value))}/><button className="hud-action-btn" onClick={()=>update('waterLevel',Math.round((analysis.terrain.elevationOrigin||0)+analysis.terrain.minH+(analysis.terrain.maxH-analysis.terrain.minH)*.25))}>FILL LOWER TERRAIN</button></>}
        <button className="hud-action-btn" aria-pressed={environment.snow} onClick={()=>update('snow',!environment.snow)}>SNOW COVER · {environment.snow?'ON':'OFF'}</button>
        <label className="workspace-field">SNOW LINE · m<input aria-label="Scenario snow line" type="number" value={environment.snowLine} onChange={e=>update('snowLine',Number(e.target.value))}/></label>
        <p className="assumption">Scenario water excludes submerged routes. Snow is a visual elevation mask, not a snow observation or traction model.</p>
      </>}
      <button className="hud-action-btn" disabled={!analysis||Boolean(analysis.terrain.stream)} aria-pressed={environment.rocks} onClick={()=>update('rocks',!environment.rocks)}>VISUAL ROCK STRESS-TEST · {environment.rocks?'ON':'OFF'}</button>
      <p className="assumption">Decorative rocks only. Routing uses DEM hazards and supplied features.</p>
    </div>
  </div>;
}

function downloadTelemetry(records) {
  const url=URL.createObjectURL(new Blob([observationsCSV(records)],{type:'text/csv'}));
  const a=document.createElement('a');a.href=url;a.download='bhuvan-map-observations.csv';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
}
function RoverSpeed({speed,nominal,onChange}) {
  const [draft,setDraft]=useState(String(speed));
  useEffect(()=>setDraft(String(speed)),[speed]);
  const commit=()=>{const value=boundedRoverSpeed(draft);setDraft(String(value));onChange(value);};
  return <div className="rover-speed-editor">
    <label className="workspace-field">TRAVEL SPEED · m/s<input aria-label="Rover speed" inputMode="decimal" type="number" min=".001" max="20" step="any" value={draft} onChange={e=>setDraft(e.target.value)} onBlur={commit} onKeyDown={e=>{if(e.key==='Enter'){e.preventDefault();commit();}}}/></label>
    <div className="glass-segments" role="group" aria-label="Rover speed presets">{[...new Set([nominal,.1,1,5])].map(value=><button key={value} aria-pressed={speed===value} onClick={()=>onChange(value)}>{value+' m/s'}</button>)}</div>
    <p className="assumption">Enter a speed: 0.001–20 m/s. Default: {nominal} m/s. Higher speeds are experimental.</p>
  </div>;
}

function ImageScale({analysis,onApply}) {
  const scale=analysis.metadata.rehearsalScale;
  return <details className="image-rehearsal-scale" open><summary>Image dimensions · assumed</summary>
    <form key={analysis.jobId} onSubmit={event=>{event.preventDefault();const form=new FormData(event.currentTarget);
      onApply({width:Number(form.get('width')),relief:Number(form.get('relief')),invert:form.get('invert')==='on'});}}>
      <label className="workspace-field">WIDTH · m<input name="width" aria-label="Image terrain width" type="number" min="20" max="30000" step="any" defaultValue={scale.width} required/></label>
      <label className="workspace-field">RELIEF · m<input name="relief" aria-label="Image terrain relief" type="number" min="0" max={scale.width*.5} step="any" defaultValue={scale.relief} required/></label>
      <label className="workspace-check"><input name="invert" aria-label="Invert image relief" type="checkbox" defaultChecked={scale.invert}/>Invert relief</label>
      <button className="hud-action-btn">APPLY DIMENSIONS</button>
    </form><p className="assumption">Estimated surface. Changing dimensions resets placement. Hidden holes remain unknown.</p>
  </details>;
}

export function ScenarioPanel({ analysis, objects, selectedId, onSelect, onPlacement, onMove, onRotate, onConstraint,
  clockState, onClock, error, busy, close, roverRoute, roverTelemetry, roverSettings, onRoverSettings, roverView, onRoverView, onPlanRoute, onDemoScenario,onOpenDatasets,
  routeChoices=[],onRouteChoice,onImageScale }) {
  const profile=vehicleProfile(roverSettings.profileId==='generic'?'perseverance':roverSettings.profileId);
  const selected = objects.find(o => o.id === selectedId);
  const unit = 'm';
  if(!hasRehearsalScale(analysis))return <div id="scenario-panel" className="hud-right-panel" data-liquid-surface="panel"><div className="hud-panel-header">SCENARIO<button onClick={close} aria-label="Close scenario">×</button></div><div className="hud-section"><h3>Choose a surface</h3><p className="assumption">Upload a terrain image or load a DEM.</p><button className="hud-action-btn" onClick={onOpenDatasets}>CHOOSE TERRAIN</button></div></div>;
  return <div id="scenario-panel" className="hud-right-panel" data-liquid-surface="panel">
    <div className="hud-panel-header">SCENARIO <button onClick={close} aria-label="Close scenario">×</button></div>
    {analysis.metadata?.rehearsalScale&&<div className="hud-section"><ImageScale analysis={analysis} onApply={onImageScale}/></div>}
    <div className="hud-section"><label className="workspace-field">MISSION VEHICLE<select aria-label="Mission vehicle" value={profile.id} onChange={e=>onRoverSettings(p=>({...p,profileId:e.target.value,speed:vehicleProfile(e.target.value).speed}))}>{Object.values(VEHICLE_PROFILES).filter(p=>p.asset).map(p=><option value={p.id} key={p.id}>{p.name}</option>)}</select></label>
      <p>{profile.science}</p><p className="assumption">{profile.task}. Mars vehicle; this rehearsal is hypothetical.</p>
      <p className="assumption">Track {profile.track} m · wheelbase {profile.wheelbase} m (approximate).</p>
      <p className="assumption">{profile.id==='perseverance'?'Pause → Arm inspect → move cursor over the rover.':'Curiosity is a static supplied model. Select Perseverance for cursor arm inspection.'}</p>
    </div>
    <div className="hud-section"><div className="hud-section-label">CLOCK · {clockState.elapsed.toFixed(1)} s</div>
      <div className="glass-segments"><button disabled={!roverRoute||roverTelemetry?.complete} aria-pressed={clockState.playing} onClick={() => onClock(clockState.playing ? 'pause' : 'play')}>{clockState.playing ? 'PAUSE' : 'PLAY'}</button>
        <button onClick={() => onClock('reset')}>RESET</button></div>
      <label className="workspace-field">TIME SCALE · {clockState.timeScale}×<input aria-label="Scenario time scale" type="range" min=".25" max="100" step=".25"
        value={clockState.timeScale} onChange={e => onClock('scale', Number(e.target.value))} /></label>
      <p className="assumption">Plan → Play. Reset returns to the start.</p>
    </div>
    <div className="hud-section"><div className="hud-section-label">ROVER → OBJECTIVE</div>
      <button className="hud-action-btn" disabled={busy} onClick={onDemoScenario}>CREATE ROVER REHEARSAL</button>
      <p className="assumption">Place rover + objective → compare routes. Hazards come from the surface.</p>
      <label className="workspace-field">DESTINATION<select aria-label="Rover destination" value={roverSettings.objectiveId||objects.find(o=>['OBJECTIVE','SCIENCE SITE'].includes(o.type))?.id||''} onChange={e=>onRoverSettings(previous=>({...previous,objectiveId:e.target.value}))}>
        {!objects.some(o=>['OBJECTIVE','SCIENCE SITE'].includes(o.type)) && <option value="">Place an objective first</option>}
        {objects.filter(o=>['OBJECTIVE','SCIENCE SITE'].includes(o.type)).map(o=><option key={o.id} value={o.id}>{scenarioLabel(objects,o)}</option>)}
      </select></label>
      <RoverSpeed speed={roverSettings.speed} nominal={profile.speed} onChange={speed=>onRoverSettings(previous=>({...previous,speed}))}/>
      <label className="workspace-field">MAXIMUM GRADE · {roverSettings.maxSlope}°<input aria-label="Rover maximum grade" type="range" min="5" max="45" value={roverSettings.maxSlope} onChange={e=>onRoverSettings(previous=>({...previous,maxSlope:Number(e.target.value)}))}/></label>
      <label className="workspace-field">MAXIMUM HAZARD INDEX · {roverSettings.maxHazard.toFixed(2)}<input aria-label="Rover maximum hazard" type="range" min=".1" max="1" step=".05" value={roverSettings.maxHazard} onChange={e=>onRoverSettings(previous=>({...previous,maxHazard:Number(e.target.value)}))}/></label>
      <p className="assumption">Routes must stay below {roverSettings.maxSlope}° and hazard {roverSettings.maxHazard.toFixed(2)}. Change a limit → replan.</p>
      <button className="hud-action-btn" disabled={!analysis||busy||!objects.some(o=>o.type==='VEHICLE')||!objects.some(o=>['OBJECTIVE','SCIENCE SITE'].includes(o.type))} onClick={onPlanRoute}>{busy?'CHECKING THREE ROUTES…':'COMPARE 3 ROUTES'}</button>
      {routeChoices.length>0&&<div className="route-choices" role="group" aria-label="Terrain route alternatives">{routeChoices.map(choice=><button key={choice.id} className="hud-dataset-btn route-choice" disabled={!choice.route} aria-pressed={Boolean(choice.route&&choice.route===roverRoute)} onClick={()=>onRouteChoice(choice.id)}>
        <span className="hud-dataset-name">{choice.label}</span><span className="hud-dataset-sub">{choice.route?`${choice.route.distance.toFixed(1)} m · ${choice.route.maxSlope.toFixed(1)}° peak · hazard ${choice.route.maxHazard.toFixed(2)}`:choice.reason}</span>
      </button>)}</div>}
      {error && <p role="alert" className="hud-status-message error">{error}</p>}
      {roverRoute && <>
        <p className="assumption">Six wheel supports · peak roll {(roverRoute.maxRoll??0).toFixed(1)}° · contact gap {(roverRoute.maxUnsupportedHeight??0).toFixed(2)} m.</p>
        <p className="route-coordinate-readout">Rover X {roverTelemetry?.position?.[0]?.toFixed(2)} · Z {roverTelemetry?.position?.[2]?.toFixed(2)} · {roverRoute.assumedScale?'Assumed height':'DEM elevation'} {((roverTelemetry?.position?.[1]||0)+(analysis.terrain.elevationOrigin||0)).toFixed(2)} {unit}</p>
        <button className="hud-action-btn" onClick={()=> {const url=URL.createObjectURL(new Blob([traverseCSV({...roverRoute,speed:roverSettings.speed},analysis.terrain.elevationOrigin||0)],{type:'text/csv'}));const a=document.createElement('a');a.href=url;a.download=roverRoute.assumedScale?'bhuvan-assumed-image-traverse.csv':'bhuvan-planned-traverse.csv';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}}>EXPORT PLANNED TRAVERSE</button>
        <p className="route-summary">{roverRoute.distance.toFixed(1)} {unit} · {roverRoute.maxSlope.toFixed(1)}° maximum grade · hazard {roverRoute.maxHazard.toFixed(2)}</p>
        <progress aria-label="Rover objective progress" max="1" value={roverTelemetry?.progress||0}/>
        <p role="status">{roverTelemetry?.complete?'OBJECTIVE REACHED · OBSERVATION PLAN READY':`${((roverTelemetry?.progress||0)*100).toFixed(1)}% complete · ${Math.ceil(roverTelemetry?.remaining ?? roverRoute.distance/roverRoute.speed)} s remaining`}</p>
        <div className="map-observations"><b>MAP OBSERVATIONS · {roverTelemetry?.observations?.length||0}</b>
          <p className="assumption">Map predictions: elevation, tilt, support and relay visibility. Not sensor measurements.</p>
          {roverTelemetry?.observations?.at(-1)&&<p className="route-coordinate-readout">Latest · {roverTelemetry.observations.at(-1).distance.toFixed(1)} m travelled · pitch {roverTelemetry.observations.at(-1).pitch.toFixed(1)}° · roll {roverTelemetry.observations.at(-1).roll.toFixed(1)}°</p>}
          <button className="hud-action-btn" disabled={!roverTelemetry?.observations?.length} onClick={()=>downloadTelemetry(roverTelemetry.observations)}>EXPORT COLLECTED OBSERVATIONS</button>
        </div>
        <p className="assumption">Planned next action: {profile.task}. No sensor measurements have been fabricated.</p><p className="assumption">Relay: {roverTelemetry?.relay||'Checking terrain line of sight…'}</p>
        <div className="glass-segments" role="group" aria-label="Rover camera">{['orbit','chase','rover'].map(view=><button key={view} aria-pressed={roverView===view} onClick={()=>{onRoverView(view);close();}}>{view==='rover'?'ROVER POV':view.toUpperCase()}</button>)}</div>
        <p className="assumption">{roverRoute.fidelity} · source grid {roverRoute.sourceGsd.toFixed(2)} {unit}/cell · planning grid {roverRoute.planningGsd.toFixed(2)} {unit}/cell. Corridor checks sample the analysis DEM; they cannot resolve unmapped rocks or validate traction.</p>
      </>}
      <p className="assumption">The route avoids resolved DEM hazards. Smaller holes need finer data.</p>
      <p className="assumption">Kinematic preview. Soil, suspension forces, power and landing dynamics are not simulated.</p>
    </div>
    <div className="hud-section"><div className="hud-section-label">ADD OBJECT → CLICK TERRAIN</div>
      <div className="scenario-types">{['VEHICLE','OBJECTIVE'].map(type => <button key={type} className="hud-action-btn" disabled={!analysis || busy}
        onClick={() => { onPlacement({ type }); close(); }}>{type==='VEHICLE'?'PLACE ROVER':'PLACE OBJECTIVE'}</button>)}</div>
      <details className="optional-infrastructure"><summary>Optional infrastructure</summary>
        <div className="scenario-types">{SCENARIO_TYPES.filter(type=>!['VEHICLE','OBJECTIVE','HAZARD REGION'].includes(type)).map(type=><button key={type} className="hud-action-btn" disabled={busy} onClick={()=>{onPlacement({type});close();}}>{type}</button>)}</div>
      </details>
      {busy && <p role="status" className="assumption">Reading native terrain height…</p>}
      {error && <p role="alert" className="hud-status-message">{error}</p>}
    </div>
    <div className="hud-section"><div className="hud-section-label">USER-CREATED OBJECTS · {objects.length}</div>
      {!objects.length && <p className="assumption">Place a rover and objective, or create a rehearsal.</p>}
      {objects.map(o => <button className="hud-action-btn secondary" key={o.id} aria-pressed={selectedId === o.id} onClick={() => onSelect(o.id)}>{scenarioLabel(objects,o)}</button>)}
    </div>
    {selected && <div className="hud-section" key={selected.id}>
      <div className="hud-section-label">EDIT {selected.type}</div>
      <button className="hud-action-btn" onClick={() => { onPlacement({ id: selected.id, type: selected.type }); close(); }}>MOVE ON TERRAIN</button>
      <p className="assumption">Move on terrain, or enter an exact local position.</p>
      <details className="precise-placement"><summary>Precise local position</summary><form className="scenario-coordinate-form" onSubmit={e => {
        e.preventDefault(); const form = new FormData(e.currentTarget);
        onMove(selected.id, Number(form.get('x')), Number(form.get('z')));
      }}>
        <label className="workspace-field">X · {unit}<input key={`x-${selected.position[0]}`} name="x" aria-label="Object local X" type="number" step="any" defaultValue={Number(selected.position[0].toFixed(2))} required /></label>
        <label className="workspace-field">Z · {unit}<input key={`z-${selected.position[2]}`} name="z" aria-label="Object local Z" type="number" step="any" defaultValue={Number(selected.position[2].toFixed(2))} required /></label>
        <button className="hud-action-btn" disabled={busy}>APPLY POSITION</button>
      </form></details>
      {['VEHICLE','FACILITY','STATION'].includes(selected.type)&&<><label className="workspace-field">PLACEMENT HEADING · {(selected.orientation[1] * 180 / Math.PI).toFixed(0)}°<input aria-label="Object heading" type="range" min="0" max="360" step="1"
        value={selected.orientation[1] * 180 / Math.PI} onChange={e => onRotate(selected.id, Number(e.target.value))} /></label>
        <p className="assumption">{selected.type==='VEHICLE'?'Starting heading; travel follows the route.':'Model orientation. Exclusion remains circular.'}</p></>}
      {['FACILITY','STATION','HAZARD REGION','RELAY'].includes(selected.type)&&<label className="workspace-field">{selected.type==='RELAY'?'RELAY RANGE':'EXCLUSION RADIUS'} · m<input key={`${selected.id}-${selected.constraints?.radius}-${selected.constraints?.range}`} aria-label={selected.type==='RELAY'?'Relay range':'Exclusion radius'} type="number" min="1" max={analysis.terrain.scale*2} step="any" defaultValue={selected.type==='RELAY'?(selected.constraints?.range??analysis.terrain.scale*.5):(selected.constraints?.radius??(selected.type==='HAZARD REGION'?analysis.terrain.scale/(Math.min(129,analysis.terrain.size)-1)*1.5:6))} onBlur={e=>onConstraint?.(selected.id,selected.type==='RELAY'?'range':'radius',Math.max(1,Math.min(analysis.terrain.scale*2,Number(e.target.value)||1)))}/></label>}
      <p className="entity-purpose">{SCENARIO_ROLES[selected.type]}</p>
      {selected.id===roverRoute?.vehicleId&&roverTelemetry&&<p className="route-coordinate-readout">Current X {roverTelemetry.position[0].toFixed(2)} · Z {roverTelemetry.position[2].toFixed(2)} m · heading {(roverTelemetry.heading*180/Math.PI).toFixed(1)}° · {clockState.playing?roverTelemetry.speed?.toFixed(3):'0.000'} m/s</p>}
      <p className="assumption">{analysis.metadata?.rehearsalScale?'Assumed surface height':'Attached DEM elevation'}: {selected.attachment.elevation.toFixed(2)} m.</p>

    </div>}
  </div>;
}
