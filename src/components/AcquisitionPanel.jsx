
const STAGES = ['LOCATING DATA', 'READING DEM', 'REPROJECTING/RESAMPLING', 'ANALYSING', 'BUILDING TERRAIN'];

export default function AcquisitionPanel({ acquisition, onCancel, onOpenWorkbench }) {
  if (!acquisition) return null;
  const failed = acquisition.status === 'error';
  return <section className={`acquisition-panel ${failed ? 'failed' : ''}`} aria-label="Terrain acquisition" aria-live="polite">
    <div className="acquisition-heading">
      <span>{failed ? acquisition.code === 'DATA_UNAVAILABLE' ? 'DATA UNAVAILABLE' : 'ACQUISITION FAILED' : 'ORBIT → SURFACE'}</span>
      <button onClick={onCancel} aria-label={failed ? 'Dismiss acquisition' : 'Cancel acquisition'}>×</button>
    </div>
    <div className="acquisition-location">{acquisition.site.body.toUpperCase()} · {acquisition.site.lat.toFixed(4)}° / {acquisition.site.lon.toFixed(4)}° · {(acquisition.site.region_size_m / 1000).toFixed(1)} km</div>
    <ol className="acquisition-stages">
      {STAGES.map(stage => {
        const event = acquisition.steps[stage];
        const done = event?.status === 'completed';
        return <li key={stage} className={done ? 'completed' : event ? 'running' : 'pending'}>
          <span className="acquisition-stage-indicator" aria-hidden="true">{done ? '✓' : event ? '◌' : '·'}</span>
          <span>{stage}</span>
          {done && Number.isFinite(event.elapsed_ms) && <small>{Math.round(event.elapsed_ms)} ms</small>}
        </li>;
      })}
    </ol>
    <p className="acquisition-detail">{acquisition.detail}</p>
    {acquisition.steps['SENTINEL IMAGERY'] && <p className="acquisition-imagery">Sentinel RGB: {acquisition.steps['SENTINEL IMAGERY'].status} · separate from elevation</p>}
    {failed && <button className="hud-action-btn" onClick={onOpenWorkbench}>OPEN WORKSPACE · EXISTING DATA / EXAMPLES</button>}
  </section>;
}
