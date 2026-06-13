import React from 'react';

/* ── Technical Debug Overlay ──
 * Shows analysis internals: weights, thresholds, hazard decomposition,
 * ray-cast parameters, and methodology details.
 * Toggled via HUD button.
 */

const HAZARD_WEIGHTS = { slope: 0.45, roughness: 0.25, curvature: 0.2, shadow: 0.1 };
const SAFE_THRESHOLD = 0.42;
const SLOPE_SAFE_DEG = 15;
const MIN_SAFE_RADIUS_M = 4.0;

export default function DebugOverlay({ analysis, inspectedPoint, selectedZone, visible }) {
  if (!visible) return null;

  const meta = analysis?.metadata || {};
  const layers = analysis?.layers;
  const terrain = analysis?.terrain;

  return (
    <div className="debug-overlay">
      <div className="debug-title">TECHNICAL DEBUG</div>

      <div className="debug-section">
        <div className="debug-section-title">METHODOLOGY</div>
        <div className="debug-row">
          <span>Shadow method</span>
          <span className="debug-val">RAY-CAST</span>
        </div>
        <div className="debug-row">
          <span>Sun azimuth</span>
          <span className="debug-val">40°</span>
        </div>
        <div className="debug-row">
          <span>Sun elevation</span>
          <span className="debug-val">45°</span>
        </div>
        <div className="debug-row">
          <span>Ray max distance</span>
          <span className="debug-val">500m</span>
        </div>
        <div className="debug-row">
          <span>Uncertainty method</span>
          <span className="debug-val">BOOTSTRAP (n=100, σ=0.02)</span>
        </div>
      </div>

      <div className="debug-section">
        <div className="debug-section-title">HAZARD WEIGHTS</div>
        {Object.entries(HAZARD_WEIGHTS).map(([key, weight]) => (
          <div key={key} className="debug-row">
            <span>{key}</span>
            <div className="debug-bar-container">
              <div className="debug-bar" style={{ width: `${weight * 100}%` }} />
              <span className="debug-val">{(weight * 100).toFixed(0)}%</span>
            </div>
          </div>
        ))}
      </div>

      <div className="debug-section">
        <div className="debug-section-title">THRESHOLDS</div>
        <div className="debug-row">
          <span>Hazard safe</span>
          <span className="debug-val">{SAFE_THRESHOLD}</span>
        </div>
        <div className="debug-row">
          <span>Slope safe</span>
          <span className="debug-val">{SLOPE_SAFE_DEG}°</span>
        </div>
        <div className="debug-row">
          <span>Min safe radius</span>
          <span className="debug-val">{MIN_SAFE_RADIUS_M}m</span>
        </div>
      </div>

      <div className="debug-section">
        <div className="debug-section-title">TERRAIN META</div>
        <div className="debug-row">
          <span>Source</span>
          <span className="debug-val">{meta.source || '--'}</span>
        </div>
        <div className="debug-row">
          <span>Grid size</span>
          <span className="debug-val">{meta.gridSize || terrain?.size || '--'}</span>
        </div>
        <div className="debug-row">
          <span>World scale</span>
          <span className="debug-val">{meta.worldScale || terrain?.scale || '--'}m</span>
        </div>
        {meta.crs && (
          <div className="debug-row">
            <span>CRS</span>
            <span className="debug-val">{meta.crs}</span>
          </div>
        )}
        {meta.nativeResolutionMPerPx && (
          <div className="debug-row">
            <span>Native res</span>
            <span className="debug-val">{meta.nativeResolutionMPerPx.toFixed(2)}m/px</span>
          </div>
        )}
      </div>

      {inspectedPoint?.metrics && (
        <div className="debug-section">
          <div className="debug-section-title">INSPECTED POINT DECOMPOSITION</div>
          <div className="debug-row">
            <span>Elevation</span>
            <span className="debug-val">{inspectedPoint.metrics.elevation?.toFixed(2)}m</span>
          </div>
          {Object.entries(HAZARD_WEIGHTS).map(([key, weight]) => {
            const rawVal = inspectedPoint.metrics[key] || 0;
            const contribution = rawVal * weight;
            return (
              <div key={key} className="debug-row">
                <span>{key}</span>
                <div className="debug-bar-container">
                  <div className="debug-bar" style={{ width: `${rawVal * 100}%`, background: getContributionColor(contribution) }} />
                  <span className="debug-val">{(rawVal * 100).toFixed(1)}% → {(contribution * 100).toFixed(1)}%</span>
                </div>
              </div>
            );
          })}
          <div className="debug-row">
            <span>Hazard (composite)</span>
            <span className="debug-val accent-warn">{((inspectedPoint.metrics.hazard || 0) * 100).toFixed(1)}%</span>
          </div>
          <div className="debug-row">
            <span>Traversability</span>
            <span className="debug-val accent-good">{((inspectedPoint.metrics.traversability || 0) * 100).toFixed(1)}%</span>
          </div>
        </div>
      )}

      {selectedZone?.uncertainty && (
        <div className="debug-section">
          <div className="debug-section-title">UNCERTAINTY</div>
          <div className="debug-row">
            <span>Score 95% CI</span>
            <span className="debug-val">{selectedZone.uncertainty.scoreCiLower.toFixed(1)} – {selectedZone.uncertainty.scoreCiUpper.toFixed(1)}%</span>
          </div>
          <div className="debug-row">
            <span>Hazard 95% CI</span>
            <span className="debug-val">{(selectedZone.uncertainty.hazardCiLower * 100).toFixed(1)} – {(selectedZone.uncertainty.hazardCiUpper * 100).toFixed(1)}%</span>
          </div>
          <div className="debug-row">
            <span>Trav 95% CI</span>
            <span className="debug-val">{(selectedZone.uncertainty.traversabilityCiLower * 100).toFixed(1)} – {(selectedZone.uncertainty.traversabilityCiUpper * 100).toFixed(1)}%</span>
          </div>
          <div className="debug-row">
            <span>Bootstrap n</span>
            <span className="debug-val">{selectedZone.uncertainty.bootstrapSamples}</span>
          </div>
        </div>
      )}
    </div>
  );
}

function getContributionColor(contribution) {
  if (contribution < 0.05) return '#00ff66';
  if (contribution < 0.15) return '#ffaa00';
  return '#ff3333';
}
