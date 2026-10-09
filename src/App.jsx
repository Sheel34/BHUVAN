import PerformancePanel from './components/PerformancePanel';
import { useState, useCallback, useEffect, useMemo, useRef } from 'react';
import HUD from './components/HUD';
import GlobeOverlay from './components/GlobeOverlay';
import MissionDossier from './components/MissionDossier';
import ReportModal from './components/ReportModal';
import SceneErrorBoundary from './components/SceneErrorBoundary';
import AcquisitionPanel from './components/AcquisitionPanel';
import SceneCanvas from './scene/SceneCanvas';
import WaterInteractions from './components/WaterInteractions';
import MoonGlobe from './scene/MoonGlobe';
import { inspectTerrainPoint, deriveBody, sampleHeight } from './engine/terrain';
import {
  analyzeSample,
  analyzeUpload,
  acquireLocationTerrain,
  fetchSampleCatalog,
  fetchMoonTextures,
  generateReport,
  developmentStreamingAnalysis,
} from './lib/api';
import { readWebGLGpu } from './lib/clientGpu';
import { DEFAULT_ORBIT_MOTION } from './engine/orbitMotion';
import { lunarLocalFrame, createLocalFrame, datasetCoordinateContext } from './engine/coordinates';
import { selectedLocation as createSelectedLocation, previousOrbitLevel } from './engine/orbit';
import { SimulationClock, terrainAttachment, createScenarioObject } from './engine/scenario';
import { DEFAULT_ROVER, prepareRoverRoutes, roverPose, relayVisibility,findRehearsalPlacement } from './engine/rover';
import { applyImageScale, depthRehearsalAnalysis, hasRehearsalScale } from './engine/imageRehearsal';
import { engineeringRange } from './engine/engineeringRange';
import { updateRehearsal, lunarMissionOrigin, rehearsalObjectPositions } from './engine/rehearsal';
const EMPTY_OBJECTS = [];

// Default to the photoreal regolith surface, not the hazard heatmap — the
// data layers are one toggle away in the HUD.
const DEFAULT_VIEW = 'surface';

export default function App() {
  const [phase, setPhase] = useState('globe');
  const [workspacePanel, setWorkspacePanel] = useState(null);
  const [body, setBody] = useState('moon');
  const [orbitNavigation, setOrbitNavigation] = useState({ level: 'space', body: 'moon', revision: 0 });
  const [selectedLocation, setSelectedLocation] = useState(null);
  const [regionSizeKm, setRegionSizeKm] = useState(10);
  const [wideArea,setWideArea]=useState(true),[gatewayView,setGatewayView]=useState(false);
  const [sentinelImagery, setSentinelImagery] = useState(false);
  const [acquisition, setAcquisition] = useState(null);
  const acquisitionAbort = useRef(null);
  const flightFinished = useRef(null);
  const buildStarted = useRef(null);
  const [moonTextures, setMoonTextures] = useState(null);
  const [moonTextureSource, setMoonTextureSource] = useState('bundled');
  const analysisRequest = useRef(0);
  const [viewMode, setViewMode] = useState(DEFAULT_VIEW);
  const [analysis, setAnalysis] = useState(null);
  const [analysisStatus, setAnalysisStatus] = useState('idle');
  const [analysisError, setAnalysisError] = useState('');
  const [sampleCatalog, setSampleCatalog] = useState([]);
  const [selectedZoneId, setSelectedZoneId] = useState(null);
  const [inspectedPoint, setInspectedPoint] = useState(null);
  // Clicks move the pivot; zone/POI choices deliberately focus closer.
  // Pointer hover only supplies cursor navigation diagnostics.
  const [focusPoint, setFocusPoint] = useState(null);
  const [backendMode, setBackendMode] = useState('connecting');
  const [debugMode, setDebugMode] = useState(false);
  const [report, setReport] = useState(null);
  const [reportBusy, setReportBusy] = useState(false);
  const [selectedMission, setSelectedMission] = useState(null);
  const [flyToMission, setFlyToMission] = useState(null);
  const [clientGpu, setClientGpu] = useState(null);
  const [edgeInfo, setEdgeInfo] = useState(null);
  const [diagnostics, setDiagnostics] = useState({});
  const [performanceOpen,setPerformanceOpen]=useState(false);
  const [benchmarkMode, setBenchmarkMode] = useState('tiled');
  const [qualityTier, setQualityTier] = useState(null);
  const [orbitMotion,setOrbitMotion] = useState({...DEFAULT_ORBIT_MOTION});
  const [orbitModelDays,setOrbitModelDays]=useState(0);
  const [keepMetricZoom,setKeepMetricZoom]=useState(true),terrainCameraMemory=useRef(null);
  const [verticalExaggeration, setVerticalExaggeration] = useState(1);
  const [ambience, setAmbience] = useState(false);
  const [environment, setEnvironment] = useState({ sunAzimuth: 135, sunElevation: 38, water: false, waterLevel: 0, snow: false, snowLine: 4000, rocks: false, rockDensity: 300 });
  const [roverSettings, setRoverSettings] = useState({...DEFAULT_ROVER, profileId:'perseverance', speed:.02});
  const [roverRoute, setRoverRoute] = useState(null), [roverView, setRoverView] = useState('orbit');
  const [routeChoices,setRouteChoices]=useState([]);
  const roverRuntime = useRef({position:[0,0,0],progress:0,complete:false,remaining:0,distance:0,relay:'No relay'});
  const [roverTelemetry,setRoverTelemetry] = useState(null);
  const [captureNotice,setCaptureNotice]=useState('');
  useEffect(()=> {let timer;const result=e=>{setCaptureNotice(e.detail);clearTimeout(timer);timer=setTimeout(()=>setCaptureNotice(''),6000);};window.addEventListener('bhuvan-capture-result',result);return()=>{window.removeEventListener('bhuvan-capture-result',result);clearTimeout(timer);};},[]);
  const routeAbort = useRef(null);
  const clock = useRef(new SimulationClock()).current;
  const [clockState, setClockState] = useState(clock.snapshot());
  const [objectsByDataset, setObjectsByDataset] = useState({});
  const [placement, setPlacement] = useState(null), [selectedObjectId, setSelectedObjectId] = useState(null);
  const [scenarioError, setScenarioError] = useState(''), [scenarioBusy, setScenarioBusy] = useState(false);
  const placementAbort = useRef(null);
  const datasetKey = analysis?.jobId || analysis?.metadata?.provenance?.dataset_id || 'unselected';
  const scenarioObjects = objectsByDataset[datasetKey] || EMPTY_OBJECTS;
  useEffect(() => { const timer = setInterval(() => {setClockState(clock.snapshot());setRoverTelemetry(roverRoute ? {...roverRuntime.current} : null);}, 250); return () => clearInterval(timer); }, [clock,roverRoute]);
  const handleClock = useCallback((action, value) => {
    if (action === 'scale') clock.setTimeScale(value); else clock[action]?.();
    setClockState(clock.snapshot());
  }, [clock]);

  const pointAbort = useRef(null);
  useEffect(()=> {clock.reset();setRoverRoute(null);setRouteChoices([]);setRoverView('orbit');setRoverTelemetry(null);routeAbort.current?.abort();},[analysis,scenarioObjects,roverSettings.profileId,roverSettings.maxSlope,roverSettings.maxHazard,roverSettings.objectiveId,environment.features,environment.water,environment.waterLevel,clock]);
  const liveRoverSpeed=useRef(roverSettings.speed);liveRoverSpeed.current=roverSettings.speed;
  useEffect(()=> {
    if(!roverRoute || !analysis?.terrain)return;
    const travel={elapsed:0,distance:0};let previous=performance.now();
    const tick=()=> {
      const now=performance.now(),dt=(now-previous)/1000;previous=now;
      if(document.visibilityState==='hidden')return;
      clock.advance(Math.min(.25,dt));
      updateRehearsal(roverRoute,roverRuntime.current,travel,clock.elapsed,liveRoverSpeed.current,analysis.terrain,scenarioObjects);
      if(roverRuntime.current.complete)clock.pause();
    };
    tick();const timer=setInterval(tick,1000/30);return ()=>clearInterval(timer);
  },[roverRoute,analysis,scenarioObjects,clock]);
  const handlePlanRoute = useCallback(async () => {
    const vehicle=scenarioObjects.find(o=>o.id===selectedObjectId&&o.type==='VEHICLE')||scenarioObjects.find(o=>o.type==='VEHICLE');
    const objective=scenarioObjects.find(o=>o.id===roverSettings.objectiveId&&['OBJECTIVE','SCIENCE SITE'].includes(o.type))||scenarioObjects.find(o=>o.type==='OBJECTIVE')||scenarioObjects.find(o=>o.type==='SCIENCE SITE');
    if(!vehicle||!objective) {setScenarioError('Place a vehicle and an objective first, or use Create rover rehearsal.');return;}
    routeAbort.current?.abort();const controller=new AbortController();routeAbort.current=controller;
    setScenarioBusy(true);setScenarioError('');setRouteChoices([]);setRoverRoute(null);clock.reset();setRoverView('orbit');
    try {const choices=await prepareRoverRoutes(analysis,vehicle,objective,roverSettings,scenarioObjects,environment,controller.signal);
      if(!controller.signal.aborted) {const route=choices.find(c=>c.route).route;setRouteChoices(choices);
        roverRuntime.current={...roverPose(route,0),relay:relayVisibility(analysis.terrain,vehicle.position,scenarioObjects)};setRoverRoute(route);setSelectedObjectId(vehicle.id);}}
    catch(error) {if(!controller.signal.aborted)setScenarioError(error.message);}
    finally {if(routeAbort.current===controller) {setScenarioBusy(false);routeAbort.current=null;}}
  },[analysis,scenarioObjects,selectedObjectId,roverSettings,environment,clock]);
  const handleRouteChoice=useCallback(id=> {
    const route=routeChoices.find(c=>c.id===id)?.route;if(!route)return;
    clock.reset();setClockState(clock.snapshot());setRoverRoute(route);
    roverRuntime.current={...roverPose(route,0),relay:relayVisibility(analysis.terrain,route.path[0],scenarioObjects)};
    setRoverTelemetry({...roverRuntime.current});
  },[routeChoices,clock,analysis,scenarioObjects]);
  const handleDemoScenario = useCallback(async()=> {
    if(!analysis?.terrain)return;
    routeAbort.current?.abort();const controller=new AbortController();routeAbort.current=controller;
    setScenarioBusy(true);setScenarioError('');
    try {
      const placement=await findRehearsalPlacement(analysis,roverSettings,scenarioObjects.filter(o=>o.origin!=='rehearsal'),environment,controller.signal);
      const specs=rehearsalObjectPositions(analysis.terrain,placement).filter(([type])=>type==='VEHICLE'||type==='OBJECTIVE');
      const objects=await Promise.all(specs.map(async([type,px,pz])=>createScenarioObject(type,await terrainAttachment(analysis.terrain,px,pz,controller.signal),datasetKey,0,crypto.randomUUID())));
      if(controller.signal.aborted)return;
      setObjectsByDataset(previous=>({...previous,[datasetKey]:[...(previous[datasetKey]||[]).filter(o=>o.origin!=='rehearsal'),...objects.map(o=>({...o,origin:'rehearsal'}))]}));setSelectedObjectId(objects[0].id);
      setRoverSettings(previous=>({...previous,objectiveId:objects[1].id}));
    } catch(error) {if(!controller.signal.aborted)setScenarioError(error.message);} finally {if(routeAbort.current===controller){setScenarioBusy(false);routeAbort.current=null;}}
  },[analysis,datasetKey,roverSettings,scenarioObjects,environment]);
  useEffect(()=>()=>routeAbort.current?.abort(),[]);
  const handleStats = useCallback(stats => setDiagnostics(previous => ({ ...previous, ...stats })), []);

  const handleGlReady = useCallback((gl) => {
    const gpu=readWebGLGpu(gl);setClientGpu(gpu);console.info('[bhuvan-client-gpu] '+JSON.stringify(gpu));
    setQualityTier(previous=>previous ?? (gpu?.integrated||gpu?.software?'BALANCED':'HIGH'));
  }, []);

  const selectedZone = useMemo(
    () => analysis?.landingZones?.find((zone) => zone.id === selectedZoneId) || null,
    [analysis, selectedZoneId]
  );

  const landingTarget = selectedZone
    ? [selectedZone.x, selectedZone.y, selectedZone.z, selectedZone.radius]
    : null;
  const landingTargetHazard = selectedZone
    ? (selectedZone.classification === 'unsafe' ? 2 : selectedZone.classification === 'caution' ? 1 : 0)
    : 0;

  useEffect(() => {
    let active = true;
    setBackendMode('connecting');
    fetchSampleCatalog()
      .then((catalog) => {
        if (!active) return;
        const samples = Array.isArray(catalog) ? catalog : catalog.samples || [];
        const mode = Array.isArray(catalog) ? 'online' : catalog.backendMode || 'error';
        setSampleCatalog(samples);
        setBackendMode(mode);
      })
      .catch(() => {
        if (!active) return;
        setBackendMode('error');
      });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    let active = true;
    fetchMoonTextures().then((urls) => {
      if (active) setMoonTextures(urls);
    });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    console.info('[analysis] State', { status: analysisStatus, size: analysis?.terrain?.size || 0, error: analysisError || null });
  }, [analysisStatus, analysis, analysisError]);

  const applyAnalysisResult = useCallback((result) => {
    setEnvironment(previous=>({...previous,features:[],water:false,waterLevel:Math.round((result?.terrain?.elevationOrigin||0)+(result?.terrain?.minH||0)+((result?.terrain?.maxH||0)-(result?.terrain?.minH||0))*.25)}));
    if (result?.terrain) {result.terrain.body = deriveBody(result.metadata);result.terrain.metric=hasRehearsalScale(result);}
    const provenance = result?.metadata?.provenance;
    if (result?.terrain) result.coordinateFrame = provenance?.body === 'moon' && Number.isFinite(provenance.origin_lat) && Number.isFinite(provenance.origin_lon)
      ? lunarLocalFrame(provenance.origin_lat, provenance.origin_lon)
      : createLocalFrame([0, result.terrain.elevationOrigin || 0, 0], undefined, 'dataset local; global placement unknown');
    if(result?.terrain)result.coordinates=datasetCoordinateContext(provenance || {},result.terrain);
    setDiagnostics({});
    setBenchmarkMode('tiled');
    setAnalysis(result);
    setReport(null);
    const topZone = result?.landingZones?.[0] || null;
    setSelectedZoneId(topZone?.id || null);
    const initialPoint = topZone
      ? { x: topZone.x, y: topZone.y - (result.terrain.elevationOrigin || 0), z: topZone.z, metrics: inspectTerrainPoint(result, topZone.x, topZone.z) }
      : null;
    setInspectedPoint(initialPoint);
    setFocusPoint(null);
    setVerticalExaggeration(1); setPlacement(null); setSelectedObjectId(null); setScenarioError(''); setScenarioBusy(false);
    placementAbort.current?.abort();
    setViewMode(DEFAULT_VIEW);
    setPhase('workspace');
  }, []);
  const imageUrl=analysis?.metadata?.ownedColorUrl;
  const imageUrlCleanup=useRef(new Map());
  useEffect(()=> {
    clearTimeout(imageUrlCleanup.current.get(imageUrl));imageUrlCleanup.current.delete(imageUrl);
    return()=>{if(imageUrl)imageUrlCleanup.current.set(imageUrl,setTimeout(()=> {
      URL.revokeObjectURL(imageUrl);imageUrlCleanup.current.delete(imageUrl);
    },0));};
  },[imageUrl]);
  const handleImageScale=useCallback(scale=> {
    try {applyAnalysisResult(applyImageScale(analysis,scale));setAnalysisStatus('ready');}
    catch(error){setScenarioError(error.message);}
  },[analysis,applyAnalysisResult]);

  const cancelAcquisition = useCallback(() => {
    ++analysisRequest.current;
    acquisitionAbort.current?.abort();
    flightFinished.current?.(); flightFinished.current = null;
    buildStarted.current = null;
    setFlyToMission(null);
    setSelectedLocation(previous => previous && !['loaded','unavailable','error','not-loaded'].includes(previous.terrainDataStatus)
      ? { ...previous, terrainDataStatus: 'not-loaded' } : previous);
    setAcquisition(null);
    setAnalysisError('');
    setAnalysisStatus(analysis ? 'ready' : 'idle');
  }, [analysis]);

  useEffect(()=> {
    if(!import.meta.env.DEV)return;
    globalThis.__BHUVAN_DEV__={
      loadStreamingBenchmark:async size=> {cancelAcquisition();const result=await developmentStreamingAnalysis(size);applyAnalysisResult(result);setAnalysisStatus('ready');},
      getAnalysis:()=>analysis,
      getOrbitState:()=>({phase,navigation:orbitNavigation,location:selectedLocation}),
    };
    return()=> {delete globalThis.__BHUVAN_DEV__;};
  },[analysis,applyAnalysisResult,cancelAcquisition,phase,orbitNavigation,selectedLocation]);

  const handleAnalyzeSample = useCallback(async (sampleId) => {
    cancelAcquisition();
    const request = ++analysisRequest.current;
    setAnalysisStatus('loading');
    setAnalysisError('');
    try {
      const result = await analyzeSample(sampleId);
      if (request !== analysisRequest.current) return;
      applyAnalysisResult(result);
      setAnalysisStatus('ready');
    } catch (error) {
      if (request !== analysisRequest.current) return;
      setAnalysisStatus('error');
      setAnalysisError(error.message || 'Analysis failed.');
    }
  }, [applyAnalysisResult, cancelAcquisition]);

  useEffect(() => () => acquisitionAbort.current?.abort(), []);

  const handleGlobeSiteSelected = useCallback(async (site) => {
    setGatewayView(false);
    acquisitionAbort.current?.abort();
    flightFinished.current?.();
    const controller = new AbortController(); acquisitionAbort.current = controller;
    const request = ++analysisRequest.current;
    const location = { body: site.body || body, lat: site.lat, lon: site.lon,
      region_size_m: site.region_size_m || regionSizeKm * 1000,
      lroc_dataset:site.lroc_dataset||null,
      overview:site.lroc_dataset ? false : wideArea,
      sentinel_imagery: (site.body || body) === 'earth' && sentinelImagery };
    if (!Number.isFinite(location.region_size_m) || location.region_size_m < 500 || location.region_size_m > 30000) {
      setAnalysisError('Region size must be between 0.5 and 30 km. Source resolution may require a smaller region.'); return;
    }
    setBody(location.body);
    setWorkspacePanel(null);
    const selection = createSelectedLocation(location.body, location.lat, location.lon);
    setSelectedLocation({ ...selection, terrainDataStatus: 'locating' });
    setOrbitNavigation(previous => ({ level: 'region', body: location.body, revision: previous.revision + 1 }));
    setPhase('globe');
    setSelectedMission(null);
    setFlyToMission(location);
    setAcquisition({ site: location, status: 'loading', steps: {}, detail: 'Contacting terrain provider…' });
    const flight = new Promise(resolve => { flightFinished.current = resolve; });
    setAnalysisStatus('loading');
    setAnalysisError('');
    try {
      const result = await acquireLocationTerrain(location, { signal: controller.signal, onStage: event => {
        if (request !== analysisRequest.current) return;
        setSelectedLocation(previous => previous && ({ ...previous, terrainDataStatus: event.stage.toLowerCase() }));
        setAcquisition(previous => previous && ({ ...previous, detail: event.detail,
          steps: { ...previous.steps, [event.stage]: event } }));
      }});
      await flight;
      if (request !== analysisRequest.current) return;
      const association = { ...selection, terrainDataStatus: 'loaded', dataset: result.metadata?.provenance?.dataset_id || result.jobId,
        source: result.metadata?.source || null,
        datasetReference: result.metadata?.provenance || null };
      result.locationAssociation = association;
      setSelectedLocation(association);
      buildStarted.current = { request, jobId: result.jobId, time: performance.now() };
      setAcquisition(previous => ({ ...previous, status: 'building', detail: 'Preparing and drawing the measured DEM working set…',
        steps: { ...previous.steps, 'BUILDING TERRAIN': { status: 'started' } } }));
      setBackendMode('online');
      applyAnalysisResult(result);
      setAnalysisStatus('ready');
    } catch (error) {
      if (request !== analysisRequest.current || controller.signal.aborted) return;
      setAnalysisStatus('error');
      setAnalysisError(error.message || 'Terrain acquisition failed.');
      setSelectedLocation(previous => previous && ({ ...previous,
        terrainDataStatus: error.code === 'DATA_UNAVAILABLE' ? 'unavailable' : 'error' }));
      setAcquisition(previous => previous && ({ ...previous, status: 'error', code: error.code, detail: error.message }));
      setFlyToMission(null);
      flightFinished.current?.(); flightFinished.current = null;
    }
  }, [applyAnalysisResult, body, regionSizeKm, sentinelImagery,wideArea]);

  const handleFlightComplete = useCallback(() => {
    flightFinished.current?.(); flightFinished.current = null;
  }, []);

  const handleTerrainReady = useCallback(jobId => {
    const build = buildStarted.current;
    if (!build || build.request !== analysisRequest.current || build.jobId !== jobId) return;
    buildStarted.current = null;
    setFlyToMission(null);
    setAcquisition(previous => previous && ({ ...previous, status: 'done', detail: 'DEM working set rendered.',
      steps: { ...previous.steps, 'BUILDING TERRAIN': { status: 'completed', elapsed_ms: performance.now() - build.time } } }));
    setTimeout(() => {
      if (build.request === analysisRequest.current) setAcquisition(previous => previous?.status === 'done' ? null : previous);
    }, 700);
  }, []);

  const handleLoadRegion = useCallback((lat, lon) => handleGlobeSiteSelected({ body: 'earth', lat, lon }), [handleGlobeSiteSelected]);
  const handleTerrainError = useCallback((jobId, detail) => {
    if (buildStarted.current?.jobId !== jobId) return;
    buildStarted.current = null;
    setAcquisition(previous => previous && ({ ...previous, status: 'error', code: 'TERRAIN_RENDER_FAILED', detail }));
  }, []);

  const handleUpload = useCallback(async (file,orthophoto=null) => {
    if (!file) return;
    cancelAcquisition();
    const request = ++analysisRequest.current;
    setAnalysisStatus('loading');
    setAnalysisError('');
    try {
      const result = await analyzeUpload(file,orthophoto);
      if (request !== analysisRequest.current) return;
      setBackendMode('online');
      applyAnalysisResult(result.metadata?.provenance?.metric===false?applyImageScale(result):result);
      setAnalysisStatus('ready');
    } catch (error) {
      if (request !== analysisRequest.current) return;
      setAnalysisStatus('error');
      setAnalysisError(error.message || 'Upload analysis failed.');
    }
  }, [applyAnalysisResult, cancelAcquisition]);

  // Edge-AI path: run the neural depth estimator ON THIS DEVICE (WebGPU), then
  // push the inferred depth field through the classical terrain pipeline.
  const handleEdgeAnalyze = useCallback(async (file) => {
    if (!file) return;
    cancelAcquisition();
    const request = ++analysisRequest.current;
    setAnalysisStatus('loading');
    setAnalysisError('');
    setEdgeInfo({ status: 'running' });
    setPhase('workspace');
    try {
      const { estimateDepth } = await import('./lib/edgeDepth');
      const depth = await estimateDepth(file, { gridSize: 385 });
      if (request !== analysisRequest.current) return;
      setEdgeInfo({ status: 'ready', device: depth.device, ms: depth.ms, model: depth.model });
      const result = depthRehearsalAnalysis(depth,{name:file.name||'Image rehearsal',
        jobId:crypto.randomUUID(),colorUrl:URL.createObjectURL(file)});
      if (request !== analysisRequest.current) return;
      applyAnalysisResult(result);
      setAnalysisStatus('ready');
    } catch (error) {
      if (request !== analysisRequest.current) return;
      setAnalysisStatus('error');
      setAnalysisError(error.message || 'Edge analysis failed.');
      setEdgeInfo({ status: 'error', error: error.message || 'failed' });
    }
  }, [applyAnalysisResult, cancelAcquisition]);

  const handleSurveyMission = useCallback((mission) => {
    handleGlobeSiteSelected({ body: 'moon', lat: mission.lat, lon: mission.lon });
  }, [handleGlobeSiteSelected]);

  const handleEnterWorkspace = useCallback(panel => {
    setGatewayView(false);
    cancelAcquisition();
    setWorkspacePanel(typeof panel === 'string' ? panel : null);
    setPhase('workspace');
  }, [cancelAcquisition]);

  const handleBackToGlobe = useCallback(() => {
    cancelAcquisition();
    setPhase('globe');
    const location = analysis?.locationAssociation || selectedLocation;
    if (location) setSelectedLocation(location);
    const contextBody = location?.body || body;
    setBody(contextBody);
    setOrbitNavigation(previous => ({ level: location ? 'region' : 'body', body: contextBody, revision: previous.revision + 1 }));
  }, [cancelAcquisition, analysis, selectedLocation, body]);

  const handleFocusBody = useCallback(value => {
    setGatewayView(false); cancelAcquisition(); setBody(value); setSelectedMission(null); setPhase('globe');
    setOrbitNavigation(previous => ({ level: 'body', body: value, revision: previous.revision + 1 }));
  }, [cancelAcquisition]);

  const handleOrbitBack = useCallback(() => {
    setGatewayView(false);
    cancelAcquisition(); setSelectedMission(null);
    setOrbitNavigation(previous => ({ ...previous, level: previousOrbitLevel(previous.level), revision: previous.revision + 1 }));
  }, [cancelAcquisition]);

  const handleFocusPoint = useCallback(point => {
    if (!point) return;
    setFocusPoint({ x: point.x, y: point.y, z: point.z, mode: point.mode || 'focus' });
  }, []);

  useEffect(() => {
    const navigate = event => {
      if (event.defaultPrevented || /INPUT|TEXTAREA|SELECT/.test(event.target?.tagName) || event.target?.isContentEditable) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        if (placement) { setPlacement(null); return; }
        if (report) { setReport(null); return; }
        if (selectedMission) { setSelectedMission(null); return; }
        if (document.querySelector('.hud-overlay.panel-open')) {
          window.dispatchEvent(new Event('bhuvan-close-panels')); return;
        }
        if (document.querySelector('.orbit-info-panel')) {
          window.dispatchEvent(new Event('bhuvan-close-panels')); return;
        }
        if (phase === 'workspace') handleBackToGlobe(); else handleOrbitBack();
      } else if (event.key.toLowerCase() === 'f' && phase === 'workspace') {
        event.preventDefault(); window.dispatchEvent(new Event('bhuvan-focus-cursor'));
      }
    };
    window.addEventListener('keydown', navigate);
    return () => window.removeEventListener('keydown', navigate);
  }, [phase, report, selectedMission, placement, handleBackToGlobe, handleOrbitBack]);

  const handleInspectPoint = useCallback(async (wx, wz) => {
    if (!analysis) return;
    pointAbort.current?.abort();
    const controller=new AbortController();pointAbort.current=controller;
    try {
      const terrain=analysis.terrain;
      const index=v=>Math.max(0,Math.min(terrain.size-1,Math.round((v/terrain.scale+.5)*(terrain.size-1))));
      const metrics=terrain.tileSource ? await terrain.tileSource.inspect(index(wx),index(wz),{signal:controller.signal}) : inspectTerrainPoint(analysis,wx,wz);
      if(!controller.signal.aborted && metrics)setInspectedPoint({x:wx,y:metrics.elevation-(terrain.elevationOrigin||0),z:wz,metrics});
    } catch(error) {
      if(!controller.signal.aborted)console.error('[analysis] Native point inspection failed',error);
    }
  }, [analysis]);

  useEffect(()=> {
    const first=analysis?.landingZones?.[0];
    if(analysis?.terrain.tileSource && first)handleInspectPoint(first.x,first.z);
    return()=>pointAbort.current?.abort();
  },[analysis,handleInspectPoint]);

  const handleSelectZoneById = useCallback((zoneId) => {
    const zone = analysis?.landingZones?.find((candidate) => candidate.id === zoneId);
    if (!zone) return;
    setSelectedZoneId(zone.id);
    const point = {
      x: zone.x,
      y: zone.y - (analysis.terrain.elevationOrigin || 0),
      z: zone.z,
      metrics: inspectTerrainPoint(analysis, zone.x, zone.z),
    };
    setInspectedPoint(point);
    setFocusPoint(point);
    if(analysis.terrain.tileSource)handleInspectPoint(zone.x,zone.z);
  }, [analysis,handleInspectPoint]);

  const handleFocusInterestRegion = useCallback((poi) => {
    if (!analysis) return;
    const metrics = inspectTerrainPoint(analysis, poi.x, poi.z);
    const point = { x: poi.x, y: metrics ? metrics.elevation - (analysis.terrain.elevationOrigin || 0) : sampleHeight(analysis.terrain,poi.x,poi.z), z: poi.z, metrics };
    setInspectedPoint(point);
    setFocusPoint(point);
    if(analysis.terrain.tileSource)handleInspectPoint(poi.x,poi.z);
  }, [analysis,handleInspectPoint]);

  const handleObjectMove = useCallback(async (id, x, z, type) => {
    if (!analysis?.terrain) return;
    placementAbort.current?.abort(); const controller = new AbortController(); placementAbort.current = controller;
    setScenarioBusy(true); setScenarioError('');
    try {
      const attachment = await terrainAttachment(analysis.terrain, x, z, controller.signal);
      if (controller.signal.aborted) return;
      const timestamp = clock.elapsed, objectId = id || crypto.randomUUID();
      setObjectsByDataset(previous => {
        const objects = previous[datasetKey] || [];
        const updated = id ? objects.map(o => o.id === id ? { ...o, attachment,
          position: [attachment.x, attachment.localHeight, attachment.z], timestamp } : o)
          : [...objects, createScenarioObject(type, attachment, datasetKey, timestamp, objectId)];
        return { ...previous, [datasetKey]: updated };
      });
      setPlacement(null);
      setSelectedObjectId(objectId);
    } catch (error) { if (!controller.signal.aborted) setScenarioError(error.message); }
    finally { if (!controller.signal.aborted) setScenarioBusy(false); }
  }, [analysis, datasetKey, clock]);
  const handlePlaceObject = useCallback(point => {
    if (placement) handleObjectMove(placement.id, point.x, point.z, placement.type);
  }, [placement, handleObjectMove]);
  const handleObjectRotate = useCallback((id, degrees) => {
    setObjectsByDataset(previous => ({ ...previous, [datasetKey]: (previous[datasetKey] || []).map(o => o.id === id
      ? { ...o, orientation: [0, degrees * Math.PI / 180, 0], timestamp: clock.elapsed } : o) }));
  }, [datasetKey, clock]);
  useEffect(() => () => placementAbort.current?.abort(), []);

  const handleGenerateReport = useCallback(async (kind) => {
    if (!analysis?.jobId) return;
    setReportBusy(true);
    try {
      const result = await generateReport(analysis.jobId, kind);
      setReport(result);
    } catch (error) {
      setAnalysisError(error.message || 'Report generation failed.');
    } finally {
      setReportBusy(false);
    }
  }, [analysis]);

  const handleToggleDebug = useCallback(() => {
    if (!import.meta.env.DEV) return;
    setDebugMode((current) => !current);
  }, []);

  return (
    <div onClickCapture={event=>{if(performanceOpen&&event.target.closest('.hud-overlay button,.orbit-overlay button'))setPerformanceOpen(false);}} className={`simulation-root liquid-ui phase-${phase} ${performanceOpen?'performance-open':''} ${roverView!=='orbit'?'rover-view':''}`}>
      <WaterInteractions />
      <SceneErrorBoundary>
        <MoonGlobe mission={{analysis,location:lunarMissionOrigin(analysis),route:roverRoute,runtime:roverRuntime,body:analysis?.terrain?.body}}
          performanceOpen={performanceOpen} onStats={handleStats} gatewayView={gatewayView} active={phase === 'globe'} navigation={orbitNavigation} location={selectedLocation}
          textureUrls={moonTextures} onMissionSelect={setSelectedMission}
          onSiteSelected={handleGlobeSiteSelected} onFocusBody={handleFocusBody}
          flyToMission={flyToMission} onTransitionComplete={handleFlightComplete}
          acquisitionLocked={Boolean(acquisition && acquisition.status !== 'error')}
          onGlReady={handleGlReady} onTextureSource={setMoonTextureSource}
          orbitMotion={orbitMotion} onOrbitTime={setOrbitModelDays} qualityTier={qualityTier}
        />
      </SceneErrorBoundary>
      {phase === 'globe' && <>
        <GlobeOverlay gatewayView={gatewayView} onGatewayView={()=>{handleFocusBody('moon');setGatewayView(!gatewayView);}} body={body} navigation={orbitNavigation} location={selectedLocation}
          onBodyChange={handleFocusBody} onBack={handleOrbitBack}
          wideArea={wideArea} onWideArea={setWideArea} regionSizeKm={regionSizeKm} onRegionSizeChange={setRegionSizeKm}
          sentinelImagery={sentinelImagery} onSentinelImageryChange={setSentinelImagery}
          analysisStatus={analysisStatus} analysisError={analysisError}
          textureSource={moonTextureSource} onSelectMission={setSelectedMission}
          onOpenWorkbench={handleEnterWorkspace} orbitMotion={orbitMotion} orbitModelDays={orbitModelDays} onOrbitMotion={setOrbitMotion} clientGpu={clientGpu}/>
        <MissionDossier mission={selectedMission} onClose={() => setSelectedMission(null)} onSurvey={handleSurveyMission} />
      </>}
      {phase === 'workspace' && <>
      <SceneErrorBoundary>
        <SceneCanvas
          analysis={analysis} viewMode={viewMode} landingTarget={landingTarget}
          landingTargetHazard={landingTargetHazard} inspectedPoint={inspectedPoint}
          focusPoint={focusPoint} onFocusPoint={handleFocusPoint}
          interestRegions={analysis?.intelligence?.interest_regions || []}
          onFocusInterestRegion={handleFocusInterestRegion}
          onInspectPoint={handleInspectPoint} debugMode={debugMode}
          onGlReady={handleGlReady} analysisStatus={analysisStatus} analysisError={analysisError}
          performanceOpen={performanceOpen} onStats={handleStats} benchmarkMode={benchmarkMode}
          onTerrainReady={handleTerrainReady} onTerrainError={handleTerrainError}
          qualityTier={qualityTier} verticalExaggeration={verticalExaggeration} ambience={ambience} clock={clock}
          simulationPlaying={clockState.playing} environment={environment} roverRoute={roverRoute} routeChoices={routeChoices} roverRuntime={roverRuntime} roverProfileId={roverSettings.profileId} roverView={roverView} onRoverView={setRoverView}
          keepMetricZoom={keepMetricZoom} onMetricZoom={setKeepMetricZoom} cameraMemory={terrainCameraMemory}
          scenarioObjects={scenarioObjects} selectedObjectId={selectedObjectId} placement={placement}
          onPlaceObject={handlePlaceObject} onSelectObject={setSelectedObjectId} onMoveObject={handleObjectMove}
          scenarioError={scenarioError} scenarioBusy={scenarioBusy}
        />
      </SceneErrorBoundary>
      {captureNotice&&<div className="capture-notice" role="status">{captureNotice}</div>}
      <pre id="perf-stats" className="perf-stats" />
      <HUD
        initialPanel={workspacePanel}
        backendMode={backendMode}
        analysis={analysis}
        analysisStatus={analysisStatus}
        analysisError={analysisError}
        sampleCatalog={sampleCatalog}
        selectedZoneId={selectedZoneId}
        inspectedPoint={inspectedPoint}
        viewMode={viewMode}
        debugMode={debugMode}
        reportBusy={reportBusy}
        onViewModeChange={setViewMode}
        onEngineeringRange={width=>{cancelAcquisition();applyAnalysisResult(engineeringRange(width));setAnalysisStatus('ready');}} onAnalyzeSample={handleAnalyzeSample}
        onUpload={(file,orthophoto)=>file&&!orthophoto&&!/\.(tif|tiff|geotiff)$/i.test(file.name)?handleEdgeAnalyze(file):handleUpload(file,orthophoto)}
        onEdgeAnalyze={handleEdgeAnalyze}
        edgeInfo={edgeInfo}
        diagnostics={diagnostics}
        benchmarkMode={benchmarkMode}
        onBenchmarkMode={setBenchmarkMode}
        onLoadRegion={handleLoadRegion}
        onSelectZone={handleSelectZoneById}
        onFocusInterestRegion={handleFocusInterestRegion}
        onGenerateReport={handleGenerateReport}
        onToggleDebug={handleToggleDebug}
        onBackToGlobe={handleBackToGlobe}
        qualityTier={qualityTier} onQualityChange={setQualityTier} clientGpu={clientGpu}
        verticalExaggeration={verticalExaggeration} onExaggerationChange={setVerticalExaggeration}
        ambience={ambience} onAmbienceChange={setAmbience}
        environment={environment} onEnvironmentChange={setEnvironment}
        roverRoute={roverRoute} roverTelemetry={roverTelemetry} roverSettings={roverSettings} onRoverSettings={setRoverSettings}
        routeChoices={routeChoices} onRouteChoice={handleRouteChoice} onImageScale={handleImageScale}
        roverView={roverView} onRoverView={setRoverView} onPlanRoute={handlePlanRoute} onDemoScenario={handleDemoScenario}
        wideArea={wideArea} onWideArea={setWideArea} regionSizeKm={regionSizeKm} onRegionSizeChange={setRegionSizeKm} onAcquireSite={handleGlobeSiteSelected}
        clockState={clockState} onClock={handleClock}
        scenarioObjects={scenarioObjects} selectedObjectId={selectedObjectId} onSelectObject={setSelectedObjectId}
        placement={placement} onPlacement={value => { setScenarioError(''); setPlacement(value); }} onObjectMove={handleObjectMove} onObjectRotate={handleObjectRotate} onObjectConstraint={(id,key,value)=>setObjectsByDataset(previous=>({...previous,[datasetKey]:(previous[datasetKey]||[]).map(o=>o.id===id?{...o,constraints:{...o.constraints,[key]:value}}:o)}))}
        scenarioError={scenarioError} scenarioBusy={scenarioBusy}
      />
      <ReportModal report={report} onClose={() => setReport(null)} />
      </>}
      <button className="performance-launch" aria-expanded={performanceOpen} onClick={()=>{window.dispatchEvent(new Event('bhuvan-close-panels'));setPerformanceOpen(v=>!v);}}>Performance</button>
      {performanceOpen && <PerformancePanel gpu={clientGpu} stats={diagnostics} onClose={()=>setPerformanceOpen(false)}/>}
      <AcquisitionPanel acquisition={acquisition} onCancel={cancelAcquisition} onOpenWorkbench={handleEnterWorkspace} />
    </div>
  );
}
