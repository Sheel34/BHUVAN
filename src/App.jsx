import React, { useState, useCallback, useEffect, useMemo } from 'react';
import HUD from './components/HUD';
import DebugOverlay from './components/DebugOverlay';
import GlobeOverlay from './components/GlobeOverlay';
import MissionDossier from './components/MissionDossier';
import ReportModal from './components/ReportModal';
import SystemMonitor from './components/SystemMonitor';
import SceneCanvas from './scene/SceneCanvas';
import MoonGlobe from './scene/MoonGlobe';
import { inspectTerrainPoint } from './engine/terrain';
import {
  analyzeSample,
  analyzeUpload,
  fetchSampleCatalog,
  fetchMoonTextures,
  generateReport,
} from './lib/api';
import { resumeAudio, startWind, stopAll } from './engine/audio';

const DEFAULT_VIEW = 'hazard';

export default function App() {
  const [phase, setPhase] = useState('globe');
  const [moonTextures, setMoonTextures] = useState(null);
  const [viewMode, setViewMode] = useState(DEFAULT_VIEW);
  const [analysis, setAnalysis] = useState(null);
  const [analysisStatus, setAnalysisStatus] = useState('idle');
  const [analysisError, setAnalysisError] = useState('');
  const [sampleCatalog, setSampleCatalog] = useState([]);
  const [selectedZoneId, setSelectedZoneId] = useState(null);
  const [inspectedPoint, setInspectedPoint] = useState(null);
  // Camera focus is deliberate (zone/POI selection); the hover probe must
  // never move the camera.
  const [focusPoint, setFocusPoint] = useState(null);
  const [backendMode, setBackendMode] = useState('connecting');
  const [debugMode, setDebugMode] = useState(false);
  const [report, setReport] = useState(null);
  const [reportBusy, setReportBusy] = useState(false);
  const [selectedMission, setSelectedMission] = useState(null);
  const [flyToMission, setFlyToMission] = useState(null);

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
        if (mode !== 'online') {
          setAnalysisError('Backend unavailable. Using local demo terrain.');
        }
      })
      .catch(() => {
        if (!active) return;
        setAnalysisError('Backend unavailable. Using local mode.');
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

  useEffect(() => () => stopAll(), []);

  const applyAnalysisResult = useCallback((result) => {
    setAnalysis(result);
    setReport(null);
    const topZone = result?.landingZones?.[0] || null;
    setSelectedZoneId(topZone?.id || null);
    const initialPoint = topZone
      ? { x: topZone.x, y: topZone.y, z: topZone.z, metrics: inspectTerrainPoint(result, topZone.x, topZone.z) }
      : null;
    setInspectedPoint(initialPoint);
    setFocusPoint(initialPoint);
    setViewMode(DEFAULT_VIEW);
    setPhase('workspace');
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

  const handleGlobeSiteSelected = useCallback((site) => {
    resumeAudio();
    startWind();
    setSelectedMission(null);
    setFlyToMission(null);
    handleAnalyzeSample(site.sampleId);
  }, [handleAnalyzeSample]);

  // Dossier "run survey" → fly the globe to the site, then analyze it.
  const handleSurveyMission = useCallback((mission) => {
    setSelectedMission(null);
    setFlyToMission(mission);
  }, []);

  const handleEnterWorkspace = useCallback(() => {
    resumeAudio();
    startWind();
    setPhase('workspace');
  }, []);

  const handleBackToGlobe = useCallback(() => {
    setPhase('globe');
  }, []);

  const handleInspectPoint = useCallback((wx, wz) => {
    if (!analysis) return;
    const metrics = inspectTerrainPoint(analysis, wx, wz);
    setInspectedPoint({ x: wx, y: metrics.elevation, z: wz, metrics });
  }, [analysis]);

  const handleSelectZoneById = useCallback((zoneId) => {
    const zone = analysis?.landingZones?.find((candidate) => candidate.id === zoneId);
    if (!zone) return;
    setSelectedZoneId(zone.id);
    const point = {
      x: zone.x,
      y: zone.y,
      z: zone.z,
      metrics: inspectTerrainPoint(analysis, zone.x, zone.z),
    };
    setInspectedPoint(point);
    setFocusPoint(point);
  }, [analysis]);

  const handleFocusInterestRegion = useCallback((poi) => {
    if (!analysis) return;
    const metrics = inspectTerrainPoint(analysis, poi.x, poi.z);
    const point = { x: poi.x, y: metrics.elevation, z: poi.z, metrics };
    setInspectedPoint(point);
    setFocusPoint(point);
  }, [analysis]);

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
    setDebugMode((current) => !current);
  }, []);

  if (phase === 'globe') {
    return (
      <div className="simulation-root">
        <MoonGlobe
          textureUrls={moonTextures}
          onMissionSelect={setSelectedMission}
          onSiteSelected={handleGlobeSiteSelected}
          flyToMission={flyToMission}
        />
        <SystemMonitor />
        <GlobeOverlay
          analysisStatus={analysisStatus}
          analysisError={analysisError}
          textureSource={moonTextures ? 'real' : 'procedural'}
          onSelectMission={setSelectedMission}
          onOpenWorkbench={handleEnterWorkspace}
        />
        <MissionDossier
          mission={selectedMission}
          onClose={() => setSelectedMission(null)}
          onSurvey={handleSurveyMission}
        />
      </div>
    );
  }

  return (
    <div className="simulation-root">
      <SceneCanvas
        analysis={analysis}
        viewMode={viewMode}
        landingTarget={landingTarget}
        landingTargetHazard={landingTargetHazard}
        inspectedPoint={inspectedPoint}
        focusPoint={focusPoint}
        interestRegions={analysis?.intelligence?.interest_regions || []}
        onInspectPoint={handleInspectPoint}
        debugMode={debugMode}
      />
      <pre id="perf-stats" className="perf-stats" />
      <SystemMonitor />
      <HUD
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
        onAnalyzeSample={handleAnalyzeSample}
        onUpload={handleUpload}
        onSelectZone={handleSelectZoneById}
        onFocusInterestRegion={handleFocusInterestRegion}
        onGenerateReport={handleGenerateReport}
        onToggleDebug={handleToggleDebug}
        onBackToGlobe={handleBackToGlobe}
      />
      <DebugOverlay
        analysis={analysis}
        inspectedPoint={inspectedPoint}
        selectedZone={selectedZone}
        visible={debugMode}
      />
      <ReportModal report={report} onClose={() => setReport(null)} />
    </div>
  );
}
