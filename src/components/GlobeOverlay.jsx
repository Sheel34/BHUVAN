import React from 'react';
import { LUNAR_MISSIONS } from '../lib/lunarMissions';

// A short, recognisable set surfaced as quick shortcuts; the full set
// lives as markers on the globe.
const FEATURED = ['apollo-11', 'apollo-17', 'change-4', 'chandrayaan-3', 'luna-17'];

/**
 * DOM overlay for the hero Moon globe: title block, mission shortcuts,
 * analysis status, and the door into the full analysis workbench.
 */
export default function GlobeOverlay({
  analysisStatus,
  analysisError,
  textureSource,
  onSelectMission,
  onOpenWorkbench,
}) {
  const loading = analysisStatus === 'loading';
  const featured = FEATURED
    .map((id) => LUNAR_MISSIONS.find((m) => m.id === id))
    .filter(Boolean);

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
        <div className="globe-sites-label">MISSIONS</div>
        {featured.map((m) => (
          <button
            key={m.id}
            className="globe-site-btn"
            disabled={loading}
            onClick={() => onSelectMission(m)}
          >
            <span className="globe-site-btn-name">{m.mission}</span>
            <span className="globe-site-btn-coords">{m.country} · {m.date.slice(0, 4)}</span>
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
            DRAG TO ROTATE · CLICK A MARKER FOR THE MISSION DOSSIER
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
