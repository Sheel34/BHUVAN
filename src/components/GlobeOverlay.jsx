import React from 'react';
import { MOON_SITES } from '../lib/moonSites';

/**
 * DOM overlay for the hero Moon globe: title block, site shortcuts,
 * analysis status, and the door into the full analysis workbench.
 */
export default function GlobeOverlay({
  analysisStatus,
  analysisError,
  textureSource,
  onSelectSite,
  onOpenWorkbench,
}) {
  const loading = analysisStatus === 'loading';

  return (
    <div className="globe-overlay">
      <header className="globe-header">
        <div className="globe-badge">
          <span className="badge-dot" />
          PLANETARY TERRAIN INTELLIGENCE
        </div>
        <h1 className="globe-title">BHUVAN</h1>
        <p className="globe-subtitle">
          Quantified terrain assessment for lunar surface operations.
        </p>
      </header>

      <nav className="globe-sites">
        <div className="globe-sites-label">SURVEY TARGETS</div>
        {MOON_SITES.map((site) => (
          <button
            key={site.id}
            className="globe-site-btn"
            disabled={loading}
            onClick={() => onSelectSite(site)}
          >
            <span className="globe-site-btn-name">{site.name}</span>
            <span className="globe-site-btn-coords">
              {site.lat.toFixed(1)}°, {site.lon.toFixed(1)}°
            </span>
          </button>
        ))}
        <button className="globe-workbench-btn" disabled={loading} onClick={onOpenWorkbench}>
          OPEN WORKSPACE →
        </button>
      </nav>

      <footer className="globe-footer">
        {loading ? (
          <div className="globe-status loading">
            <span className="globe-spinner" />
            RUNNING TERRAIN ANALYSIS…
          </div>
        ) : analysisError ? (
          <div className="globe-status error">{analysisError}</div>
        ) : (
          <div className="globe-status hint">
            DRAG TO ROTATE · SELECT A TARGET TO RUN TERRAIN SURVEY
          </div>
        )}
        <div className="globe-source">
          TERRAIN: {textureSource === 'real'
            ? 'LROC WAC MOSAIC + LOLA ELEVATION (NASA)'
            : 'PROCEDURAL PREVIEW — BACKEND OFFLINE'}
        </div>
      </footer>
    </div>
  );
}
