import React, { useState, useCallback, useEffect, useMemo, useRef } from 'react';
import IntroScreen from './components/IntroScreen';
import HUD from './components/HUD';
import DebugOverlay from './components/DebugOverlay';
import SceneCanvas from './scene/SceneCanvas';
import { inspectTerrainPoint, sampleHeight, sampleRaster, hazardLevel } from './engine/terrain';
import { createLanderState, updateLander, computeAutopilot } from './engine/physics';
import { analyzeSample, analyzeUpload, fetchSampleCatalog } from './lib/api';
import { generateMissionReport, downloadReport } from './engine/missionReport';
import {
  resumeAudio,
  startWind,
  startThruster,
  setThrusterLevel,
  stopThruster,
  startWarningBeep,
  stopWarningBeep,
  playImpact,
  stopAll,
} from './engine/audio';

const DEFAULT_VIEW = 'hazard';

function createMissionReport(analysis, selectedZone, finalState) {
  const terrainName = analysis?.metadata?.terrainName || 'Unknown Terrain';
  const prediction = selectedZone
    ? {
        score: selectedZone.score,
        classification: selectedZone.classification,
      }
    : null;

  const actual = {
    hazard: Number(((finalState.touchdownRisk || 0) * 100).toFixed(1)),
    traversability: Number(((finalState.touchdownTraversability || 0) * 100).toFixed(1)),
    assessment: finalState.crashed ? 'crashed' : finalState.touchdownAssessment,
  };

  return {
    terrainName,
    prediction,
    actual,
    outcome: finalState.crashed ? 'crashed' : 'landed',
    safeAreaPct: analysis?.metadata?.safeAreaPct ?? null,
  };
}

export default function App() {
  const [phase, setPhase] = useState('intro');
  const [viewMode, setViewMode] = useState(DEFAULT_VIEW);
  const [analysis, setAnalysis] = useState(null);
  const [analysisStatus, setAnalysisStatus] = useState('idle');
  const [analysisError, setAnalysisError] = useState('');
  const [sampleCatalog, setSampleCatalog] = useState([]);
  const [selectedZoneId, setSelectedZoneId] = useState(null);
  const [inspectedPoint, setInspectedPoint] = useState(null);
  const [landerState, setLanderState] = useState(null);
  const [missionReport, setMissionReport] = useState(null);
  const [autopilot, setAutopilot] = useState(true);
  const [backendMode, setBackendMode] = useState('connecting');
  const [debugMode, setDebugMode] = useState(false);

  const keysRef = useRef({});
  const landerRef = useRef(null);
  const rafRef = useRef(null);
  const lastTimeRef = useRef(null);

  // Separate state for HUD to reduce App re-renders
  const [hudState, setHudState] = useState({});

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
    const onDown = (e) => { 
      const key = e.key.toLowerCase();
      keysRef.current[key] = true; 
    };
    const onUp = (e) => { 
      const key = e.key.toLowerCase();
      keysRef.current[key] = false; 
    };
    window.addEventListener('keydown', onDown);
    window.addEventListener('keyup', onUp);
    return () => {
      window.removeEventListener('keydown', onDown);
      window.removeEventListener('keyup', onUp);
    };
  }, []);

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
        if (mode !== 'online') {
          setAnalysisError('Backend unavailable. Using local demo terrain.');
        }
      })
      .catch((err) => {
        if (!active) return;
        console.warn('Backend unavailable, using limited functionality.');
        setAnalysisError('Backend unavailable. Using local mode.');
        setBackendMode('error');
      });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      stopAll();
    };
  }, []);

  const setSelectedZone = useCallback((zone) => {
    setSelectedZoneId(zone?.id || null);
    if (zone && analysis) {
      setInspectedPoint({
        x: zone.x,
        y: zone.y,
        z: zone.z,
        metrics: inspectTerrainPoint(analysis, zone.x, zone.z),
      });
    }
  }, [analysis]);

  const applyAnalysisResult = useCallback((result) => {
    setAnalysis(result);
    setMissionReport(null);
    setLanderState(null);
    setHudState({});
    landerRef.current = null;
    const topZone = result?.landingZones?.[0] || null;
    setSelectedZoneId(topZone?.id || null);
    setInspectedPoint(
      topZone
        ? { x: topZone.x, y: topZone.y, z: topZone.z, metrics: inspectTerrainPoint(result, topZone.x, topZone.z) }
        : null
    );
    setViewMode(DEFAULT_VIEW);
    setPhase('inspect3d');
  }, []);

  const handleAnalyzeSample = useCallback(async (sampleId) => {
    setAnalysisStatus('loading');
    setAnalysisError('');
    try {
      const result = await analyzeSample(sampleId);
      applyAnalysisResult(result);
      setAnalysisStatus('ready');
    } catch (error) {
      setAnalysisStatus('error');
      setAnalysisError(error.message || 'Analysis failed.');
    }
  }, [applyAnalysisResult]);

  const handleUpload = useCallback(async (file) => {
    if (!file) return;
    setAnalysisStatus('loading');
    setAnalysisError('');
    try {
      const result = await analyzeUpload(file);
      setBackendMode('online');
      applyAnalysisResult(result);
      setAnalysisStatus('ready');
    } catch (error) {
      setAnalysisStatus('error');
      setAnalysisError(error.message || 'Upload analysis failed.');
    }
  }, [applyAnalysisResult]);

  const handleStart = useCallback(() => {
    resumeAudio();
    startWind();
    setPhase('analyze');
  }, []);

  const handleInspectPoint = useCallback((wx, wz) => {
    if (!analysis) return;
    const metrics = inspectTerrainPoint(analysis, wx, wz);
    setInspectedPoint({ x: wx, y: metrics.elevation, z: wz, metrics });
  }, [analysis]);

  const handleSelectZoneById = useCallback((zoneId) => {
    const zone = analysis?.landingZones?.find((candidate) => candidate.id === zoneId);
    if (!zone) return;
    setSelectedZone(zone);
  }, [analysis, setSelectedZone]);

  const handleInitDescent = useCallback(() => {
    if (!analysis || !selectedZone) return;

    if (rafRef.current) cancelAnimationFrame(rafRef.current);

    const state = createLanderState(selectedZone.x, selectedZone.z, 120);
    state.targetX = selectedZone.x;
    state.targetZ = selectedZone.z;
    landerRef.current = state;
    setLanderState(state); // Initial state for sync
    setHudState(state);
    setMissionReport(null);

    resumeAudio();
    startThruster();
    setPhase('descent');
    lastTimeRef.current = performance.now();

    let frameCount = 0;
    const loop = (time) => {
      const dt = Math.min((time - (lastTimeRef.current || time)) / 1000, 0.05);
      lastTimeRef.current = time;

      let stateRef = landerRef.current;
      if (!stateRef || stateRef.landed || stateRef.crashed) {
        if (stateRef && (stateRef.landed || stateRef.crashed)) {
          stopThruster();
          stopWarningBeep();
          playImpact(stateRef.crashed);
          const finalReport = createMissionReport(analysis, selectedZone, stateRef);
          setMissionReport(finalReport);
          setLanderState({ ...stateRef }); // Final state sync
          setHudState({ ...stateRef });
          setPhase('report');
        }
        return;
      }

      if (!autopilot) {
        const keys = keysRef.current;
        let throttle = stateRef.throttle;
        
        // W/S: MAIN ENGINE THROTTLE
        if (keys.w || keys.arrowup) throttle = Math.min(1, throttle + 1.5 * dt);
        else if (keys.s || keys.arrowdown) throttle = Math.max(0, throttle - 1.5 * dt);
        stateRef.throttle = throttle;
        
        // A/D: STRAFE LEFT/RIGHT (LATERAL X)
        stateRef.lateralX = (keys.d ? 1 : 0) + (keys.a ? -1 : 0);
        
        // Q/E: YAW CONTROL
        stateRef.rcsYaw = (keys.e ? 0.6 : 0) + (keys.q ? -0.6 : 0);
        
        // ARROW KEYS: FINE LATERAL CONTROL (X/Z)
        if (keys.arrowleft) stateRef.lateralX = -1;
        if (keys.arrowright) stateRef.lateralX = 1;
        stateRef.lateralZ = (keys.arrowdown ? 1 : 0) + (keys.arrowup ? -1 : 0);

        // Stabilize attitude if no pitch/roll commands
        stateRef.pitchCmd = 0;
        stateRef.rollCmd = 0;
      } else {
        const groundH = sampleHeight(analysis.terrain, stateRef.x, stateRef.z);
        const ap = computeAutopilot(stateRef, groundH, analysis.layers.hazard, analysis.terrain);
        stateRef.throttle = ap.throttle;
        stateRef.lateralX = ap.lateralX;
        stateRef.lateralZ = ap.lateralZ;
        stateRef.rcsYaw = ap.rcsYaw;
        stateRef.pitchCmd = ap.pitchCmd;
        stateRef.rollCmd = ap.rollCmd;
        stateRef.guidanceMode = ap.guidanceMode;
      }

      const groundH = sampleHeight(analysis.terrain, stateRef.x, stateRef.z);
      const surfaceAssessment = {
        hazard: sampleRaster(analysis.layers.hazard, analysis.terrain, stateRef.x, stateRef.z),
        traversability: sampleRaster(analysis.layers.traversability, analysis.terrain, stateRef.x, stateRef.z),
      };
      
      const newState = updateLander(stateRef, dt, groundH, surfaceAssessment);
      landerRef.current = newState;

      // Update HUD state at 30fps to save React overhead
      frameCount++;
      if (frameCount % 2 === 0) {
        setHudState({ ...newState });
      }

      setThrusterLevel(newState.throttle);
      const alt = newState.y - groundH;
      if (alt < 20 || surfaceAssessment.hazard > 0.55) {
        startWarningBeep(alt < 8 || surfaceAssessment.hazard > 0.7 ? 300 : 700);
      } else {
        stopWarningBeep();
      }

      rafRef.current = requestAnimationFrame(loop);
    };

    rafRef.current = requestAnimationFrame(loop);
  }, [analysis, autopilot, selectedZone]);


  const handleReturnToInspection = useCallback(() => {
    setPhase('inspect3d');
  }, []);

  const handleToggleAutopilot = useCallback(() => {
    setAutopilot((current) => !current);
  }, []);

  const handleToggleDebug = useCallback(() => {
    setDebugMode((current) => !current);
  }, []);

  const handleExportReport = useCallback(() => {
    const report = generateMissionReport(analysis, selectedZone, landerRef.current, missionReport);
    downloadReport(report);
  }, [analysis, selectedZone, missionReport]);

  if (phase === 'intro') {
    return <IntroScreen onStart={handleStart} />;
  }

  return (
    <div className="simulation-root">
      <SceneCanvas
        phase={phase}
        analysis={analysis}
        landerRef={landerRef}
        viewMode={viewMode}
        landingTarget={landingTarget}
        landingTargetHazard={landingTargetHazard}
        inspectedPoint={inspectedPoint}
        onInspectPoint={handleInspectPoint}
        debugMode={debugMode}
      />
      <pre id="perf-stats" className="perf-stats" />
      <HUD
        phase={phase}
        backendMode={backendMode}
        analysis={analysis}
        analysisStatus={analysisStatus}
        analysisError={analysisError}
        sampleCatalog={sampleCatalog}
        selectedZoneId={selectedZoneId}
        inspectedPoint={inspectedPoint}
        missionReport={missionReport}
        landerState={hudState || {}}
        viewMode={viewMode}
        autopilot={autopilot}
        debugMode={debugMode}
        onAnalyzeSample={handleAnalyzeSample}
        onUpload={handleUpload}
        onSelectZone={handleSelectZoneById}
        onViewModeChange={setViewMode}
        onInitDescent={handleInitDescent}
        onReturnToInspection={handleReturnToInspection}
        onToggleAutopilot={handleToggleAutopilot}
        onToggleDebug={handleToggleDebug}
        onExportReport={handleExportReport}
      />
      <DebugOverlay
        analysis={analysis}
        inspectedPoint={inspectedPoint}
        selectedZone={selectedZone}
        visible={debugMode}
      />
    </div>
  );
}
