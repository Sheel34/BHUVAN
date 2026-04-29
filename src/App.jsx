import React, { useState, useCallback, useEffect, useMemo, useRef } from 'react';
import IntroScreen from './components/IntroScreen';
import HUD from './components/HUD';
import SceneCanvas from './scene/SceneCanvas';
import { inspectTerrainPoint, sampleHeight, sampleRaster, hazardLevel } from './engine/terrain';
import { createLanderState, updateLander, computeAutopilot } from './engine/physics';
import { analyzeSample, analyzeUpload, fetchSampleCatalog } from './lib/api';
import { analyzeFallbackSample, getFallbackSamples } from './lib/fallbackAnalysis';
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

  const keysRef = useRef({});
  const landerRef = useRef(null);
  const rafRef = useRef(null);
  const lastTimeRef = useRef(null);

  const selectedZone = useMemo(
    () => analysis?.landingZones?.find((zone) => zone.id === selectedZoneId) || null,
    [analysis, selectedZoneId]
  );

  const landingTarget = selectedZone
    ? [selectedZone.x, selectedZone.y, selectedZone.z, selectedZone.radius]
    : null;
  const landingTargetHazard = selectedZone
    ? hazardLevel((100 - selectedZone.score) / 100)
    : 0;

  useEffect(() => {
    const onDown = (e) => { keysRef.current[e.key.toLowerCase()] = true; };
    const onUp = (e) => { keysRef.current[e.key.toLowerCase()] = false; };
    window.addEventListener('keydown', onDown);
    window.addEventListener('keyup', onUp);
    return () => {
      window.removeEventListener('keydown', onDown);
      window.removeEventListener('keyup', onUp);
    };
  }, []);

  useEffect(() => {
    let active = true;
    fetchSampleCatalog()
      .then((samples) => {
        if (!active) return;
        setSampleCatalog(samples);
        setBackendMode('online');
      })
      .catch(() => {
        if (!active) return;
        setSampleCatalog(getFallbackSamples());
        setBackendMode('fallback');
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
      const result = backendMode === 'online'
        ? await analyzeSample(sampleId)
        : analyzeFallbackSample(sampleId);
      applyAnalysisResult(result);
      setAnalysisStatus('ready');
    } catch (error) {
      setAnalysisStatus('error');
      setAnalysisError(error.message || 'Analysis failed.');
    }
  }, [applyAnalysisResult, backendMode]);

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
    landerRef.current = state;
    setLanderState(state);
    setMissionReport(null);

    resumeAudio();
    startThruster();
    setPhase('descent');
    lastTimeRef.current = performance.now();

    const loop = (time) => {
      const dt = Math.min((time - (lastTimeRef.current || time)) / 1000, 0.05);
      lastTimeRef.current = time;

      let stateRef = landerRef.current;
      if (!stateRef || stateRef.landed || stateRef.crashed) {
        if (stateRef && (stateRef.landed || stateRef.crashed)) {
          stopThruster();
          stopWarningBeep();
          playImpact(stateRef.crashed);
          setMissionReport(createMissionReport(analysis, selectedZone, stateRef));
          setLanderState({ ...stateRef });
          setPhase('report');
        }
        return;
      }

      if (!autopilot) {
        const keys = keysRef.current;
        let throttle = stateRef.throttle;
        if (keys.w || keys.arrowup) throttle = Math.min(1, throttle + 2 * dt);
        else if (keys.s || keys.arrowdown) throttle = Math.max(0, throttle - 2 * dt);
        stateRef.throttle = throttle;
        stateRef.lateralX = (keys.d ? 1 : 0) + (keys.a ? -1 : 0);
        stateRef.lateralZ = (keys.q ? -1 : 0) + (keys.e ? 1 : 0);
      } else {
        const groundH = sampleHeight(analysis.terrain, stateRef.x, stateRef.z);
        const ap = computeAutopilot(stateRef, groundH);
        stateRef.throttle = ap.throttle;
        stateRef.lateralX = ap.lateralX;
        stateRef.lateralZ = ap.lateralZ;
      }

      const groundH = sampleHeight(analysis.terrain, stateRef.x, stateRef.z);
      const surfaceAssessment = {
        hazard: sampleRaster(analysis.layers.hazard, analysis.terrain, stateRef.x, stateRef.z),
        traversability: sampleRaster(analysis.layers.traversability, analysis.terrain, stateRef.x, stateRef.z),
      };
      const newState = updateLander(stateRef, dt, groundH, surfaceAssessment);
      landerRef.current = newState;
      setLanderState({ ...newState });

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

  if (phase === 'intro') {
    return <IntroScreen onStart={handleStart} />;
  }

  return (
    <div className="simulation-root">
      <SceneCanvas
        phase={phase}
        analysis={analysis}
        landerState={landerState}
        viewMode={viewMode}
        landingTarget={landingTarget}
        landingTargetHazard={landingTargetHazard}
        inspectedPoint={inspectedPoint}
        onInspectPoint={handleInspectPoint}
      />
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
        landerState={landerState || {}}
        viewMode={viewMode}
        autopilot={autopilot}
        onAnalyzeSample={handleAnalyzeSample}
        onUpload={handleUpload}
        onSelectZone={handleSelectZoneById}
        onViewModeChange={setViewMode}
        onInitDescent={handleInitDescent}
        onReturnToInspection={handleReturnToInspection}
        onToggleAutopilot={handleToggleAutopilot}
      />
    </div>
  );
}
