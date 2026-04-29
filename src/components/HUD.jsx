import React from 'react';
import { CONSTANTS } from '../engine/physics';

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
}) {
  const s = landerState || {};
  const altitude = s.y != null ? Math.max(0, s.y - 1.5) : 0;
  const descentRate = s.vy != null ? -s.vy : 0;
  const lateralSpeed = s.vx != null ? Math.sqrt(s.vx ** 2 + s.vz ** 2) : 0;
  const isLow = altitude < 30;
  const isCritical = altitude < 10;
  const inspectedMetrics = inspectedPoint?.metrics;
  const selectedZone = analysis?.landingZones?.find((zone) => zone.id === selectedZoneId);
  const statusLabel = phase === 'inspect3d' ? 'INSPECT' : phase.toUpperCase();
  const safeAreaPct = analysis?.metadata?.safeAreaPct ?? 0;

  return (
    <div className="hud-overlay">
      <div className="hud-top">
        <div className="hud-top-left">
          <span className="hud-logo">◆ BHUVAN</span>
          <span className="hud-phase">{statusLabel}</span>
        </div>
        <div className="hud-top-center">
          <span className="hud-mission-time">
            {analysis?.metadata?.terrainName || 'Awaiting Terrain Analysis'}
          </span>
        </div>
        <div className="hud-top-right">
          <div className="hud-view-modes">
            {['elevation', 'slope', 'roughness', 'hazard', 'traversability', 'shadow'].map((m) => (
              <button
                key={m}
                id={`view-mode-${m}`}
                className={`hud-view-btn ${viewMode === m ? 'active' : ''}`}
                onClick={() => onViewModeChange(m)}
              >
                {m.toUpperCase()}
              </button>
            ))}
          </div>
        </div>
      </div>

      {(phase === 'analyze' || phase === 'inspect3d') && (
        <>
          <div className="hud-left-panel">
            <div className="hud-panel-title">ANALYSIS WORKBENCH</div>
            <div className="hud-workbench-block">
              <div className="hud-status-chip">
                BACKEND: {backendMode === 'online' ? 'FASTAPI ONLINE' : backendMode === 'fallback' ? 'FRONTEND FALLBACK' : 'CONNECTING'}
              </div>
              <p className="hud-panel-copy">
                Run terrain analysis first, then inspect the evidence before committing to a landing zone.
              </p>
            </div>

            <div className="hud-workbench-block">
              <div className="hud-mini-title">SAMPLE TERRAINS</div>
              <div className="hud-zone-list">
                {sampleCatalog.map((sample) => (
                  <button
                    key={sample.id}
                    className="hud-zone-btn"
                    onClick={() => onAnalyzeSample(sample.id)}
                  >
                    <span>{sample.label || sample.id}</span>
                    <span>{sample.source === 'frontend-fallback' ? 'DEMO' : 'BUNDLE'}</span>
                  </button>
                ))}
              </div>
            </div>

            <div className="hud-workbench-block">
              <div className="hud-mini-title">UPLOAD HEIGHTMAP / DEM IMAGE</div>
              <label className="hud-upload-btn">
                <span>{backendMode === 'online' ? 'SELECT FILE' : 'UPLOAD REQUIRES BACKEND'}</span>
                <input
                  type="file"
                  accept="image/*"
                  disabled={backendMode !== 'online'}
                  onChange={(e) => onUpload(e.target.files?.[0])}
                />
              </label>
            </div>

            {phase === 'inspect3d' && (
              <div className="hud-workbench-block">
                <div className="hud-mini-title">POINT INSPECTION</div>
                {inspectedMetrics ? (
                  <>
                    <MetricRow label="Elevation" value={formatNum(inspectedMetrics.elevation)} unit=" m" />
                    <MetricRow label="Slope risk" value={formatNum((inspectedMetrics.slope || 0) * 100)} unit="%" />
                    <MetricRow label="Roughness" value={formatNum((inspectedMetrics.roughness || 0) * 100)} unit="%" />
                    <MetricRow label="Shadow proxy" value={formatNum((inspectedMetrics.shadow || 0) * 100)} unit="%" />
                    <MetricRow label="Hazard score" value={formatNum((inspectedMetrics.hazard || 0) * 100)} unit="%" accent="accent-warn" />
                    <MetricRow label="Traversability" value={formatNum((inspectedMetrics.traversability || 0) * 100)} unit="%" accent="accent-good" />
                  </>
                ) : (
                  <p className="hud-panel-copy">Inspect a point on the terrain to see the local evidence.</p>
                )}
              </div>
            )}

            {analysisStatus === 'loading' && <div className="hud-loading">Running slope, roughness, shadow, and landing-zone analysis...</div>}
            {analysisError && <div className="hud-error">{analysisError}</div>}
            {analysis?.metadata?.disclaimer && <div className="hud-disclaimer">{analysis.metadata.disclaimer}</div>}
          </div>

          <div className="hud-right-panel hud-analysis-panel">
            <div className="hud-panel-title">LANDING ZONES</div>
            {analysis ? (
              <>
                <MetricRow label="Safe area" value={formatNum(safeAreaPct)} unit="%" accent="accent-good" />
                <MetricRow label="Grid size" value={analysis.metadata?.gridSize || '--'} />
                <MetricRow label="Source" value={analysis.metadata?.source || '--'} />

                <div className="hud-mini-title hud-spaced">TOP CANDIDATES</div>
                <div className="hud-zone-list">
                  {(analysis.landingZones || []).map((zone, index) => (
                    <button
                      key={zone.id}
                      className={`hud-zone-btn ${selectedZoneId === zone.id ? 'active' : ''}`}
                      onClick={() => onSelectZone(zone.id)}
                    >
                      <span>#{index + 1} {zone.classification.toUpperCase()}</span>
                      <span>{formatNum(zone.score)}%</span>
                    </button>
                  ))}
                </div>

                {phase === 'inspect3d' && selectedZone && (
                  <div className="hud-workbench-block">
                    <div className="hud-mini-title hud-spaced">SELECTED CANDIDATE</div>
                    <MetricRow label="Zone score" value={formatNum(selectedZone.score)} unit="%" accent="accent-good" />
                    <MetricRow label="Classification" value={selectedZone.classification.toUpperCase()} />
                    <MetricRow label="Slope contribution" value={selectedZone.components?.slope ?? '--'} unit="%" />
                    <MetricRow label="Roughness contribution" value={selectedZone.components?.roughness ?? '--'} unit="%" />
                    <MetricRow label="Curvature contribution" value={selectedZone.components?.curvature ?? '--'} unit="%" />
                    <MetricRow label="Shadow contribution" value={selectedZone.components?.shadow ?? '--'} unit="%" />
                  </div>
                )}
              </>
            ) : (
              <p className="hud-panel-copy">No terrain analyzed yet.</p>
            )}
          </div>
        </>
      )}

      {phase === 'inspect3d' && (
        <div className="hud-orbital-prompt">
          <p>CLICK TERRAIN TO INSPECT CELL METRICS</p>
          <p className="hud-sub">Orbit, pan, zoom, compare layers, then commit to a candidate zone.</p>
        </div>
      )}

      {(phase === 'descent' || phase === 'report') && (
        <>
          <div className="hud-left-panel">
            <div className="hud-panel-title">DESCENT TELEMETRY</div>
            <Gauge label="ALTITUDE" value={altitude} unit="m" warn={30} danger={10} inverse />
            <Gauge label="V/S" value={descentRate} unit="m/s" warn={5} danger={8} />
            <Gauge label="H/S" value={lateralSpeed} unit="m/s" warn={3} danger={5} />
            <Bar label="FUEL" value={s.fuel || 0} max={CONSTANTS.INITIAL_FUEL} color="#00ff88" unit="kg" />
            <Bar label="THROTTLE" value={(s.throttle || 0) * 100} max={100} color="#ff8800" unit="%" />
            <MetricRow label="Touchdown hazard" value={formatNum((s.touchdownRisk || 0) * 100)} unit="%" />
          </div>

          <div className="hud-right-panel">
            <div className="hud-panel-title">FLIGHT CONTROLS</div>
            <button
              className={`hud-control-btn ${autopilot ? 'active' : ''}`}
              onClick={onToggleAutopilot}
              id="toggle-autopilot"
            >
              {autopilot ? 'AUTO GUIDANCE' : 'MANUAL GUIDANCE'}
            </button>
            {!autopilot && (
              <div className="hud-controls-help">
                <p><kbd>W</kbd> Thrust Up</p>
                <p><kbd>S</kbd> Thrust Down</p>
                <p><kbd>A</kbd><kbd>D</kbd> Lateral</p>
                <p><kbd>Q</kbd><kbd>E</kbd> Strafe</p>
              </div>
            )}
          </div>

          {phase === 'descent' && isCritical && (
            <div className="hud-warning critical">⚠ ALTITUDE CRITICAL</div>
          )}
          {phase === 'descent' && isLow && !isCritical && (
            <div className="hud-warning low">⚠ LOW ALTITUDE</div>
          )}
          {phase === 'descent' && (s.fuel || 0) < 15 && (
            <div className="hud-warning fuel">⚠ FUEL LOW</div>
          )}
        </>
      )}

      {phase === 'inspect3d' && selectedZone && (
        <div className="hud-bottom-center">
          <button className="hud-descent-btn" onClick={onInitDescent} id="initiate-descent-btn">
            INITIATE VALIDATION DESCENT
          </button>
        </div>
      )}

      {phase === 'report' && missionReport && (
        <div className={`hud-result ${missionReport.outcome === 'landed' ? 'landed' : 'crashed'}`}>
          <h2>{missionReport.outcome === 'landed' ? 'LANDING REPORT' : 'MISSION REPORT'}</h2>
          <div className="hud-result-stats">
            <div><span>Terrain:</span> <span>{missionReport.terrainName}</span></div>
            <div><span>Predicted zone score:</span> <span>{missionReport.prediction ? `${formatNum(missionReport.prediction.score)}%` : '--'}</span></div>
            <div><span>Predicted classification:</span> <span>{missionReport.prediction?.classification?.toUpperCase() || '--'}</span></div>
            <div><span>Actual hazard at touchdown:</span> <span>{formatNum(missionReport.actual.hazard)}%</span></div>
            <div><span>Actual traversability:</span> <span>{formatNum(missionReport.actual.traversability)}%</span></div>
            <div><span>Touchdown assessment:</span> <span>{missionReport.actual.assessment.toUpperCase()}</span></div>
            <div><span>Impact Speed:</span> <span>{formatNum(s.impactSpeed)} m/s</span></div>
            <div><span>Fuel Remaining:</span> <span>{formatNum(s.fuel)} kg</span></div>
            <div><span>Mission Time:</span> <span>{formatNum(s.missionTime)} s</span></div>
          </div>
          <button className="hud-control-btn hud-report-btn" onClick={onReturnToInspection}>
            RETURN TO INSPECTION
          </button>
        </div>
      )}

      {phase === 'descent' && (
        <div className="hud-crosshair">
          <div className="crosshair-h" />
          <div className="crosshair-v" />
          <div className="crosshair-circle" />
        </div>
      )}
    </div>
  );
}
