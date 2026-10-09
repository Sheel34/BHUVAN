import MissionEvidence from './MissionEvidence';
import React, { useState, useEffect, useRef } from 'react';
import { LAYER_PALETTES } from '../engine/terrain';
import { useMobileQuality } from '../scene/rendering';
import { runDataBenchmark } from '../engine/benchmarks';
import { networkMetrics } from '../lib/api';
import { terrainDisplayMetadata } from '../engine/terrainNavigation';
import { EnvironmentPanel, ScenarioPanel } from './WorkspacePanels';
import BhuvanMark from './BhuvanMark';

function formatNum(n, decimals = 1) {
  return Number.isFinite(n) ? n.toFixed(decimals) : '--';
}

function LayerLegend({ viewMode, analysis, settings, point }) {
  if (viewMode === 'surface') return (
    <div className="hud-legend">Shaded surface · DEM boundary shown in grey</div>
  );
  const legend = LAYER_PALETTES[viewMode] || LAYER_PALETTES.elevation;
  const elevation = analysis?.intelligence?.elevation;
  const metric = analysis?.metadata?.provenance?.metric === true;
  const unit = metric ? 'm' : 'rel';
  const model = analysis?.metadata?.analysisModel;
  const physical = metric && typeof model?.[viewMode] === 'object' && Number.isFinite(model[viewMode].max) && model[viewMode];
  const lo = viewMode === 'elevation' ? `${formatNum(elevation?.min_m ?? ((analysis?.terrain?.minH || 0)+(analysis?.terrain?.elevationOrigin || 0)), 1)} ${unit}` : physical ? `0 ${physical.unit}` : legend.lo;
  const hi = viewMode === 'elevation' ? `${formatNum(elevation?.max_m ?? ((analysis?.terrain?.maxH || 0)+(analysis?.terrain?.elevationOrigin || 0)), 1)} ${unit}` : physical ? `${physical.max}+ ${physical.unit}` : legend.hi;
  return (
    <div className="hud-legend" title="Unlit data colors. Quantities clipped at the displayed upper threshold; source uncertainty is not encoded.">
      <span className="hud-legend-title">{legend.label}{viewMode !== 'elevation' && !physical ? ' index' : ''}</span>
      <span className="hud-legend-end">{lo}</span>
      <span className="hud-legend-bar" style={{ background: `linear-gradient(90deg in srgb-linear, ${legend.colors.join(',')})` }} />
      <span className="hud-legend-end">{hi}</span>
      <span className="layer-purpose">{{elevation:'Compare relief and absolute heights. Click terrain for a measured elevation.',slope:`Find steep approaches. Route segments above ${settings?.maxSlope??25}° are rejected.`,roughness:'Find variation across the DEM window. Sub-cell rocks remain unresolved.',hazard:`Screen mapped hazards. Route cells above ${(settings?.maxHazard??.8).toFixed(2)} are rejected; this is not a failure probability.`,traversability:'Higher means lower mapped hazard (1 − hazard). Plan Route also applies grade and obstacle exclusions.'}[viewMode]}</span>
      {point?.metrics&&<span className="layer-purpose">Selected point · {viewMode==='elevation'?`${formatNum(point.metrics.elevation,2)} ${unit}`:Number.isFinite(point.metrics[viewMode])?`${formatNum(point.metrics[viewMode]*(physical?physical.max:1),2)} ${physical?.unit||'index'}${point.metrics[viewMode]>=1&&physical?' or above':''}`:'No sample'} · Click another point to inspect in Analysis.</span>}
    </div>
  );
}

function ElevationHistogram({ stats }) {
  if (!stats?.histogram?.length) return null;
  const max = Math.max(...stats.histogram, 1);
  return (
    <div className="intel-hist" title="Elevation distribution">
      {stats.histogram.map((count, i) => (
        <div
          key={i}
          className="intel-hist-bar"
          style={{ height: `${Math.max(3, (count / max) * 100)}%` }}
        />
      ))}
    </div>
  );
}

function ClassificationBars({ classification }) {
  if (!classification?.classes) return null;
  return (
    <div className="intel-classes">
      {classification.classes
        .filter((c) => c.coverage_pct > 0)
        .map((c) => (
          <div key={c.key} className="intel-class-row" title={c.description}>
            <span className="intel-class-label">{c.label}</span>
            <div className="intel-class-track">
              <div
                className={`intel-class-fill ${c.key}`}
                style={{ width: `${c.coverage_pct}%` }}
              />
            </div>
            <span className="intel-class-pct">{c.coverage_pct.toFixed(1)}%</span>
          </div>
        ))}
    </div>
  );
}

// Real Earth DEM presets (mountainous, terrain-following relevant).
const REAL_REGIONS = [
  { name: 'Grand Canyon', sub: 'USA · 2 km relief', lat: 36.10, lon: -112.11, zoom: 11 },
  { name: 'Everest · Himalaya', sub: 'Nepal · extreme', lat: 27.99, lon: 86.92, zoom: 11 },
  { name: 'Matterhorn · Alps', sub: 'Switzerland', lat: 45.98, lon: 7.66, zoom: 11 },
  { name: 'Hindu Kush', sub: 'ridges & valleys', lat: 35.40, lon: 71.10, zoom: 11 },
];

const REPORT_KINDS = [
  ['summary', 'Terrain Summary'],
  ['surface', 'Surface Analysis'],
  ['risk', 'Risk Assessment'],
  ['geology', 'Geological Overview'],
];

export default function HUD({
  initialPanel,
  backendMode,
  analysis,
  analysisStatus,
  analysisError,
  sampleCatalog,
  selectedZoneId,
  inspectedPoint,
  viewMode,
  debugMode,
  reportBusy,
  onViewModeChange,
  onAnalyzeSample,onEngineeringRange,
  onUpload,
  onEdgeAnalyze,
  edgeInfo,
  diagnostics,
  benchmarkMode,
  onBenchmarkMode,
  onLoadRegion,
  onSelectZone,
  onFocusInterestRegion,
  onGenerateReport,
  onToggleDebug,
  onBackToGlobe,
  qualityTier, onQualityChange, verticalExaggeration, onExaggerationChange, ambience, onAmbienceChange, clientGpu,
  clockState, onClock, scenarioObjects, selectedObjectId, onSelectObject, placement, onPlacement,
  onObjectMove, onObjectRotate, onObjectConstraint, scenarioError, scenarioBusy,
  environment, onEnvironmentChange, roverRoute, roverTelemetry, roverSettings, onRoverSettings,
  roverView, onRoverView, onPlanRoute, onDemoScenario, wideArea, onWideArea, regionSizeKm, onRegionSizeChange, onAcquireSite,
}) {
  const mobile = useMobileQuality();
  const [leftOpen, setLeftOpen] = useState(false);
  const [rightOpen, setRightOpen] = useState(false);
  const [infoOpen, setInfoOpen] = useState(false);
  const [extraPanel, setExtraPanel] = useState(null);
  const [lrocCatalogue,setLrocCatalogue]=useState([]);
  const [lrocPatchKm,setLrocPatchKm]=useState(1);
  const [pairedDem,setPairedDem]=useState(null);
  const [pairedImage,setPairedImage]=useState(null);
  useEffect(()=> {let active=true;fetch('/asset-catalogue.json').then(r=> {if(!r.ok)throw new Error('Catalogue unavailable');return r.json();}).then(entries=> {if(active)setLrocCatalogue(entries);}).catch(error=>console.warn(error));return()=>{active=false;};},[]);
  const [benchmark, setBenchmark] = useState(null);
  const inspectionRequested = useRef(false);
  const inspectionNavigation = useRef(false);
  useEffect(() => { setLeftOpen(false); setRightOpen(false); setInfoOpen(false); setExtraPanel(null); }, [mobile]);
  useEffect(() => { setLeftOpen(initialPanel === 'data'); setRightOpen(initialPanel === 'analysis'); }, [initialPanel]);
  const close = () => { setLeftOpen(false); setRightOpen(false); setInfoOpen(false); setExtraPanel(null); };
  useEffect(() => {
    const closePanels = () => { setLeftOpen(false); setRightOpen(false); setInfoOpen(false); setExtraPanel(null); };
    window.addEventListener('bhuvan-close-panels', closePanels);
    const openInspection = () => { inspectionRequested.current = true; inspectionNavigation.current = true; closePanels(); setRightOpen(true); };
    window.addEventListener('bhuvan-open-inspection', openInspection);
    return () => { window.removeEventListener('bhuvan-close-panels', closePanels); window.removeEventListener('bhuvan-open-inspection', openInspection); };
  }, []);
  useEffect(() => {
    if (rightOpen && inspectionRequested.current) {
      inspectionRequested.current = false;
      const panel = document.getElementById('analysis-panel');
      if (panel) { panel.scrollTop = 0; panel.focus({ preventScroll: true }); }
    } else if (!rightOpen && inspectionNavigation.current) {
      inspectionNavigation.current = false;
      document.querySelector('.hud-drawer-controls button[aria-label="Analysis"]')?.focus({ preventScroll: true });
    }
  }, [rightOpen]);
  const toggleLeft = () => { const next = !leftOpen; close(); setLeftOpen(next); };
  const toggleRight = () => { const next = !rightOpen; close(); setRightOpen(next); };
  const toggleInfo = () => { const next = !infoOpen; close(); setInfoOpen(next); };
  const provenance = analysis?.metadata?.provenance;
  const metric = provenance?.metric === true;
  const unit = metric ? 'm' : 'rel';
  const model = analysis?.metadata?.analysisModel;
  const status = provenance?.status || 'UNKNOWN';
  const displayGsd = diagnostics?.visualGsd;
  const anyOpen = leftOpen || rightOpen || infoOpen || Boolean(extraPanel);
  const display = terrainDisplayMetadata(analysis, verticalExaggeration);

  const intel = analysis?.intelligence;
  const safeAreaPct = analysis?.metadata?.safeAreaPct ?? 0;

  return (
    <div className={`hud-overlay ${anyOpen ? 'panel-open' : ''}`}>
      {/* ── TOP BAR ── */}
      <div className="hud-top">
        <div className="hud-top-left">
          <div className="hud-branding">
            <BhuvanMark />
            <span className="hud-version">SURFACE WORKSPACE</span>
          </div>
          {backendMode === 'online' && <span className="liquid-api-status"><i /> API connected</span>}
          {backendMode !== 'online' && (
            <div className={`hud-conn-indicator ${backendMode}`}>
              <span className="conn-dot" />
              {backendMode === 'error' ? 'OFFLINE' : '…'}
            </div>
          )}
        </div>

        <div className="hud-top-center">
          <div className="hud-terrain-name">
            {analysis?.metadata?.terrainName || 'SELECT A DATASET'}
            {analysis && <span className={`fidelity-badge ${status.toLowerCase()}`}>{status}</span>}
          </div>
        </div>

        <div className="hud-top-right">
          <div className="hud-layer-selector" role="group" aria-label="Terrain layer">
            {['surface', 'elevation', 'slope', 'roughness', 'hazard', 'traversability'].map((m) => (
              <button
                key={m}
                data-liquid-control={`layer-${m}`}
                aria-label={{ surface:'Surface', elevation:'Elevation', slope:'Slope', roughness:'Roughness', hazard:'Hazard', traversability:'Traversability' }[m]}
                className={`hud-layer-btn ${viewMode === m ? 'active' : ''}`}
                aria-pressed={viewMode === m}
                disabled={!analysis || (!['surface','elevation'].includes(m) && !analysis.layers?.[m])}
                onClick={() => { onViewModeChange(m); }}
              >
                {{ surface:'SURFACE', elevation:'ELEV', slope:'SLOPE', roughness:'ROUGH', hazard:'HAZARD', traversability:'TRAV' }[m]}
              </button>
            ))}
          </div>
        </div>
      </div>

      <nav className="hud-drawer-controls liquid-dock" aria-label="Workspace navigation">
        <button data-liquid-control="datasets" onClick={toggleLeft} aria-label="Datasets" aria-expanded={leftOpen} aria-controls="dataset-panel">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h6l2 2h8v10H4Z M4 7V5h7l2 2h7v2" /></svg>
          <span>Datasets</span>
        </button>
        <button data-liquid-control="analysis" onClick={toggleRight} aria-label="Analysis" aria-expanded={rightOpen} aria-controls="analysis-panel">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 19V5 M4 19h16 M8 15l4-5 4 3 4-8" /></svg>
          <span>Analysis</span>
        </button>
        <button data-liquid-control="environment" aria-label="Environment" aria-expanded={extraPanel === 'environment'} aria-controls="environment-panel"
          onClick={() => { const next = extraPanel !== 'environment'; close(); if (next) setExtraPanel('environment'); }}>
          <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="4" /><path d="M12 2v3 M12 19v3 M2 12h3 M19 12h3 M5 5l2 2 M17 17l2 2" /></svg><span>Environment</span>
        </button>
        <button data-liquid-control="scenario" aria-label="Scenario" aria-expanded={extraPanel === 'scenario'} aria-controls="scenario-panel"
          onClick={() => { const next = extraPanel !== 'scenario'; close(); if (next) setExtraPanel('scenario'); }}>
          <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="6" cy="6" r="2" /><circle cx="18" cy="18" r="2" /><path d="M6 8v6a4 4 0 0 0 4 4h6 M12 6h8 M16 2v8" /></svg><span>Scenario</span>
        </button>
      </nav>

      <nav className="liquid-tool-rail" aria-label="Workspace utilities">
        <span className="liquid-rail-label">EXPLORE</span>
        <button data-liquid-control="orbit" onClick={onBackToGlobe} aria-label="Back to planetary orbit"><span>01</span> Planetary orbit <b>↗</b></button>
        <button data-liquid-control="layers" aria-label="Layers" onClick={() => { close(); document.querySelector('.hud-layer-btn.active')?.focus(); }}><span>02</span> Terrain layers <b>↗</b></button>
        <button data-liquid-control="source" onClick={toggleInfo} aria-expanded={infoOpen} aria-controls="dataset-info-panel"><span>03</span> Source & assumptions <b>↗</b></button>
      </nav>
      {!analysis && !anyOpen && <section className="liquid-empty-workspace" aria-label="Start terrain analysis">
        <span className="liquid-eyebrow">YOUR SURFACE WORKSPACE</span>
        <h1>Look closer.<br /><em>Start with a surface.</em></h1>
        <p>Explore a DEM, inspect its terrain, then compare the evidence behind each candidate region.</p>
        <button className="liquid-text-action" onClick={toggleLeft}>Choose a dataset <span>↗</span></button>
        {sampleCatalog[0] && <button className="liquid-text-action muted" onClick={() => onAnalyzeSample(sampleCatalog[0].id)}>Try {sampleCatalog[0].label || 'an example'} <span>→</span></button>}
        <small>01 Load data &nbsp; / &nbsp; 02 Inspect terrain &nbsp; / &nbsp; 03 Review evidence</small>
      </section>}
      {analysis && <div className="liquid-workspace-caption"><span className="liquid-eyebrow">LOCAL TERRAIN / {analysis.metadata?.provenance?.body || 'SURFACE'}</span><h1>{analysis.metadata?.terrainName || 'Terrain specimen'}</h1><p>Drag to orbit. Click to inspect. Double-click to focus.</p></div>}

      {anyOpen && (
        <button className="hud-drawer-backdrop" aria-label="Close panel"
          onClick={close} />
      )}

      {analysis && !anyOpen && <div className="dataset-fidelity" title={provenance?.reference}>
        <span className={`fidelity-badge ${status.toLowerCase()}`}>{status}</span>
        {provenance?.analysis_gsd ? `ANALYSIS ${formatNum(provenance.analysis_gsd, 2)} m/cell` : analysis.terrain?.stream ? 'NO ANALYSIS' : 'UNCALIBRATED SCALE'}
        {displayGsd && (analysis.terrain?.stream || !metric || displayGsd > provenance?.analysis_gsd) ? ` · DISPLAY ${formatNum(displayGsd, metric ? 2 : 4)} ${unit}/cell` : ''}
        {display && <span className="physical-extent"> · {metric ? `${formatNum(display.physicalExtent[0] / 1000, 2)} × ${formatNum(display.physicalExtent[1] / 1000, 2)} km · ${formatNum(display.physicalExtent[0]*display.physicalExtent[1]/1e6,2)} km²` : 'RELATIVE SCALE'} · {verticalExaggeration.toFixed(1)}× VISUAL</span>}
        {metric&&Number(roverSettings?.obstacleWidth)>0&&<span className="sampling-action">{Math.max(provenance.source_gsd||0,provenance.analysis_gsd||0)>roverSettings.obstacleWidth/3?`${roverSettings.obstacleWidth} m hazards unresolved · seek ≤ ${(roverSettings.obstacleWidth/3).toFixed(3)} m grid + validation`:'Hazard sampling criterion met · validation still required'}</span>}
      </div>}
      {analysis && !anyOpen && <LayerLegend viewMode={viewMode} analysis={analysis} settings={roverSettings} point={inspectedPoint} />}

      {/* ── LEFT RAIL: DATASETS ── */}
      <div id="dataset-panel" data-liquid-surface="panel" className={`hud-left-panel ${leftOpen ? '' : 'closed'}`}>
        {leftOpen && (
          <>
            <div className="hud-panel-header">DATASETS <button onClick={close} aria-label="Close datasets">×</button></div>
            {analysis&&<div className="loaded-terrain-summary"><b>LOADED TERRAIN</b><span>{analysis.metadata?.terrainName}</span><span>{metric?`${(analysis.terrain.scale/1000).toFixed(2)} × ${(analysis.terrain.scale/1000).toFixed(2)} km`:'Image exploration · scale unknown'}</span></div>}
            <div className="hud-section"><div className="hud-section-label">MEASURED SURFACE ACQUISITION</div>
              <button className="hud-dataset-btn" disabled={backendMode!=='online'||analysisStatus==='loading'} onClick={()=>{close();onAcquireSite({body:'moon',lat:-89.76681145214992,lon:-171.86989764584402,region_size_m:regionSizeKm*1000});}}><span className="hud-dataset-name">Shackleton rim · NASA Site 04</span><span className="hud-dataset-sub">LOLA · 5 m site / 40–80 m regional sources · {regionSizeKm} km requested · selected coverage and spacing reported after acquisition</span></button>
              <label className="workspace-field">NEXT REQUEST · {regionSizeKm} × {regionSizeKm} km<input aria-label="Dataset patch width" type="range" min=".5" max="30" step=".5" value={regionSizeKm} onChange={e=>onRegionSizeChange(Number(e.target.value))}/></label>
              <label className="workspace-field"><span><input type="checkbox" checked={wideArea} onChange={e=>onWideArea(e.target.checked)}/> Wide-area overview · bound memory</span></label>
              <p className="assumption">Next acquisition: {(regionSizeKm**2).toFixed(1)} km². {wideArea?'Coarser overview grid.':'Native spacing.'} Does not resize the loaded terrain.</p>
              <div className="hud-action-list">{[
                ['Apollo 11 region',.6741,23.4729],['Shackleton rim',-89.66,129.2],
              ].map(([name,lat,lon])=><button key={name} className="hud-dataset-btn" disabled={backendMode!=='online'||analysisStatus==='loading'} onClick={()=>{close();onAcquireSite({body:'moon',lat,lon,region_size_m:regionSizeKm*1000});}}><span className="hud-dataset-name">{name}</span><span className="hud-dataset-sub">Moon · measured DEM request · coverage dependent</span></button>)}</div>
              <a href="https://wms.lroc.asu.edu/lroc" target="_blank" rel="noreferrer">Browse LROC images and stereo DTMs ↗</a>
            </div>
            <div className="hud-section"><div className="hud-section-label">OFFLINE ENGINEERING RANGES</div><p className="assumption">Synthetic hills in metres. For demonstration; not lunar measurements.</p><div className="glass-segments">{[1000,10000].map(width=><button key={width} onClick={()=>{close();onEngineeringRange(width);}}>{width/1000} km TEST RANGE</button>)}</div></div>
            <div className="hud-section"><div className="hud-section-label">LROC · FIVE STEREO DEM + ORTHOPHOTO SITES</div>
              <p className="assumption">Measured lunar elevation + aligned imagery. Maximum: 2 km at 2 m spacing; 5 km at 5 m spacing.</p>
              <label className="workspace-field">LROC DETAIL WIDTH · {lrocPatchKm} km<input aria-label="LROC detail width" type="range" min=".5" max="5" step=".5" value={lrocPatchKm} onChange={e=>setLrocPatchKm(Number(e.target.value))}/></label>
              {lrocCatalogue.map(entry=><div className="lroc-source-card" key={entry.id}>
                <button className="hud-dataset-btn" disabled={backendMode!=='online'||analysisStatus==='loading'||lrocPatchKm>(entry.gsd===2?2:5)} onClick={()=>{close();onAcquireSite({body:'moon',lat:entry.lat,lon:entry.lon,region_size_m:lrocPatchKm*1000,lroc_dataset:entry.id});}}><span className="hud-dataset-name">{entry.title}</span><span className="hud-dataset-sub">{entry.gsd} m stereo grid · {lrocPatchKm} km requested · {lrocPatchKm>(entry.gsd===2?2:5)?'reduce detail width to 2 km':'aligned orthophoto'}</span></button>
                <a href={entry.dtm} target="_blank" rel="noreferrer">DEM ↗</a><a href={entry.ortho} target="_blank" rel="noreferrer">Orthophoto ↗</a><a href={entry.page} target="_blank" rel="noreferrer">Source / confidence ↗</a>
              </div>)}
            </div>
            {backendMode !== 'online' && (
              <div className="hud-status-message">Backend unavailable. Local examples are illustrative.</div>
            )}
            <div className="hud-section">
              <div className="hud-action-list">
                {sampleCatalog.length > 0 ? sampleCatalog.map((sample) => (
                  <button
                    key={sample.id}
                    className="hud-dataset-btn"
                    onClick={() => { if (mobile) setLeftOpen(false); onAnalyzeSample(sample.id); }}
                  >
                    <span className="hud-dataset-name">{sample.label || sample.id}</span>
                    {sample.sublabel && (
                      <span className="hud-dataset-sub">{sample.sublabel}</span>
                    )}
                  </button>
                )) : (
                  <div className="hud-empty-state">No datasets in registry.</div>
                )}
              </div>
            </div>

            <div className="hud-section">
              <div className="hud-section-label">EARTH DEM · COPERNICUS</div>
              <div className="hud-action-list">
                {REAL_REGIONS.map((r) => (
                  <button
                    key={r.name}
                    className="hud-dataset-btn"
                    onClick={() => { if (mobile) setLeftOpen(false); onLoadRegion?.(r.lat, r.lon, r.zoom); }}
                  >
                    <span className="hud-dataset-name">{r.name}</span>
                    <span className="hud-dataset-sub">{r.sub}</span>
                  </button>
                ))}
              </div>
            </div>

            <div className="hud-section">
              <div className="hud-section-label">UPLOAD</div>
              <label className="hud-upload-field">
                <input
                  type="file"
                  accept="image/*,.tif,.tiff,.geotiff"
                  aria-label="Upload terrain or DEM"
                  disabled={backendMode !== 'online'}
                  onChange={(e) => onUpload(e.target.files?.[0])}
                />
                <span className="hud-upload-label">
                  {backendMode === 'online' ? 'UPLOAD TERRAIN / DEM' : 'REQUIRES BACKEND'}
                </span>
              </label>
              <p className="assumption">A plain photo keeps its original colours, but its height remains uncalibrated. An image alone cannot supply exact elevation.</p>
              <label className="workspace-field">MEASURED DEM<input aria-label="Paired DEM GeoTIFF" type="file" accept=".tif,.tiff" onChange={e=>setPairedDem(e.target.files?.[0]||null)}/></label>
              <label className="workspace-field">CO-REGISTERED ORTHOPHOTO<input aria-label="Paired orthophoto GeoTIFF" type="file" accept=".tif,.tiff" onChange={e=>setPairedImage(e.target.files?.[0]||null)}/></label>
              <button className="hud-action-btn" disabled={!pairedDem||!pairedImage||backendMode!=='online'||analysisStatus==='loading'} onClick={()=>onUpload(pairedDem,pairedImage)}>LOAD DEM + ORIGINAL IMAGERY</button>
              <p className="assumption">Both files require compatible georeferencing and complete overlapping coverage. Up to 2 GB per raster; this importer reads a central window up to 1025 samples per side and does not invent missing elevations.</p>
            </div>

            <div className="hud-section">
              <div className="hud-section-label">IMAGE DEPTH · ON-DEVICE</div>
              <label className="hud-upload-field edge">
                <input
                  type="file"
                  accept="image/*"
                  aria-label="Infer image depth on this device"
                  onChange={(e) => onEdgeAnalyze && onEdgeAnalyze(e.target.files?.[0])}
                />
                <span className="hud-upload-label">
                  ▣ INFER DEPTH ON THIS DEVICE
                </span>
              </label>
              {edgeInfo && (
                <div className={`hud-edge-proof ${edgeInfo.status}`}>
                  {edgeInfo.status === 'running' && '◣ NEURAL DEPTH INFERENCE…'}
                  {edgeInfo.status === 'ready' && (
                    <>
                      <b>{edgeInfo.device?.toUpperCase()}</b> · {edgeInfo.ms} ms ·
                      Depth-Anything V2 · relative depth; model download required
                    </>
                  )}
                  {edgeInfo.status === 'error' && `EDGE INFERENCE FAILED: ${edgeInfo.error}`}
                </div>
              )}
            </div>

            {analysisStatus === 'loading' && (
              <div className="hud-status-message loading">
                <div className="hud-spinner" />
                ANALYZING TERRAIN…
              </div>
            )}
            {analysisError && <div className="hud-status-message error">{analysisError}</div>}
          </>
        )}
      </div>

      {/* ── RIGHT PANEL: INTELLIGENCE ── */}
      <div id="analysis-panel" data-liquid-surface="panel" tabIndex={-1} className={`hud-right-panel ${rightOpen ? '' : 'closed'}`}>
        {rightOpen && (analysis ? (
          <>
            <div className="hud-panel-header">TERRAIN ANALYSIS <button onClick={close} aria-label="Close analysis">×</button></div>
            <MissionEvidence analysis={analysis} settings={roverSettings} onSettings={onRoverSettings} point={inspectedPoint} route={roverRoute} viewMode={viewMode}/>
            {inspectedPoint?.metrics && <div className="hud-section">
              <div className="hud-section-label">POINT INSPECTION</div>
              <dl className="dataset-details">
                <dt>local X / Z</dt><dd>{formatNum(inspectedPoint.x, metric ? 1 : 3)} / {formatNum(inspectedPoint.z, metric ? 1 : 3)} {unit}</dd>
                <dt>analysis grid</dt><dd>{formatNum(display.analysisGsd, metric ? 2 : 4)} {metric ? 'm' : 'rel'}/cell</dd>
                {['elevation','slope','roughness','hazard','traversability'].map(name => {
                  const value=inspectedPoint.metrics[name];
                  const physical=metric && typeof model?.[name] === 'object' && Number.isFinite(model[name].max) && model[name];
                  return <React.Fragment key={name}><dt>{name}</dt><dd>
                    {physical && value >= 1 ? '≥ ' : ''}{formatNum(physical ? value*physical.max : value, 2)}
                    {name==='elevation' ? ` ${unit}` : physical ? ` ${physical.unit}` : ' index'}
                  </dd></React.Fragment>;
                })}
              </dl>
              <div className="hud-status-message">Slope and roughness fields saturate at model thresholds. Illumination is an orientation proxy.</div>
            </div>}

            {intel && (
              <div className="hud-section">
              <div className="hud-section-label">ELEVATION · {formatNum(intel.elevation.relief_m, metric ? 0 : 3)} {unit} RELIEF</div>
                <ElevationHistogram stats={intel.elevation} />
                <div className="intel-hist-range">
                  <span>{formatNum(intel.elevation.min_m, metric ? 0 : 3)} {unit}</span>
                  <span>median {formatNum(intel.elevation.median_m, metric ? 0 : 3)} {unit}</span>
                  <span>{formatNum(intel.elevation.max_m, metric ? 0 : 3)} {unit}</span>
                </div>
              </div>
            )}

            {intel && (
              <div className="hud-section">
                <div className="hud-section-label">SURFACE CLASSIFICATION</div>
                <ClassificationBars classification={intel.classification} />
              </div>
            )}

            <div className="hud-section">
              <div className="hud-section-label">LOW HAZARD · {formatNum(safeAreaPct)}% OF CELLS</div>
              <div className="hud-status-message">Index &lt; {model?.low_hazard_threshold ?? .35}. Candidates: index &lt; {model?.candidate_threshold ?? .42}, minimum radius {model?.candidate_min_radius ?? 'unknown'} {unit}. Thresholds are heuristic.</div>
              <div className="hud-zone-stack">
                {(analysis.landingZones || []).slice(0, 3).map((zone, index) => (
                  <button
                    key={zone.id}
                    className={`hud-zone-card ${selectedZoneId === zone.id ? 'active' : ''}`}
                    onClick={() => { onSelectZone(zone.id); if (mobile) setRightOpen(false); }}
                  >
                    <div className="zone-rank">#{index + 1}</div>
                    <div className="zone-info">
                      <span className="zone-class">{zone.classification === 'safe' ? 'LOW HAZARD' : zone.classification.toUpperCase()}</span>
                      <span className="zone-score">score {formatNum(zone.score)}</span>
                      <span className="zone-evidence">mean index {formatNum(zone.meanHazard, 3)} · radius {formatNum(zone.radius)} {unit}</span>
                      {zone.uncertainty && <span className="zone-evidence">score sensitivity {formatNum(zone.uncertainty.scoreCiLower)}–{formatNum(zone.uncertainty.scoreCiUpper)} · assumed index noise σ=.02</span>}
                    </div>
                  </button>
                ))}
              </div>
            </div>

            {intel?.interest_regions?.length > 0 && (
              <div className="hud-section">
                <div className="hud-section-label">POINTS OF INTEREST</div>
                <div className="hud-action-list">
                  {intel.interest_regions.map((poi) => (
                    <button
                      key={poi.id}
                      className="hud-action-btn poi"
                      onClick={() => { onFocusInterestRegion(poi); if (mobile) setRightOpen(false); }}
                    >
                      <span>{poi.kind}</span>
                      <span className="hud-btn-tag">{formatNum(poi.elevation_m, metric ? 0 : 3)} {unit}</span>
                    </button>
                  ))}
                </div>
              </div>
            )}

            <div className="hud-section">
              <div className="hud-section-label">REPORTS</div>
              {!metric && <p className="assumption">Existing reports require calibrated metric data. Relative-depth summaries remain available in this analysis panel.</p>}
              <div className="hud-action-list">
                {REPORT_KINDS.map(([kind, label]) => (
                  <button
                    key={kind}
                    data-report-kind={kind}
                    className="hud-action-btn secondary"
                    disabled={reportBusy || !analysis.jobId || !metric}
                    onClick={() => { onGenerateReport(kind); }}
                  >
                    {reportBusy ? 'GENERATING…' : label}
                  </button>
                ))}
              </div>
            </div>
          </>
        ) : (
          <div className="hud-empty-state">SELECT A DATASET TO BEGIN</div>
        ))}
      </div>
      {infoOpen && <div id="dataset-info-panel" data-liquid-surface="panel" className="hud-right-panel">
        <div className="hud-panel-header">DATASET / ASSUMPTIONS <button onClick={close} aria-label="Close info">×</button></div>
        <div className="hud-section">Planetary Terrain Systems Research Prototype</div>
        <dl className="dataset-details">
          <dt>Status</dt><dd>{status}</dd><dt>Source</dt><dd>{provenance?.source || 'not selected'}</dd>
          <dt>Dataset</dt><dd>{provenance?.dataset_id || 'unknown'}</dd>
          <dt>Body</dt><dd>{provenance?.body || 'unknown'}</dd>
          <dt>Reference</dt><dd>{provenance?.acquisition
            ? <details className="coordinate-reference"><summary>Local metric CRS · details</summary><pre>{provenance.reference}</pre></details>
            : provenance?.reference || 'unspecified'}</dd>
          <dt>Vertical datum</dt><dd>{provenance?.vertical_reference || 'unspecified'}</dd>
          <dt>Source GSD</dt><dd>{provenance?.source_gsd ? `${formatNum(provenance.source_gsd, 3)} m/cell` : 'unknown / uncalibrated'}</dd>
          <dt>Analysis GSD</dt><dd>{provenance?.analysis_gsd ? `${formatNum(provenance.analysis_gsd, 3)} m/cell` : 'relative'}</dd>
          <dt>Display GSD</dt><dd>{displayGsd ? `${formatNum(displayGsd, metric ? 3 : 4)} ${unit}/cell · visual LOD; analysis unchanged` : 'not rendered'}</dd>
          <dt>Physical extent</dt><dd>{display ? `${formatNum(display.physicalExtent[0], 2)} × ${formatNum(display.physicalExtent[1], 2)} ${unit}` : 'not selected'}</dd>
          <dt>Analysis grid</dt><dd>{display?.analysisGrid.join(' × ') || 'not selected'} samples</dd>
          <dt>Render grid</dt><dd>{diagnostics?.activeVertices ? `${diagnostics.activeVertices.toLocaleString()} resident vertices / ${diagnostics.activeTiles} tiles` : 'preparing'} · tessellation does not add DEM information</dd>
          <dt>Vertical exaggeration</dt><dd>{verticalExaggeration.toFixed(1)}× VISUAL ONLY</dd>
          <dt>Source shape</dt><dd>{provenance?.source_shape?.join(' × ') || 'unknown'}</dd>
          <dt>Window</dt><dd>{provenance?.window?.join(', ') || 'not supplied'}</dd>
        </dl>
        {inspectedPoint?.metrics && <div className="hud-section" aria-label="Point inspection">
          <div className="hud-section-label">LAST PIVOT / NATIVE POINT INSPECTION</div>
          <p className="assumption">X {formatNum(inspectedPoint.x)} / Z {formatNum(inspectedPoint.z)} {unit} · elevation {formatNum(inspectedPoint.metrics.elevation)} {unit} · hazard {formatNum(inspectedPoint.metrics.hazard, 2)}. Click changes the camera pivot; measurements are secondary.</p>
        </div>}
        {provenance?.acquisition && <div className="hud-section">
          <div className="hud-section-label">ACQUIRED SOURCE WINDOWS</div>
          <p className="assumption">Selected {provenance.acquisition.selected_lat.toFixed(5)}° / {provenance.acquisition.selected_lon.toFixed(5)}° · requested {(provenance.acquisition.requested_size_m / 1000).toFixed(2)} km. {provenance.acquisition.reprojection}.</p>
          {provenance.acquisition.products.map(product => <div className="source-window-details" key={product.dataset_id}>
            <b>{product.dataset_id}</b>
            <p>{product.attribution}</p>
            <p>Native GSD: {product.gsd.map(value => formatNum(value, 6)).join(' × ')} {product.gsd_unit}. Local spacing: {product.local_gsd_m.map(value => formatNum(value, 3)).join(' × ')} m.</p>
            <p>Window: {product.window.join(', ')} · {formatNum(product.read_ms, 0)} ms</p>
            {product.catalogue?.reference?.startsWith('https://') && <p><a href={product.catalogue.reference} target="_blank" rel="noreferrer">Source documentation ↗</a></p>}
            {product.catalogue?.quality_maps && <div><p className="assumption">Published quality maps · these have not been sampled or propagated into the analysis.</p>{Object.entries(product.catalogue.quality_maps).filter(([,url])=>typeof url==='string'&&url.startsWith('https://')).map(([kind,url])=><p key={kind}><a href={url} target="_blank" rel="noreferrer">{kind.replaceAll('_',' ')} map ↗</a></p>)}</div>}
            <details><summary>Source CRS / reference</summary><pre>{product.crs}</pre></details>
          </div>)}
          {provenance.acquisition.selection_failures?.length > 0 && <p className="assumption">Unavailable candidates: {provenance.acquisition.selection_failures.map(value => `${value.datasets.join(', ')}: ${value.reason}`).join(' · ')}</p>}
          {provenance.acquisition.imagery && <p className="assumption">Optional imagery: {provenance.acquisition.imagery.dataset_id || provenance.acquisition.imagery.reason}.
            {provenance.acquisition.imagery.datetime && ` Acquired ${provenance.acquisition.imagery.datetime.slice(0, 10)}.`}
            {Number.isFinite(provenance.acquisition.imagery.cloud_cover_pct) && ` Catalogue cloud cover ${formatNum(provenance.acquisition.imagery.cloud_cover_pct, 1)}%.`}
            {' '}Geometry comes from the DEM.</p>}
        </div>}
        <div className="hud-section">
          <div className="hud-section-label">LIMITATIONS</div>
          {(provenance?.limitations || ['Choose a dataset to inspect provenance.']).map((text,i)=><p className="assumption" key={i}>{text}</p>)}
          <p className="assumption">{model?.shadow || 'Illumination field is a local orientation proxy, not horizon shadowing.'}</p>
          <p className="assumption">{model?.uncertainty || 'No measured source uncertainty model is available.'}</p>
          <p className="assumption">Hazard weights: {model ? Object.entries(model.weights || {}).map(([key,value])=>`${key} ${value}`).join(' · ') : 'backend model not supplied'}. Traversability is 1 − hazard.</p>
          <p className="assumption">Geometry uses float32 local GPU positions and a float64 dataset origin. Global planetary registration/epoch is unavailable for most patches; no SPICE transform is implemented.</p>
        </div>
        {import.meta.env.DEV && <div className="hud-section">
          <div className="hud-section-label">DEVELOPMENT DIAGNOSTICS</div>
          <button className="hud-action-btn" onClick={onToggleDebug}>{debugMode ? 'HIDE' : 'SHOW'} TILE DEBUG / METRICS</button>
          {debugMode && <>
            <div className="hud-action-list">
              {['tiled','monolithic'].map(mode=><button key={mode} className="hud-action-btn" aria-pressed={benchmarkMode===mode}
                disabled={!analysis?.terrain || (mode==='monolithic' && (analysis.terrain.size>1025 || analysis.terrain.stream))}
                onClick={()=>onBenchmarkMode(mode)}>{mode.toUpperCase()} DRAW</button>)}
            </div>
            <p className="assumption">Compare measured frame time, heap, triangles and geometry count at the same camera and LOD. Monolithic mode uses memory-backed datasets only, limited to 1025² samples. Remote sources remain streamed.</p>
            <pre className="benchmark-output">{JSON.stringify({ ...diagnostics, ...networkMetrics }, null, 2)}</pre>
            <button className="hud-action-btn" disabled={!analysis?.terrain} onClick={async()=>setBenchmark(await runDataBenchmark(analysis.terrain))}>RUN DATA / PRECISION BENCHMARK</button>
            {benchmark && <pre className="benchmark-output">{JSON.stringify(benchmark,null,2)}</pre>}
          </>}
        </div>}
      </div>}
      {extraPanel === 'environment' && <EnvironmentPanel analysis={analysis} mobile={mobile} qualityTier={qualityTier}
        onQualityChange={onQualityChange} verticalExaggeration={verticalExaggeration} onExaggerationChange={onExaggerationChange}
        ambience={ambience} onAmbienceChange={onAmbienceChange} close={close} environment={environment} onEnvironmentChange={onEnvironmentChange} clientGpu={clientGpu}/>}
      {extraPanel === 'scenario' && <ScenarioPanel analysis={analysis} objects={scenarioObjects} selectedId={selectedObjectId}
        onSelect={onSelectObject} onPlacement={onPlacement} onMove={onObjectMove} onRotate={onObjectRotate} onConstraint={onObjectConstraint}
        clockState={clockState} onClock={onClock} error={scenarioError} busy={scenarioBusy} close={close}
        roverRoute={roverRoute} roverTelemetry={roverTelemetry} roverSettings={roverSettings} onRoverSettings={onRoverSettings}
        roverView={roverView} onRoverView={onRoverView} onPlanRoute={onPlanRoute} onDemoScenario={onDemoScenario} onOpenDatasets={()=>{close();setLeftOpen(true);}}/>}
    </div>
  );
}
