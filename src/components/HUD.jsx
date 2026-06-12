import React, { useState } from 'react';
import { isMuted, toggleMute, uiConfirm, uiTick } from '../engine/audio';

function formatNum(n, decimals = 1) {
  return typeof n === 'number' ? n.toFixed(decimals) : '--';
}

function MetricRow({ label, value, unit = '', accent = '' }) {
  return (
    <div className="hud-metric-row">
      <span>{label}</span>
      <span className={accent}>{value}{unit}</span>
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

const REPORT_KINDS = [
  ['summary', 'Terrain Summary'],
  ['surface', 'Surface Analysis'],
  ['risk', 'Risk Assessment'],
  ['geology', 'Geological Overview'],
];

export default function HUD({
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
  onAnalyzeSample,
  onUpload,
  onSelectZone,
  onFocusInterestRegion,
  onGenerateReport,
  onToggleDebug,
  onBackToGlobe,
}) {
  const [audioMuted, setAudioMuted] = useState(isMuted());
  const [leftOpen, setLeftOpen] = useState(true);
  const [rightOpen, setRightOpen] = useState(true);

  const inspectedMetrics = inspectedPoint?.metrics;
  const intel = analysis?.intelligence;
  const safeAreaPct = analysis?.metadata?.safeAreaPct ?? 0;

  return (
    <div className="hud-overlay">
      {/* ── TOP BAR ── */}
      <div className="hud-top">
        <div className="hud-top-left">
          <button className="hud-back-btn" onClick={onBackToGlobe} title="Back to Moon globe">
            ◂ GLOBE
          </button>
          <div className="hud-branding">
            <span className="hud-logo">ARES</span>
            <span className="hud-version">PLANETARY INTELLIGENCE</span>
          </div>
          <div className={`hud-conn-indicator ${backendMode}`}>
            <span className="conn-dot" />
            {backendMode === 'online' ? 'LIVE' : backendMode === 'error' ? 'OFFLINE' : '…'}
          </div>
        </div>

        <div className="hud-top-center">
          <div className="hud-terrain-name">
            {analysis?.metadata?.terrainName || 'SELECT A DATASET'}
          </div>
        </div>

        <div className="hud-top-right">
          <div className="hud-layer-selector">
            {['elevation', 'slope', 'roughness', 'hazard', 'traversability'].map((m) => (
              <button
                key={m}
                className={`hud-layer-btn ${viewMode === m ? 'active' : ''}`}
                onClick={() => { uiTick(); onViewModeChange(m); }}
              >
                {m.substring(0, 4).toUpperCase()}
              </button>
            ))}
            <button
              className={`hud-debug-toggle ${debugMode ? 'active' : ''}`}
              onClick={() => { uiTick(); onToggleDebug(); }}
            >
              DBG
            </button>
            <button
              className={`hud-debug-toggle ${audioMuted ? '' : 'active'}`}
              title={audioMuted ? 'Unmute audio' : 'Mute audio'}
              onClick={() => setAudioMuted(toggleMute())}
            >
              {audioMuted ? 'MUTE' : 'AUD'}
            </button>
          </div>
        </div>
      </div>

      {/* ── LEFT RAIL: DATASETS ── */}
      <div className={`hud-left-panel ${leftOpen ? '' : 'closed'}`}>
        <button className="hud-panel-toggle left" onClick={() => setLeftOpen(!leftOpen)}>
          {leftOpen ? '◂' : '▸'}
        </button>
        {leftOpen && (
          <>
            <div className="hud-panel-header">DATASETS</div>
            <div className="hud-section">
              <div className="hud-action-list">
                {sampleCatalog.length > 0 ? sampleCatalog.map((sample) => (
                  <button
                    key={sample.id}
                    className="hud-action-btn"
                    onClick={() => onAnalyzeSample(sample.id)}
                  >
                    <span>{sample.label || sample.id}</span>
                    <span className="hud-btn-tag">
                      {sample.source?.includes('procedural') ? 'SYNTH' : 'REAL'}
                    </span>
                  </button>
                )) : (
                  <div className="hud-empty-state">No datasets in registry.</div>
                )}
              </div>
            </div>

            <div className="hud-section">
              <div className="hud-section-label">UPLOAD</div>
              <label className="hud-upload-field">
                <input
                  type="file"
                  accept="image/*"
                  disabled={backendMode !== 'online'}
                  onChange={(e) => onUpload(e.target.files?.[0])}
                />
                <span className="hud-upload-label">
                  {backendMode === 'online' ? 'UPLOAD TERRAIN DATA' : 'REQUIRES BACKEND'}
                </span>
              </label>
            </div>

            {inspectedMetrics && (
              <div className="hud-section">
                <div className="hud-section-label">SURFACE PROBE</div>
                <div className="hud-metrics-box">
                  <MetricRow label="Elevation" value={formatNum(inspectedMetrics.elevation)} unit=" m" />
                  <MetricRow label="Slope" value={formatNum((inspectedMetrics.slope || 0) * 100)} unit="%" />
                  <MetricRow label="Roughness" value={formatNum((inspectedMetrics.roughness || 0) * 100)} unit="%" />
                  <MetricRow label="Hazard" value={formatNum((inspectedMetrics.hazard || 0) * 100)} unit="%" accent="accent-warn" />
                </div>
              </div>
            )}

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
      <div className={`hud-right-panel ${rightOpen ? '' : 'closed'}`}>
        <button className="hud-panel-toggle right" onClick={() => setRightOpen(!rightOpen)}>
          {rightOpen ? '▸' : '◂'}
        </button>
        {rightOpen && (analysis ? (
          <>
            <div className="hud-panel-header">INTELLIGENCE</div>

            {intel && (
              <div className="hud-section">
                <div className="hud-section-label">ELEVATION · {formatNum(intel.elevation.relief_m, 0)} m RELIEF</div>
                <ElevationHistogram stats={intel.elevation} />
                <div className="intel-hist-range">
                  <span>{formatNum(intel.elevation.min_m, 0)} m</span>
                  <span>median {formatNum(intel.elevation.median_m, 0)} m</span>
                  <span>{formatNum(intel.elevation.max_m, 0)} m</span>
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
              <div className="hud-section-label">LANDING ZONES · {formatNum(safeAreaPct)}% SAFE</div>
              <div className="hud-zone-stack">
                {(analysis.landingZones || []).slice(0, 3).map((zone, index) => (
                  <button
                    key={zone.id}
                    className={`hud-zone-card ${selectedZoneId === zone.id ? 'active' : ''}`}
                    onClick={() => { uiConfirm(); onSelectZone(zone.id); }}
                  >
                    <div className="zone-rank">#{index + 1}</div>
                    <div className="zone-info">
                      <span className="zone-class">{zone.classification.toUpperCase()}</span>
                      <span className="zone-score">{formatNum(zone.score)}%</span>
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
                      onClick={() => { uiTick(); onFocusInterestRegion(poi); }}
                    >
                      <span>{poi.kind}</span>
                      <span className="hud-btn-tag">{formatNum(poi.elevation_m, 0)}m</span>
                    </button>
                  ))}
                </div>
              </div>
            )}

            <div className="hud-section">
              <div className="hud-section-label">REPORTS</div>
              <div className="hud-action-list">
                {REPORT_KINDS.map(([kind, label]) => (
                  <button
                    key={kind}
                    className="hud-action-btn secondary"
                    disabled={reportBusy || !analysis.jobId}
                    onClick={() => { uiConfirm(); onGenerateReport(kind); }}
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
    </div>
  );
}
