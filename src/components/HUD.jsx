import React, { useState } from 'react';
import { CONSTANTS } from '../engine/physics';
import { isMuted, speakMissionBrief, toggleMute, uiConfirm, uiTick } from '../engine/audio';

function formatNum(n, decimals = 1) {
  return typeof n === 'number' ? n.toFixed(decimals) : '--';
}

function Bar({ value, max, color, label, unit }) {
  const pct = Math.min(100, Math.max(0, (value / max) * 100));
  return (
    <div className="hud-bar">
      <div className="hud-bar-label">
        <span>{label}</span>
        <span>{formatNum(value, 1)} {unit}</span>
      </div>
      <div className="hud-bar-track">
        <div
          className="hud-bar-fill"
          style={{ width: `${pct}%`, background: color }}
        />
      </div>
    </div>
  );
}

function Gauge({ label, value, unit, warn, danger, inverse = false }) {
  let cls = 'hud-gauge';
  const dangerTriggered = inverse ? value <= danger : value >= danger;
  const warnTriggered = inverse ? value <= warn : value >= warn;
  if (danger != null && typeof value === 'number' && dangerTriggered) cls += ' danger';
  else if (warn != null && typeof value === 'number' && warnTriggered) cls += ' warn';
  return (
    <div className={cls}>
      <span className="hud-gauge-value">{formatNum(value, 1)}</span>
      <span className="hud-gauge-unit">{unit}</span>
      <span className="hud-gauge-label">{label}</span>
    </div>
  );
}

function MetricRow({ label, value, unit = '', accent = '' }) {
  return (
    <div className="hud-metric-row">
      <span>{label}</span>
      <span className={accent}>{value}{unit}</span>
    </div>
  );
}

export default function HUD({
  phase,
  backendMode,
  analysis,
  analysisStatus,
  analysisError,
  sampleCatalog,
  selectedZoneId,
  inspectedPoint,
  missionReport,
  landerState,
  viewMode,
  onViewModeChange,
  onAnalyzeSample,
  onUpload,
  onSelectZone,
  onInitDescent,
  onReturnToInspection,
  onToggleAutopilot,
  autopilot,
  debugMode,
  onToggleDebug,
  onExportReport,
}) {
  const [audioMuted, setAudioMuted] = useState(isMuted());
  const s = landerState || {};
  const altitude = s.y != null ? Math.max(0, s.y - 1.5) : 0;
  const descentRate = s.vy != null ? -s.vy : 0;
  const lateralSpeed = s.vx != null ? Math.sqrt(s.vx ** 2 + s.vz ** 2) : 0;
  const isLow = altitude < 30;
  const isCritical = altitude < 10;
  const inspectedMetrics = inspectedPoint?.metrics;
  const selectedZone = analysis?.landingZones?.find((zone) => zone.id === selectedZoneId);
  const statusLabel = phase === 'inspect3d' ? '3D INSPECTION' : phase.toUpperCase().replace(/_/g, ' ');
  const safeAreaPct = analysis?.metadata?.safeAreaPct ?? 0;

  return (
    <div className="hud-overlay">
      {/* ── TOP NAV BAR ── */}
      <div className="hud-top">
        <div className="hud-top-left">
          <div className="hud-branding">
            <span className="hud-logo">BHUVAN</span>
            <span className="hud-version">v3.0</span>
          </div>
          <div className="hud-status-group">
            <span className="hud-phase-badge">{statusLabel}</span>
            <div className={`hud-conn-indicator ${backendMode}`}>
              <span className="conn-dot" />
              {backendMode === 'online' ? 'BACKEND ONLINE' : backendMode === 'error' ? 'LOCAL MODE' : 'CONNECTING...'}
            </div>
          </div>
        </div>
        
        <div className="hud-top-center">
          <div className="hud-terrain-name">
            {analysis?.metadata?.terrainName || 'AWAITING MISSION TARGET'}
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
              title={audioMuted ? 'Unmute audio cues' : 'Mute audio cues'}
              onClick={() => setAudioMuted(toggleMute())}
            >
              {audioMuted ? 'MUTE' : 'AUD'}
            </button>
          </div>
        </div>
      </div>

      {/* ── WORKBENCH PHASE (ANALYSIS & INSPECTION) ── */}
      {(phase === 'analyze' || phase === 'inspect3d') && (
        <>
          <div className="hud-left-panel">
            <div className="hud-panel-header">MISSION PLANNING</div>
            
            <div className="hud-section">
              <div className="hud-section-label">SAMPLE REGISTRY</div>
              <div className="hud-action-list">
                {sampleCatalog.length > 0 ? sampleCatalog.map((sample) => (
                  <button
                    key={sample.id}
                    className="hud-action-btn"
                    onClick={() => onAnalyzeSample(sample.id)}
                  >
                    <span>{sample.label || sample.id}</span>
                    <span className="hud-btn-tag">{sample.source === 'bundled-procedural' ? 'REMOTE' : 'LOCAL'}</span>
                  </button>
                )) : (
                  <div className="hud-empty-state">No samples available in registry.</div>
                )}
              </div>
            </div>

            <div className="hud-section">
              <div className="hud-section-label">DATA INGESTION</div>
              <label className="hud-upload-field">
                <input
                  type="file"
                  accept="image/*"
                  disabled={backendMode !== 'online'}
                  onChange={(e) => onUpload(e.target.files?.[0])}
                />
                <span className="hud-upload-label">
                  {backendMode === 'online' ? 'UPLOAD TERRAIN DATA' : 'UPLOAD REQUIRES BACKEND'}
                </span>
              </label>
            </div>

            {phase === 'inspect3d' && (
              <div className="hud-section">
                <div className="hud-section-label">CELL TELEMETRY</div>
                {inspectedMetrics ? (
                  <div className="hud-metrics-box">
                    <MetricRow label="Elevation" value={formatNum(inspectedMetrics.elevation)} unit=" m" />
                    <MetricRow label="Slope Risk" value={formatNum((inspectedMetrics.slope || 0) * 100)} unit="%" />
                    <MetricRow label="Roughness" value={formatNum((inspectedMetrics.roughness || 0) * 100)} unit="%" />
                    <MetricRow label="Hazard Level" value={formatNum((inspectedMetrics.hazard || 0) * 100)} unit="%" accent="accent-warn" />
                    <MetricRow label="Traversability" value={formatNum((inspectedMetrics.traversability || 0) * 100)} unit="%" accent="accent-good" />
                  </div>
                ) : (
                  <p className="hud-hint">SELECT POINT ON TERRAIN TO INSPECT</p>
                )}
              </div>
            )}

            {analysisStatus === 'loading' && (
              <div className="hud-status-message loading">
                <div className="hud-spinner" />
                RUNNING MULTI-FACTOR ANALYSIS...
              </div>
            )}
            {analysisError && <div className="hud-status-message error">{analysisError}</div>}
          </div>

          <div className="hud-right-panel">
            <div className="hud-panel-header">ANALYSIS RESULTS</div>
            {analysis ? (
              <>
                <div className="hud-metrics-box summary">
                  <MetricRow label="Safe Landing Area" value={formatNum(safeAreaPct)} unit="%" accent="accent-good" />
                  <MetricRow label="Surface Resolution" value={formatNum(analysis.metadata?.resolutionMPerPx, 2)} unit=" m/px" />
                </div>

                <div className="hud-section">
                  <div className="hud-section-label">IDENTIFIED LANDING ZONES</div>
                  <div className="hud-zone-stack">
                    {(analysis.landingZones || []).slice(0, 5).map((zone, index) => (
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

                {selectedZone && (
                  <div className="hud-section">
                    <div className="hud-section-label">CANDIDATE EVIDENCE</div>
                    <div className="hud-metrics-box mini">
                      <MetricRow label="Slope Contribution" value={zoneScoreToPct(selectedZone.components?.slope)} unit="%" />
                      <MetricRow label="Roughness Level" value={zoneScoreToPct(selectedZone.components?.roughness)} unit="%" />
                      <MetricRow label="Landing Confidence" value={formatNum(selectedZone.confidence * 100)} unit="%" accent="accent-good" />
                    </div>
                  </div>
                )}
                
                <button
                  className="hud-action-btn secondary"
                  onClick={() => speakMissionBrief(analysis)}
                >
                  VOICE MISSION BRIEF
                </button>
                <button className="hud-action-btn secondary" onClick={onExportReport}>
                  EXPORT ANALYSIS REPORT
                </button>
              </>
            ) : (
              <div className="hud-empty-state">LOAD TERRAIN TO BEGIN ANALYSIS</div>
            )}
          </div>
        </>
      )}

      {/* ── DESCENT PHASE ── */}
      {(phase === 'descent' || phase === 'report') && (
        <>
          <div className="hud-left-panel">
            <div className="hud-panel-header">FLIGHT TELEMETRY</div>
            <div className="hud-telemetry-grid">
              <Gauge label="ALTITUDE" value={altitude} unit="m" warn={30} danger={10} inverse />
              <Gauge label="VERTICAL SPEED" value={descentRate} unit="m/s" warn={5} danger={8} />
              <Gauge label="LATERAL SPEED" value={lateralSpeed} unit="m/s" warn={4} danger={6} />
            </div>
            
            <div className="hud-bars-group">
              <Bar label="FUEL" value={s.fuel || 0} max={CONSTANTS.INITIAL_FUEL} color="var(--accent-green)" unit="kg" />
              <Bar label="THRUST" value={(s.throttle || 0) * 100} max={100} color="var(--accent-orange)" unit="%" />
            </div>

            <div className="hud-metrics-box flight">
              <MetricRow label="Guidance Mode" value={(s.guidanceMode || 'MANUAL').toUpperCase().replace(/-/g, ' ')} />
              <MetricRow label="Attitude Tilt" value={formatNum(getTilt(s.quat))} unit="°" accent={getTilt(s.quat) > 20 ? 'accent-warn' : ''} />
              <MetricRow label="Local Hazard" value={formatNum((s.touchdownRisk || 0) * 100)} unit="%" accent={s.touchdownRisk > 0.6 ? 'accent-warn' : ''} />
            </div>
          </div>

          <div className="hud-right-panel">
            <div className="hud-panel-header">FLIGHT SYSTEMS</div>
            <button
              className={`hud-sys-btn ${autopilot ? 'active' : ''}`}
              onClick={onToggleAutopilot}
            >
              {autopilot ? 'AUTO-GUIDANCE ACTIVE' : 'MANUAL CONTROL'}
            </button>
            
            {!autopilot && (
              <div className="hud-controls-hint">
                <div className="hud-section-label">MANUAL OVERRIDE</div>
                <p><kbd>W</kbd><kbd>S</kbd> Main Engine</p>
                <p><kbd>A</kbd><kbd>D</kbd> Lateral Trans</p>
                <p><kbd>Q</kbd><kbd>E</kbd> Strafe Trans</p>
                <p><kbd>←</kbd><kbd>→</kbd> Yaw Control</p>
              </div>
            )}
          </div>

          {phase === 'descent' && (
            <div className="hud-warnings-stack">
              {isCritical && <div className="hud-alert danger">GROUND PROXIMITY CRITICAL</div>}
              {isLow && !isCritical && <div className="hud-alert warn">LOW ALTITUDE WARNING</div>}
              {(s.fuel || 0) < 20 && <div className="hud-alert warn">FUEL RESERVES LOW</div>}
            </div>
          )}
        </>
      )}

      {/* ── PHASE SPECIFIC OVERLAYS ── */}
      {phase === 'inspect3d' && selectedZone && (
        <div className="hud-bottom-actions">
          <div className="hud-disclaimer">DECISION SUPPORT: Verify touchdown suitability before descent.</div>
          <button className="hud-launch-descent" onClick={onInitDescent}>
            INITIATE VALIDATION DESCENT
          </button>
        </div>
      )}

      {phase === 'report' && missionReport && (
        <div className={`hud-mission-report ${missionReport.outcome}`}>
          <div className="report-header">
            {missionReport.outcome === 'landed' ? 'SUCCESSFUL TOUCHDOWN' : 'MISSION FAILURE'}
          </div>
          <div className="report-body">
            <div className="report-row"><span>Terrain</span> <span>{missionReport.terrainName}</span></div>
            <div className="report-row"><span>Zone Prediction</span> <span>{missionReport.prediction ? `${formatNum(missionReport.prediction.score)}%` : '--'}</span></div>
            <div className="report-row"><span>Actual Surface Hazard</span> <span className={missionReport.actual.hazard > 50 ? 'accent-warn' : ''}>{formatNum(missionReport.actual.hazard)}%</span></div>
            <div className="report-row"><span>Impact Velocity</span> <span className={s.impactSpeed > 3.5 ? 'accent-warn' : ''}>{formatNum(s.impactSpeed)} m/s</span></div>
            <div className="report-row"><span>Remaining Fuel</span> <span>{formatNum(s.fuel)} kg</span></div>
            <div className="report-row"><span>Final Assessment</span> <span className="accent-good">{missionReport.actual.assessment.toUpperCase()}</span></div>
          </div>
          <div className="report-footer">
            <button className="hud-action-btn" onClick={onReturnToInspection}>RETURN TO ORBIT</button>
            <button className="hud-action-btn secondary" onClick={onExportReport}>DOWNLOAD LOGS</button>
          </div>
        </div>
      )}

      {phase === 'descent' && <div className="hud-targeting-reticle" />}
    </div>
  );
}

function getTilt(quat) {
  if (!quat) return 0;
  return Math.acos(Math.min(1, Math.abs(quat[0]))) * 2 * 180 / Math.PI;
}

function zoneScoreToPct(val) {
  if (val == null) return '--';
  return formatNum(val);
}
