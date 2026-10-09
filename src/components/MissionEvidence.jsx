import { missionEvidence } from '../engine/missionEvidence';
export default function MissionEvidence({analysis,settings,onSettings,point,route,viewMode}) {
  const evidence=missionEvidence(analysis,settings,point,route);
  const assumed=analysis.metadata?.rehearsalScale;
  const purpose={surface:'Read registered imagery and locate the next inspection.',elevation:'Use DEM elevation to attach entities and sample the planned traverse.',slope:'Compare local grade with your selected rover limit.',roughness:'Screen relief over the analysis window; unmapped rocks remain unknown.',hazard:'Inspect a weighted screening index. It is not a probability of failure.',traversability:'Inverse hazard index; not an independent vehicle mobility prediction.'};
  return <section className="hud-section mission-evidence" aria-label="Mission evidence">
    <div className="hud-section-label">WHAT CAN THIS MAP SUPPORT?</div><p>{purpose[viewMode]||purpose.surface}</p>
    <label className="workspace-field">SMALLEST HAZARD TO RESOLVE · width in m<input aria-label="Critical obstacle width" type="number" min=".05" max="1000" step=".05" value={settings.obstacleWidth??.5} onChange={e=>onSettings(p=>({...p,obstacleWidth:Math.max(.05,Math.min(1000,Number(e.target.value)||.5))}))}/></label>
    <strong className="evidence-decision">{assumed?'ASSUMED SCALE · REHEARSAL ONLY':evidence.decision}</strong>
    <p>{assumed?`${assumed.width} m width · ${assumed.relief} m assumed relief. Real elevations and hidden hazards are unknown.`:evidence.samplesAcrossObstacle===null?'Metric scale unavailable.':`${evidence.criticalObstacleWidthM} m hazard spans ${evidence.samplesAcrossObstacle.toFixed(2)} cells at the coarser source/analysis spacing. The experiment requires 3.`}</p>
    <p className="assumption">{evidence.nextData}</p>
    <p className="assumption">{evidence.gradeExceeded===null?'Grade cannot be cleared: inspect a point; saturated values need an uncapped grade measurement.':`Inspected grade ${evidence.slopeDegreesLowerBound.toFixed(1)}°${point?.metrics?.slope>=1?' or higher':''} · ${evidence.gradeExceeded?'exceeds':'within'} your ${evidence.gradeLimitDegrees}° grade setting. This does not clear unresolved obstacles.`}</p>
    <button className="hud-action-btn" onClick={()=>{const url=URL.createObjectURL(new Blob([JSON.stringify({...evidence,assumedImageScale:assumed||null,exportedAt:new Date().toISOString()},null,2)],{type:'application/json'}));const a=document.createElement('a');a.href=url;a.download='bhuvan-mission-evidence.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}}>EXPORT EVIDENCE & NEXT-DATA REQUEST</button>
    <p className="assumption">{evidence.samplingRule} Missing evidence cannot be converted into a safety probability.</p>
  </section>;
}
