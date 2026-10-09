import { useState, useEffect } from 'react';
import BhuvanMark from './BhuvanMark';
import { LUNAR_MISSIONS } from '../lib/lunarMissions';

// A short, recognisable set surfaced as quick shortcuts; the full set
// lives as markers on the globe.
const FEATURED = ['apollo-11', 'change-4', 'chandrayaan-3', 'luna-17'];

/**
 * DOM overlay for the hero Moon globe: title block, mission shortcuts,
 * analysis status, and the door into the full analysis workbench.
 */
export default function GlobeOverlay({
  analysisStatus,
  body = 'moon',
  navigation,
  location,
  onBack,
  onBodyChange,
  wideArea,onWideArea,gatewayView,onGatewayView,
  regionSizeKm,
  onRegionSizeChange,
  sentinelImagery,
  onSentinelImageryChange,
  analysisError,
  textureSource,
  onSelectMission,
  onOpenWorkbench,
  orbitMotion,onOrbitMotion,clientGpu,orbitModelDays,
}) {
  const [infoOpen, setInfoOpen] = useState(false);
  useEffect(() => {
    const close = () => setInfoOpen(false);
    window.addEventListener('bhuvan-close-panels', close);
    return () => window.removeEventListener('bhuvan-close-panels', close);
  }, []);
  const loading = analysisStatus === 'loading';
  const featured = FEATURED
    .map((id) => LUNAR_MISSIONS.find((m) => m.id === id))
    .filter(Boolean);

  return (
    <div className={`globe-overlay orbit-overlay ${infoOpen ? 'orbit-panel-open' : ''} ${gatewayView?'gateway-inspection':''}`}>
      <header className="globe-header">
        <BhuvanMark />
        <h1 className="globe-title">BHUVAN</h1>
        <p className="globe-subtitle">PLANETARY WORKSPACE</p>
      </header>
      <div className="orbit-motion-controls" role="group" aria-label="Orbital motion">
        <button data-liquid-control="orbit-clock" aria-pressed={orbitMotion.playing} onClick={()=>onOrbitMotion(p=>({...p,playing:!p.playing}))}>{orbitMotion.playing?'PAUSE ORBIT':'PLAY ORBIT'}</button>
        <label>MODEL TIME <select aria-label="Orbital time rate" value={orbitMotion.daysPerSecond} onChange={e=>onOrbitMotion(p=>({...p,daysPerSecond:Number(e.target.value)}))}>
          <option value={1/86400}>Real time</option><option value={.02}>1 day / 50 s</option><option value={.2}>1 day / 5 s</option><option value={1}>1 day / 1 s</option>
        </select></label>
        <span><output aria-label="Elapsed orbital model time">{orbitModelDays.toFixed(2)} model days</output> · axial turn {((orbitModelDays/27.32166*360)%360).toFixed(1)}° · one spin per orbit</span>
      </div>
      {gatewayView && <aside className="gateway-caption"><span className="liquid-eyebrow">LUNAR STATION / MODEL INSPECTION</span><h2>Gateway<br/>Core.</h2><p>Your supplied model · drag to inspect.</p><p className="assumption">Station enlarged for inspection. This is a composed view, not its operational trajectory. Gateway's planned near-rectilinear halo orbit has a period of about 6.5 days; it is not a simple ellipse.</p></aside>}
      <section className="liquid-orbit-hero">
        <span className="liquid-eyebrow">{navigation.level === 'space' ? 'GLOBAL → LOCAL' : `${body.toUpperCase()} / ${navigation.level.toUpperCase()}`}</span>
        <h2>Look closer.<br /><em>There is more beneath.</em></h2>
        <p>Choose a world. Explore its surface.<br />Understand what your map can tell you.</p>
        {navigation.level==='space' && <small className="orbit-model-note">Kepler lunar orbit · e = 0.0549 · accelerated time and compressed distance</small>}
        <div className="globe-body-controls">
          <label className="globe-region-size">REGION <input type="number" min="0.5" max="30" step="0.5"
            aria-label="Region size in kilometres" disabled={loading} value={regionSizeKm}
            onChange={event => onRegionSizeChange(Number(event.target.value))} /> km</label>
          {navigation.level !== 'space' && body === 'earth' && <label className="globe-imagery-option"><input type="checkbox" disabled={loading}
            checked={sentinelImagery} onChange={event => onSentinelImageryChange(event.target.checked)} /> Sentinel RGB (optional)</label>}
        <label className="globe-imagery-option"><input type="checkbox" checked={wideArea} onChange={e=>onWideArea(e.target.checked)}/> Wide-area overview</label></div>
        <nav className="orbit-breadcrumb" aria-label="Spatial navigation">
          {navigation.level !== 'space' && <button onClick={onBack} aria-label="Back one spatial level">← BACK</button>}
          <span>SPACE{navigation.level !== 'space' ? ` / ${body.toUpperCase()}` : ''}{navigation.level === 'region' ? ' / REGION' : ''}</span>
        </nav>
        {navigation.level !== 'space' && body === 'moon' && <details className="liquid-mobile-missions">
          <summary>Mission sites <span>↗</span></summary>
          <div>{featured.map(mission => <button key={mission.id} aria-label={mission.mission} disabled={loading} onClick={event => {
            onSelectMission(mission); event.currentTarget.closest('details').open = false;
          }}>{mission.mission}<span>{mission.country} · {mission.date.slice(0, 4)}</span></button>)}</div>
        </details>}
      </section>

      <nav className="globe-sites">
        {navigation.level !== 'space' && body === 'moon' && <div className="globe-sites-label">MISSIONS</div>}
        {navigation.level !== 'space' && body === 'moon' && featured.map((m) => (
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
        <span className="liquid-mission-note">{navigation.level === 'space' ? 'Click a planet or choose one below to begin.' : body === 'earth' ? 'Click the Earth surface to request a measured DEM for that location.' : 'Select a mission to explore its history and surface data.'}</span>
      </nav>

      {location && navigation.level === 'region' && location.body === body && <div className="orbit-location" aria-live="polite">
        <strong>{body.toUpperCase()} · {location.latitude.toFixed(4)}° / {location.longitude.toFixed(4)}°</strong>
        <span>{location.terrainDataStatus === 'loaded' ? 'MEASURED DEM LOADED' : location.terrainDataStatus === 'unavailable'
          ? 'DATA UNAVAILABLE' : location.terrainDataStatus === 'error' ? 'TERRAIN ACQUISITION FAILED' : 'TERRAIN DATA NOT YET LOADED'}</span>
      </div>}

      <nav className="hud-drawer-controls orbit-context-controls liquid-dock" aria-label="Orbit navigation">
        {['moon', 'earth'].map(value => <button data-liquid-control={value} key={value} disabled={loading}
          aria-pressed={navigation.level !== 'space' && body === value} onClick={() => onBodyChange(value)}>
          <svg viewBox="0 0 24 24" aria-hidden="true">{value === 'moon' ? <path d="M18 16A9 9 0 0 1 8 4a9 9 0 1 0 10 12Z" /> : <><circle cx="12" cy="12" r="9" /><ellipse cx="12" cy="12" rx="4" ry="9" /><path d="M3 12h18" /></>}</svg>
          <span>{value === 'moon' ? 'Explore Moon' : 'Explore Earth'}</span></button>)}
        <button data-liquid-control="workspace" onClick={() => onOpenWorkbench('data')} disabled={loading} aria-label="Open workspace">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m3 8 9-5 9 5-9 5Z M3 12l9 5 9-5 M3 16l9 5 9-5" /></svg><span>Open workspace</span></button>
        <button data-liquid-control="gateway" aria-pressed={gatewayView} onClick={onGatewayView} disabled={loading}><span>{gatewayView?'Exit Gateway':'Gateway'}</span></button>
        <button data-liquid-control="orbit-info" onClick={() => setInfoOpen(value => !value)} aria-expanded={infoOpen} aria-label="About this workspace">
          <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9" /><path d="M12 11v6 M12 7v1" /></svg><span>About</span></button>
      </nav>
      <nav className="liquid-tool-rail orbit-tool-rail" aria-label="Quick navigation">
        <span className="liquid-rail-label">EXPLORE</span>
        <button disabled={navigation.level === 'space'} onClick={onBack}><span>01</span> Back to orbit <b>↗</b></button>
        <button onClick={() => onOpenWorkbench('data')} disabled={loading}><span>02</span> Data library <b>↗</b></button>
        <button onClick={() => onOpenWorkbench('analysis')} disabled={loading}><span>03</span> Analysis workspace <b>↗</b></button>
      </nav>
      {infoOpen && <section className="orbit-info-panel" aria-label="Orbit information">
        <div className="orbit-info-heading"><strong>GLOBAL → LOCAL</strong><button onClick={() => setInfoOpen(false)} aria-label="Close orbit information">×</button></div>
        <p>Click a body to focus it, then click its surface to acquire terrain. Escape moves outward one level.</p>
        <p>Earth and Moon share a visual overview. Spacing and lighting are presentation settings, not an ephemeris. Decorative stars are not an astronomical catalog.</p>
        <p>Global imagery and DEM analysis are separate. A measured patch opens in a local coordinate frame; this is a controlled scene handoff.</p>
        <p>Earth maps: <a href="https://www.solarsystemscope.com/textures/" target="_blank" rel="noreferrer">Solar System Scope / INOVE · CC BY 4.0</a>. Normal/specular maps affect shading only.</p>
      </section>}

      <footer className="globe-footer">
        {loading ? (
          <div className="globe-status loading">
            <span className="globe-spinner" />
            RUNNING PLANETARY TERRAIN SYSTEMS…
          </div>
        ) : analysisError ? (
          <div className="globe-status error">{analysisError}</div>
        ) : (
          <div className="globe-status hint">
            {gatewayView?'GATEWAY INSPECTION · DRAG TO ORBIT THE MODEL':navigation.level === 'space' ? 'DRAG TO ORBIT · CLICK EARTH OR MOON TO FOCUS' : 'DRAG TO ORBIT · CLICK SURFACE TO ACQUIRE DEM · ESC TO BACK OUT'}
          </div>
        )}
        <div className="globe-source">
          GLOBE IMAGERY: {body === 'earth' ? 'NASA BLUE MARBLE · JULY 2004 · PRESENTATION CLOUDS' : textureSource === 'real'
            ? 'LROC / LOLA (NASA)'
            : textureSource === 'bundled' ? 'BUNDLED LUNAR MAP' : 'UNAVAILABLE'}
        </div>
      </footer>
    </div>
  );
}
